// Content-addressed block storage node. Mirrors go/internal/storagesrv.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidHash } from "../proto.js";

export interface StorageOptions {
  dataDir: string;
  nodeId?: string;
  logger?: (msg: string) => void;
}

export class StorageServer {
  private dataDir: string;
  private nodeId: string;
  private log: (msg: string) => void;

  constructor(opts: StorageOptions) {
    this.dataDir = opts.dataDir;
    this.nodeId = opts.nodeId ?? "";
    this.log = opts.logger ?? ((m) => console.log(m));
  }

  async init(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
  }

  private blockPath(id: string): string {
    return join(this.dataDir, id.slice(0, 2), id.slice(2));
  }

  createHttpServer(): Server {
    return createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log(`unhandled: ${err}`);
        if (!res.headersSent) res.writeHead(500);
        res.end("internal error");
      });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    if (url === "/healthz") {
      res.writeHead(200);
      res.end("ok\n");
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

  /**
   * Write a block to its content-addressed path, verifying the stream hashes
   * to the path id. Idempotent: an existing block with matching content
   * returns 200 without rewriting; a hash mismatch returns 400 and nothing
   * is persisted.
   */
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
    const { writeFile } = await import("node:fs/promises");
    await writeFile(tmp, Buffer.concat(chunks));
    try {
      await rename(tmp, path);
    } catch {
      // cross-device or race: fall back to copy then unlink
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
    if (await fileExists(path)) {
      res.writeHead(200);
    } else {
      res.writeHead(404);
    }
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
