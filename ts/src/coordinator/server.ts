// Coordinator: metadata + routing + replication. Mirrors go/internal/coordinator.

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  ConflictError,
  MetaStore,
  NotFoundError,
  type BlockRow,
} from "../metastore.js";
import {
  HASH_HEX_LEN,
  isValidName,
  type CommitResponse,
  type FileEntry,
  type InitResponse,
  type Manifest,
} from "../proto.js";

export interface CoordinatorOptions {
  store: MetaStore;
  storageNodes: string[];
  replicas: number;
  logger?: (msg: string) => void;
}

export class CoordinatorServer {
  private store: MetaStore;
  private nodes: string[];
  private replicas: number;
  private log: (msg: string) => void;

  constructor(opts: CoordinatorOptions) {
    if (opts.storageNodes.length === 0) {
      throw new Error("no storage nodes configured");
    }
    this.replicas = opts.replicas <= 0 ? 1 : opts.replicas;
    if (this.replicas > opts.storageNodes.length) {
      throw new Error(
        `replicas ${this.replicas} > storage nodes ${opts.storageNodes.length}`,
      );
    }
    this.store = opts.store;
    this.nodes = opts.storageNodes;
    this.log = opts.logger ?? ((m) => console.log(m));
  }

  /**
   * Deterministic ordered node list for a block hash via rendezvous (HRW)
   * hashing. The first `replicas` entries are the canonical replicas; the
   * rest are read fall-backs.
   */
  pickNodes(blockSha: string): string[] {
    const scored = this.nodes.map((node) => {
      const sum = createHash("sha256")
        .update(blockSha)
        .update(Buffer.from([0]))
        .update(node)
        .digest();
      // top 8 bytes as an unsigned score
      const score = sum.readBigUInt64BE(0);
      return { node, score };
    });
    scored.sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : 0));
    return scored.map((s) => s.node);
  }

  createHttpServer(): Server {
    return createServer((req, res) => {
      this.route(req, res).catch((err) => {
        this.log(`unhandled: ${err}`);
        if (!res.headersSent) res.writeHead(500);
        res.end("internal error");
      });
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://internal");
    const path = url.pathname;

    if (path === "/healthz") {
      res.writeHead(200);
      res.end("ok\n");
      return;
    }
    if (path === "/v1/files") {
      if (req.method !== "GET") return methodNotAllowed(res);
      this.listFiles(res);
      return;
    }
    if (path.startsWith("/v1/files/")) {
      await this.routeFile(req, res, path.slice("/v1/files/".length));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  }

  private async routeFile(
    req: IncomingMessage,
    res: ServerResponse,
    rest: string,
  ): Promise<void> {
    if (rest === "") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const parts = rest.split("/");
    const rawName = parts[0]!;
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      res.writeHead(400);
      res.end("bad name");
      return;
    }
    if (!isValidName(name)) {
      res.writeHead(400);
      res.end("invalid filename");
      return;
    }

    if (parts.length === 1) {
      if (req.method === "GET") return this.download(req, res, name);
      if (req.method === "DELETE") return this.deleteFile(res, name);
      return methodNotAllowed(res);
    }

    const sub = parts[1]!;
    switch (sub) {
      case "init":
        if (req.method !== "POST") return methodNotAllowed(res);
        return this.initUpload(req, res, name);
      case "commit":
        if (req.method !== "POST") return methodNotAllowed(res);
        return this.commit(res, name);
      case "manifest":
        if (req.method !== "GET") return methodNotAllowed(res);
        return this.manifest(res, name);
      case "blocks": {
        if (parts.length < 3) {
          res.writeHead(400);
          res.end("missing block index");
          return;
        }
        const idx = Number(parts[2]);
        if (!Number.isInteger(idx) || idx < 0) {
          res.writeHead(400);
          res.end("bad index");
          return;
        }
        if (req.method === "PUT") return this.uploadBlock(req, res, name, idx);
        if (req.method === "GET") return this.downloadBlock(req, res, name, idx);
        return methodNotAllowed(res);
      }
      default:
        res.writeHead(404);
        res.end("not found");
    }
  }

  private listFiles(res: ServerResponse): void {
    const out: FileEntry[] = this.store.listFiles().map((f) => ({
      name: f.name,
      size: f.size,
      sha256: f.sha256,
      state: f.state,
      updated_at: f.updated_at,
    }));
    writeJson(res, 200, out);
  }

  private async initUpload(
    req: IncomingMessage,
    res: ServerResponse,
    name: string,
  ): Promise<void> {
    let m: Manifest;
    try {
      m = JSON.parse(await readBody(req)) as Manifest;
    } catch (err) {
      res.writeHead(400);
      res.end("bad manifest: " + String(err));
      return;
    }
    if (
      typeof m.block_size !== "number" ||
      m.block_size <= 0 ||
      typeof m.size !== "number" ||
      m.size < 0 ||
      typeof m.sha256 !== "string" ||
      m.sha256.length !== HASH_HEX_LEN ||
      !Array.isArray(m.blocks)
    ) {
      res.writeHead(400);
      res.end("invalid manifest");
      return;
    }

    const rows = [];
    for (const b of m.blocks) {
      if (typeof b.sha256 !== "string" || b.sha256.length !== HASH_HEX_LEN || b.size <= 0) {
        res.writeHead(400);
        res.end("invalid block info");
        return;
      }
      const replicas = this.pickNodes(b.sha256).slice(0, this.replicas);
      rows.push({ idx: b.index, sha256: b.sha256, size: b.size, storage_nodes: replicas });
    }

    let file;
    try {
      file = this.store.createOrResume(name, m.size, m.sha256, m.block_size, rows);
    } catch (err) {
      if (err instanceof ConflictError) {
        res.writeHead(409);
        res.end(err.message);
        return;
      }
      throw err;
    }
    const resp: InitResponse = { missing: this.store.missingBlocks(file.id) };
    writeJson(res, 200, resp);
  }

  private async uploadBlock(
    req: IncomingMessage,
    res: ServerResponse,
    name: string,
    idx: number,
  ): Promise<void> {
    const file = this.store.getFile(name);
    if (!file) {
      res.writeHead(404);
      res.end("not initialized");
      return;
    }
    const block = this.store.getBlock(file.id, idx);
    if (!block) {
      res.writeHead(404);
      res.end("block not registered");
      return;
    }
    if (block.uploaded) {
      // drain and ack
      for await (const _ of req) {
        /* discard */
      }
      res.writeHead(200);
      res.end();
      return;
    }

    const body = await readBodyBuffer(req);
    if (body.length !== block.size) {
      res.writeHead(400);
      res.end(`block size mismatch: got ${body.length}, want ${block.size}`);
      return;
    }
    const got = createHash("sha256").update(body).digest("hex");
    if (got !== block.sha256) {
      res.writeHead(400);
      res.end("block hash mismatch");
      return;
    }

    const { successes, lastErr } = await this.fanoutPut(block.storage_nodes, block.sha256, body);
    if (successes === 0) {
      res.writeHead(502);
      res.end("all replicas failed: " + String(lastErr));
      return;
    }
    if (successes < block.storage_nodes.length) {
      this.log(
        `block ${block.sha256}: only ${successes}/${block.storage_nodes.length} replicas accepted`,
      );
    }
    this.store.markUploaded(file.id, idx);
    res.writeHead(200);
    res.end();
  }

  private async fanoutPut(
    nodes: string[],
    blockSha: string,
    body: Buffer,
  ): Promise<{ successes: number; lastErr: unknown }> {
    let successes = 0;
    let lastErr: unknown = null;
    for (const node of nodes) {
      try {
        const r = await fetch(`${node}/blocks/${blockSha}`, {
          method: "PUT",
          body,
          headers: { "Content-Type": "application/octet-stream" },
        });
        if (Math.floor(r.status / 100) !== 2) {
          lastErr = `${node}: ${r.status}`;
          continue;
        }
        successes++;
      } catch (err) {
        lastErr = err;
      }
    }
    return { successes, lastErr };
  }

  private async downloadBlock(
    _req: IncomingMessage,
    res: ServerResponse,
    name: string,
    idx: number,
  ): Promise<void> {
    const file = this.store.getFile(name);
    if (!file) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const block = this.store.getBlock(file.id, idx);
    if (!block || !block.uploaded) {
      res.writeHead(404);
      res.end("block not available");
      return;
    }
    const buf = await this.fetchBlock(block);
    if (!buf) {
      res.writeHead(502);
      res.end("block unavailable on all replicas");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(buf);
  }

  /** Fetch a block, trying replicas first, then any other node as fallback. */
  private async fetchBlock(block: BlockRow): Promise<Buffer | null> {
    const tried = new Set<string>();
    const candidates = [...block.storage_nodes];
    for (const n of this.pickNodes(block.sha256)) {
      if (!candidates.includes(n)) candidates.push(n);
    }
    for (const node of candidates) {
      if (tried.has(node)) continue;
      tried.add(node);
      try {
        const r = await fetch(`${node}/blocks/${block.sha256}`);
        if (r.status !== 200) continue;
        return Buffer.from(await r.arrayBuffer());
      } catch {
        /* try next */
      }
    }
    return null;
  }

  private commit(res: ServerResponse, name: string): void {
    const file = this.store.getFile(name);
    if (!file) {
      res.writeHead(404);
      res.end("not initialized");
      return;
    }
    try {
      this.store.markComplete(file.id);
    } catch (err) {
      res.writeHead(400);
      res.end(String(err instanceof Error ? err.message : err));
      return;
    }
    const resp: CommitResponse = { ok: true };
    writeJson(res, 200, resp);
  }

  private manifest(res: ServerResponse, name: string): void {
    const file = this.store.getFile(name);
    if (!file) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const blocks = this.store.listBlocks(file.id);
    const out: Manifest = {
      name: file.name,
      size: file.size,
      sha256: file.sha256,
      block_size: file.block_size,
      blocks: blocks.map((b) => ({ index: b.idx, size: b.size, sha256: b.sha256 })),
    };
    writeJson(res, 200, out);
  }

  private async download(
    _req: IncomingMessage,
    res: ServerResponse,
    name: string,
  ): Promise<void> {
    const file = this.store.getFile(name);
    if (!file) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    if (file.state !== "complete") {
      res.writeHead(409);
      res.end("incomplete file");
      return;
    }
    const blocks = this.store.listBlocks(file.id);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(file.size),
    });
    for (const b of blocks) {
      const buf = await this.fetchBlock(b);
      if (!buf) {
        this.log(`download ${name}: block ${b.idx} unavailable`);
        res.destroy();
        return;
      }
      if (!res.write(buf)) {
        await new Promise<void>((resolve) => res.once("drain", resolve));
      }
    }
    res.end();
  }

  private async deleteFile(res: ServerResponse, name: string): Promise<void> {
    const file = this.store.getFile(name);
    if (!file) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const blocks = this.store.listBlocks(file.id);
    for (const b of blocks) {
      for (const node of b.storage_nodes) {
        try {
          await fetch(`${node}/blocks/${b.sha256}`, { method: "DELETE" });
        } catch {
          /* best effort */
        }
      }
    }
    try {
      this.store.delete(file.name);
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      throw err;
    }
    res.writeHead(204);
    res.end();
  }
}

function methodNotAllowed(res: ServerResponse): void {
  res.writeHead(405);
  res.end("method not allowed");
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  return (await readBodyBuffer(req)).toString("utf8");
}

async function readBodyBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
