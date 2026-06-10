// Content-addressed block storage node. Mirrors go/internal/storagesrv.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAuth } from "../auth.js";
import { Logger, withHttpLogging } from "../logger.js";
import { Counter, Gauge, Registry } from "../metrics.js";
import { isValidHash } from "../proto.js";

export interface StorageOptions {
  dataDir: string;
  nodeId?: string;
  token?: string;
  logger?: Logger;
}

interface StorMetrics {
  registry: Registry;
  httpRequests: Counter;
  httpDurationSum: Counter;
  httpDurationCnt: Counter;
  blocksTotal: Gauge;
  bytesTotal: Gauge;
}

function newStorMetrics(): StorMetrics {
  const r = new Registry();
  return {
    registry: r,
    httpRequests: r.newCounter("minidss_http_requests_total", "HTTP requests served"),
    httpDurationSum: r.newCounter(
      "minidss_http_request_duration_ms_sum",
      "Sum of HTTP request durations in ms",
    ),
    httpDurationCnt: r.newCounter(
      "minidss_http_request_duration_ms_count",
      "Count of HTTP requests measured",
    ),
    blocksTotal: r.newGauge("minidss_storage_blocks_total", "Number of blocks stored locally"),
    bytesTotal: r.newGauge("minidss_storage_bytes_total", "Total bytes stored locally"),
  };
}

const OPEN_PATHS: ReadonlySet<string> = new Set(["/healthz"]);

export class StorageServer {
  private dataDir: string;
  private nodeId: string;
  private token: string;
  private log: Logger;
  private metrics: StorMetrics;
  private lastScan = 0;
  private blockCount = 0;
  private byteCount = 0;

  constructor(opts: StorageOptions) {
    this.dataDir = opts.dataDir;
    this.nodeId = opts.nodeId ?? "";
    this.token = opts.token ?? "";
    this.log = opts.logger ?? new Logger("storage");
    this.metrics = newStorMetrics();
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
  }

  private blockPath(id: string): string {
    return join(this.dataDir, id.slice(0, 2), id.slice(2));
  }

  createHttpServer(): Server {
    const wrapped = withHttpLogging(this.log, this.observeHTTP.bind(this), (req, res) =>
      this.dispatch(req, res),
    );
    return createServer((req, res) => {
      wrapped(req, res).catch((err: unknown) => {
        this.log.error("unhandled", { err: String(err) });
        if (!res.headersSent) res.writeHead(500);
        res.end("internal error");
      });
    });
  }

  private observeHTTP(
    method: string,
    _path: string,
    status: number,
    _bytes: number,
    durMs: number,
  ): void {
    const s = String(status);
    this.metrics.httpRequests.inc("method", method, "status", s);
    this.metrics.httpDurationSum.add(durMs, "method", method);
    this.metrics.httpDurationCnt.inc("method", method);
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!checkAuth(req, res, this.token, OPEN_PATHS)) return;
    const url = (req.url ?? "/").split("?")[0] ?? "/";
    if (url === "/healthz") {
      res.writeHead(200);
      res.end("ok\n");
      return;
    }
    if (url === "/metrics") {
      await this.serveMetrics(res);
      return;
    }
    if (!url.startsWith("/blocks/")) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const id = url.slice("/blocks/".length);
    if (!isValidHash(id)) {
      res.writeHead(400);
      res.end("invalid block id");
      return;
    }
    const path = this.blockPath(id);

    switch (req.method) {
      case "PUT":
        await this.put(req, res, path, id);
        return;
      case "GET":
        await this.get(res, path);
        return;
      case "HEAD":
        await this.head(res, path);
        return;
      case "DELETE":
        await this.del(res, path);
        return;
      default:
        res.writeHead(405);
        res.end("method not allowed");
    }
  }

  private async serveMetrics(res: ServerResponse): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    if (now - this.lastScan > 5) {
      await this.refreshDiskUsage();
      this.lastScan = now;
    }
    this.metrics.blocksTotal.set(this.blockCount);
    this.metrics.bytesTotal.set(this.byteCount);
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    res.end(this.metrics.registry.format());
  }

  private async refreshDiskUsage(): Promise<void> {
    let blocks = 0;
    let bytes = 0;
    let prefixes: string[];
    try {
      prefixes = await readdir(this.dataDir);
    } catch {
      this.blockCount = 0;
      this.byteCount = 0;
      return;
    }
    for (const p of prefixes) {
      let files: string[];
      try {
        files = await readdir(join(this.dataDir, p));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const s = await stat(join(this.dataDir, p, f));
          if (s.isFile()) {
            blocks++;
            bytes += s.size;
          }
        } catch {
          /* skip */
        }
      }
    }
    this.blockCount = blocks;
    this.byteCount = bytes;
  }

  private async put(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    id: string,
  ): Promise<void> {
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    try {
      for await (const c of req) {
        const buf = c as Buffer;
        hash.update(buf);
        chunks.push(buf);
      }
    } catch (err) {
      res.writeHead(400);
      res.end(String(err));
      return;
    }
    if (hash.digest("hex") !== id) {
      res.writeHead(400);
      res.end("hash mismatch");
      return;
    }
    const exists = await fileExists(path);
    if (exists) {
      res.writeHead(200);
      res.end();
      return;
    }
    await mkdir(join(path, ".."), { recursive: true });
    const tmp = join(
      tmpdir(),
      `.minidss-${id}-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    await writeFile(tmp, Buffer.concat(chunks));
    try {
      await rename(tmp, path);
    } catch {
      const { copyFile } = await import("node:fs/promises");
      await copyFile(tmp, path);
      await rm(tmp, { force: true });
    }
    res.writeHead(201);
    res.end();
  }

  private async get(res: ServerResponse, path: string): Promise<void> {
    let st;
    try {
      st = await stat(path);
    } catch {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(st.size),
    });
    createReadStream(path).pipe(res);
  }

  private async head(res: ServerResponse, path: string): Promise<void> {
    if (await fileExists(path)) res.writeHead(200);
    else res.writeHead(404);
    res.end();
  }

  private async del(res: ServerResponse, path: string): Promise<void> {
    await rm(path, { force: true });
    res.writeHead(204);
    res.end();
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
