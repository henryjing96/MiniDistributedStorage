// File chunking + hashing. Mirrors go/internal/chunk.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { DEFAULT_BLOCK_SIZE, type BlockInfo, type Manifest } from "./proto.js";

export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Build a Manifest for the file at `path`, splitting into fixed-size blocks.
 * Computes a per-block SHA-256 and a whole-file SHA-256 in a single pass.
 */
export async function buildManifest(
  path: string,
  name: string,
  blockSize: number = DEFAULT_BLOCK_SIZE,
): Promise<Manifest> {
  if (blockSize <= 0) blockSize = DEFAULT_BLOCK_SIZE;

  const info = await stat(path);
  const fileHash = createHash("sha256");
  const blocks: BlockInfo[] = [];

  let index = 0;
  let carry: Buffer = Buffer.alloc(0);

  const emit = (chunk: Buffer): void => {
    fileHash.update(chunk);
    blocks.push({
      index: index++,
      size: chunk.length,
      sha256: createHash("sha256").update(chunk).digest("hex"),
    });
  };

  await new Promise<void>((resolve, reject) => {
    // Read in modest pieces; re-slice into exact blockSize blocks so the
    // manifest is independent of the OS read granularity.
    const stream = createReadStream(path, { highWaterMark: blockSize });
    stream.on("data", (data: string | Buffer) => {
      const piece = typeof data === "string" ? Buffer.from(data) : data;
      carry = carry.length === 0 ? piece : Buffer.concat([carry, piece]);
      while (carry.length >= blockSize) {
        emit(carry.subarray(0, blockSize));
        carry = carry.subarray(blockSize);
      }
    });
    stream.on("end", () => {
      if (carry.length > 0) emit(carry);
      resolve();
    });
    stream.on("error", reject);
  });

  return {
    name,
    size: info.size,
    sha256: fileHash.digest("hex"),
    block_size: blockSize,
    blocks,
  };
}
