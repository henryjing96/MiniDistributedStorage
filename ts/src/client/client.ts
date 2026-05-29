// dssctl client library. Mirrors go/cmd/dssctl.

import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { buildManifest } from "../chunk.js";
import {
  DEFAULT_BLOCK_SIZE,
  type FileEntry,
  type InitResponse,
  type Manifest,
} from "../proto.js";

export class Client {
  constructor(
    private base: string,
    private blockSize: number = DEFAULT_BLOCK_SIZE,
  ) {}

  private url(path: string): string {
    return this.base + path;
  }

  async upload(localPath: string, remoteName: string): Promise<Manifest> {
    const manifest = await buildManifest(localPath, remoteName, this.blockSize);

    const initRes = await fetch(this.url(`/v1/files/${encodeURIComponent(remoteName)}/init`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(manifest),
    });
    if (Math.floor(initRes.status / 100) !== 2) {
      throw new Error(`init: ${initRes.status}: ${await initRes.text()}`);
    }
    const init = (await initRes.json()) as InitResponse;

    if (init.missing.length === 0) {
      console.log("all blocks already present");
    } else {
      console.log(
        `uploading ${init.missing.length}/${manifest.blocks.length} block(s) ` +
          `(${manifest.block_size / (1024 * 1024)} MiB block size)`,
      );
      const need = new Set(init.missing);
      const fh = await open(localPath, "r");
      try {
        for (const b of manifest.blocks) {
          if (!need.has(b.index)) continue;
          const buf = Buffer.alloc(b.size);
          await fh.read(buf, 0, b.size, b.index * manifest.block_size);
          await this.putBlock(remoteName, b.index, buf);
          console.log(`  block ${b.index + 1}/${manifest.blocks.length} uploaded (${b.size} bytes)`);
        }
      } finally {
        await fh.close();
      }
    }

    const commitRes = await fetch(
      this.url(`/v1/files/${encodeURIComponent(remoteName)}/commit`),
      { method: "POST" },
    );
    if (Math.floor(commitRes.status / 100) !== 2) {
      throw new Error(`commit: ${commitRes.status}: ${await commitRes.text()}`);
    }
    console.log(`uploaded ${remoteName} (${manifest.size} bytes, sha256=${manifest.sha256})`);
    return manifest;
  }

  private async putBlock(remoteName: string, idx: number, buf: Buffer): Promise<void> {
    const r = await fetch(
      this.url(`/v1/files/${encodeURIComponent(remoteName)}/blocks/${idx}`),
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: buf,
      },
    );
    if (Math.floor(r.status / 100) !== 2) {
      throw new Error(`block ${idx}: ${r.status}: ${await r.text()}`);
    }
  }

  async download(remoteName: string, localPath: string): Promise<number> {
    const r = await fetch(this.url(`/v1/files/${encodeURIComponent(remoteName)}`));
    if (Math.floor(r.status / 100) !== 2) {
      throw new Error(`get: ${r.status}: ${await r.text()}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    await writeFile(localPath, buf);
    return buf.length;
  }

  /** Download into a buffer (used by tests). */
  async downloadBuffer(remoteName: string): Promise<Buffer> {
    const r = await fetch(this.url(`/v1/files/${encodeURIComponent(remoteName)}`));
    if (Math.floor(r.status / 100) !== 2) {
      throw new Error(`get: ${r.status}: ${await r.text()}`);
    }
    return Buffer.from(await r.arrayBuffer());
  }

  async list(): Promise<FileEntry[]> {
    const r = await fetch(this.url(`/v1/files`));
    if (Math.floor(r.status / 100) !== 2) throw new Error(`ls: ${r.status}`);
    return (await r.json()) as FileEntry[];
  }

  async remove(remoteName: string): Promise<void> {
    const r = await fetch(this.url(`/v1/files/${encodeURIComponent(remoteName)}`), {
      method: "DELETE",
    });
    if (Math.floor(r.status / 100) !== 2) {
      throw new Error(`delete: ${r.status}: ${await r.text()}`);
    }
  }
}

export function sha256HexOf(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}
