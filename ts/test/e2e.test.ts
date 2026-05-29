import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "../src/client/client.js";
import type { Manifest } from "../src/proto.js";
import { startCluster, type Cluster } from "./cluster.js";

const BLOCK = 1 * 1024 * 1024; // 1 MiB blocks for fast tests

function sha(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function tmpFile(bytes: number): Promise<{ path: string; data: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), "minidss-src-"));
  const path = join(dir, "src.bin");
  const data = randomBytes(bytes);
  await writeFile(path, data);
  return { path, data };
}

async function countBlocks(dataDir: string): Promise<number> {
  let total = 0;
  let prefixes: string[];
  try {
    prefixes = await readdir(dataDir);
  } catch {
    return 0;
  }
  for (const p of prefixes) {
    try {
      const files = await readdir(join(dataDir, p));
      total += files.length;
    } catch {
      /* not a dir */
    }
  }
  return total;
}

// --- AC1: round-trip of a real multi-block file (replicas=2) -----------------
test("AC1: upload/download round-trip preserves sha256", async () => {
  const c = await startCluster({ nodes: 3, replicas: 2 });
  try {
    const client = new Client(c.coordUrl, BLOCK);
    const { path, data } = await tmpFile(5 * 1024 * 1024 + 123); // 6 blocks (last partial)
    const m = await client.upload(path, "round.bin");
    assert.equal(m.sha256, sha(data));
    const got = await client.downloadBuffer("round.bin");
    assert.equal(got.length, data.length);
    assert.equal(sha(got), sha(data));
  } finally {
    await c.shutdown();
  }
});

// --- AC1b: zero-byte file ----------------------------------------------------
test("AC1b: zero-byte file round-trips", async () => {
  const c = await startCluster({ nodes: 3, replicas: 1 });
  try {
    const client = new Client(c.coordUrl, BLOCK);
    const { path, data } = await tmpFile(0);
    await client.upload(path, "empty.bin");
    const got = await client.downloadBuffer("empty.bin");
    assert.equal(got.length, 0);
    assert.equal(sha(got), sha(data));
  } finally {
    await c.shutdown();
  }
});

