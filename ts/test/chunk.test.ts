import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildManifest } from "../src/chunk.js";

test("buildManifest round-trips for various sizes", async () => {
  const blockSize = 4 * 1024 * 1024;
  const sizes = [0, 1, 1024, blockSize - 1, blockSize, blockSize + 17, blockSize * 2 + 5];
  const dir = await mkdtemp(join(tmpdir(), "minidss-chunk-"));
  try {
    for (const sz of sizes) {
      const data = randomBytes(sz);
      const p = join(dir, `f-${sz}`);
      await writeFile(p, data);

      const m = await buildManifest(p, "f", blockSize);
      assert.equal(m.size, sz, `size for ${sz}`);
      assert.equal(
        m.sha256,
        createHash("sha256").update(data).digest("hex"),
        `whole-file sha for ${sz}`,
      );

      // reconstruct and verify each block hash + coverage
      let off = 0;
      for (const b of m.blocks) {
        const slice = data.subarray(off, off + b.size);
        assert.equal(
          b.sha256,
          createHash("sha256").update(slice).digest("hex"),
          `block ${b.index} sha for size ${sz}`,
        );
        off += b.size;
      }
      assert.equal(off, sz, `blocks cover all bytes for ${sz}`);

      // expected block count
      const expected = sz === 0 ? 0 : Math.ceil(sz / blockSize);
      assert.equal(m.blocks.length, expected, `block count for ${sz}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