// --- AC2: re-upload of identical file returns no missing blocks --------------
test("AC2: re-upload (dedup/resume) reports all blocks present", async () => {
  const c = await startCluster({ nodes: 3, replicas: 2 });
  try {
    const client = new Client(c.coordUrl, BLOCK);
    const { path } = await tmpFile(3 * 1024 * 1024);
    await client.upload(path, "dup.bin");
    // Drive init directly to inspect the missing list on the second attempt.
    const m = await buildManifestViaUpload(client, path, "dup.bin");
    const initRes = await fetch(`${c.coordUrl}/v1/files/dup.bin/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(m),
    });
    assert.equal(initRes.status, 200);
    const init = (await initRes.json()) as { missing: number[] };
    assert.deepEqual(init.missing, []);
  } finally {
    await c.shutdown();
  }
});

// --- AC3/AC4/AC5: resumable upload, early commit, name conflict --------------
test("AC3+AC4+AC5: resume missing blocks, early commit 400, conflict 409", async () => {
  const c = await startCluster({ nodes: 3, replicas: 2 });
  try {
    const data = randomBytes(7 * BLOCK); // 7 full blocks
    const manifest = makeManifest("resume.bin", data, BLOCK);
    const base = `${c.coordUrl}/v1/files/resume.bin`;

    // init1 -> all missing
    let r = await postJson(`${base}/init`, manifest);
    assert.equal(r.status, 200);
    assert.deepEqual(((await r.json()) as { missing: number[] }).missing, [0, 1, 2, 3, 4, 5, 6]);

    // upload first 3 blocks
    for (const idx of [0, 1, 2]) {
      const put = await fetch(`${base}/blocks/${idx}`, {
        method: "PUT",
        body: data.subarray(idx * BLOCK, (idx + 1) * BLOCK),
      });
      assert.equal(put.status, 200, `put block ${idx}`);
    }

    // AC4: early commit rejected
    r = await fetch(`${base}/commit`, { method: "POST" });
    assert.equal(r.status, 400);

    // AC3: re-init returns only the remaining blocks
    r = await postJson(`${base}/init`, manifest);
    assert.equal(r.status, 200);
    assert.deepEqual(((await r.json()) as { missing: number[] }).missing, [3, 4, 5, 6]);

    // AC5: re-init with different content -> 409
    const bad = makeManifest("resume.bin", randomBytes(7 * BLOCK), BLOCK);
    r = await postJson(`${base}/init`, bad);
    assert.equal(r.status, 409);

    // finish remaining blocks + commit
    for (const idx of [3, 4, 5, 6]) {
      const put = await fetch(`${base}/blocks/${idx}`, {
        method: "PUT",
        body: data.subarray(idx * BLOCK, (idx + 1) * BLOCK),
      });
      assert.equal(put.status, 200, `put block ${idx}`);
    }
    r = await fetch(`${base}/commit`, { method: "POST" });
    assert.equal(r.status, 200);

    const got = await new Client(c.coordUrl).downloadBuffer("resume.bin");
    assert.equal(sha(got), sha(data));
  } finally {
    await c.shutdown();
  }
});

// --- AC6: hash-mismatch defenses --------------------------------------------
test("AC6: storage + coordinator reject hash mismatches", async () => {
  const c = await startCluster({ nodes: 3, replicas: 2 });
  try {
    // (a) storage rejects PUT where body != path id
    const node = c.nodeUrls[0]!;
    const fakeId = "f".repeat(64);
    let r = await fetch(`${node}/blocks/${fakeId}`, { method: "PUT", body: "hello" });
    assert.equal(r.status, 400);

    // (b) storage accepts correct id, then GET returns it
    const real = sha(Buffer.from("hello world"));
    r = await fetch(`${node}/blocks/${real}`, { method: "PUT", body: "hello world" });
    assert.equal(r.status, 201);
    r = await fetch(`${node}/blocks/${real}`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "hello world");

    // (c) invalid id format -> 400
    r = await fetch(`${node}/blocks/notahash`, { method: "PUT", body: "x" });
    assert.equal(r.status, 400);

    // (d) GET missing block -> 404
    r = await fetch(`${node}/blocks/${"a".repeat(64)}`);
    assert.equal(r.status, 404);

    // (e) coordinator rejects a block whose bytes don't match the manifest sha
    const data = randomBytes(BLOCK);
    const manifest = makeManifest("poison.bin", data, BLOCK);
    manifest.blocks[0]!.sha256 = "0".repeat(64); // lie about the block hash
    await postJson(`${c.coordUrl}/v1/files/poison.bin/init`, manifest);
    r = await fetch(`${c.coordUrl}/v1/files/poison.bin/blocks/0`, {
      method: "PUT",
      body: data,
    });
    assert.equal(r.status, 400);
  } finally {
    await c.shutdown();
  }
});

// --- AC7: invalid index / missing file --------------------------------------
test("AC7: bad index and unknown file handled", async () => {
  const c = await startCluster({ nodes: 3, replicas: 1 });
  try {
    // upload to a non-initialized file -> 404
    let r = await fetch(`${c.coordUrl}/v1/files/ghost.bin/blocks/0`, {
      method: "PUT",
      body: "x",
    });
    assert.equal(r.status, 404);

    // bad index
    r = await fetch(`${c.coordUrl}/v1/files/ghost.bin/blocks/-1`, { method: "PUT", body: "x" });
    assert.equal(r.status, 400);

    // download missing file
    r = await fetch(`${c.coordUrl}/v1/files/ghost.bin`);
    assert.equal(r.status, 404);

    // path traversal name rejected
    r = await fetch(`${c.coordUrl}/v1/files/${encodeURIComponent("../etc/passwd")}/init`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(r.status, 400);
  } finally {
    await c.shutdown();
  }
});

// --- AC8: replica failover (replicas=2 tolerates 1 node down) ----------------
test("AC8: download survives one downed node (replicas=2)", async () => {
  const c = await startCluster({ nodes: 3, replicas: 2 });
  try {
    const client = new Client(c.coordUrl, BLOCK);
    const { path, data } = await tmpFile(6 * BLOCK);
    await client.upload(path, "ha.bin");

    // kill each node in turn, verify download still works each time
    for (let i = 0; i < 3; i++) {
      await c.stopStorage(i);
      const got = await client.downloadBuffer("ha.bin");
      assert.equal(sha(got), sha(data), `download with node ${i} down`);
      await c.startStorage(i);
    }
  } finally {
    await c.shutdown();
  }
});

// --- AC8b: replicas=3 tolerates 2 nodes down, fails when all are down ---------
test("AC8b: replicas=3 survives 2 downed nodes; fails when all down", async () => {
  const c = await startCluster({ nodes: 3, replicas: 3 });
  try {
    const client = new Client(c.coordUrl, BLOCK);
    const { path, data } = await tmpFile(8 * BLOCK);
    await client.upload(path, "triple.bin");

    // every node holds every block -> any 2 may fail
    await c.stopStorage(0);
    await c.stopStorage(1);
    const got = await client.downloadBuffer("triple.bin");
    assert.equal(sha(got), sha(data), "download with 2 of 3 nodes down");

    // all three down -> download must fail
    await c.stopStorage(2);
    await assert.rejects(client.downloadBuffer("triple.bin"));

    await c.startStorage(0);
    await c.startStorage(1);
    await c.startStorage(2);
  } finally {
    await c.shutdown();
  }
});

// --- AC9: ls + rm + block cleanup -------------------------------------------
test("AC9: ls lists files, rm deletes file and blocks", async () => {
  const c = await startCluster({ nodes: 3, replicas: 2 });
  try {
    const client = new Client(c.coordUrl, BLOCK);
    const { path } = await tmpFile(4 * BLOCK);
    await client.upload(path, "del.bin");

    let files = await client.list();
    assert.equal(files.length, 1);
    assert.equal(files[0]!.name, "del.bin");
    assert.equal(files[0]!.state, "complete");

    const before = await totalBlocks(c);
    assert.ok(before > 0, "blocks present before rm");

    await client.remove("del.bin");
    files = await client.list();
    assert.equal(files.length, 0);

    const afterCount = await totalBlocks(c);
    assert.equal(afterCount, 0, "all blocks removed after rm");
  } finally {
    await c.shutdown();
  }
});

// --- helpers ----------------------------------------------------------------

function makeManifest(name: string, data: Buffer, blockSize: number): Manifest {
  const blocks = [];
  for (let i = 0; i < data.length; i += blockSize) {
    const chunk = data.subarray(i, i + blockSize);
    blocks.push({ index: i / blockSize, size: chunk.length, sha256: sha(chunk) });
  }
  return { name, size: data.length, sha256: sha(data), block_size: blockSize, blocks };
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function buildManifestViaUpload(
  client: Client,
  path: string,
  name: string,
): Promise<Manifest> {
  // reuse the client's own chunker by importing buildManifest indirectly
  const { buildManifest } = await import("../src/chunk.js");
  return buildManifest(path, name, BLOCK);
}

async function totalBlocks(c: Cluster): Promise<number> {
  let n = 0;
  for (let i = 0; i < c.nodeUrls.length; i++) {
    n += await countBlocks(join(c.tmpRoot, `stor${i}`));
  }
  return n;
}
