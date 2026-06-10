// Tests for the ops feature pack: auth, metrics, structured logs, health probe.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Client } from "../src/client/client.js";
import { startCluster } from "./cluster.js";

const TOKEN = "test-secret-token-abc";

test("auth: requests without token are rejected, /healthz remains open", async () => {
  const c = await startCluster({ nodes: 3, replicas: 1, token: TOKEN });
  try {
    // no header
    let r = await fetch(`${c.coordUrl}/v1/files`);
    assert.equal(r.status, 401);
    // wrong scheme
    r = await fetch(`${c.coordUrl}/v1/files`, { headers: { Authorization: "Token nope" } });
    assert.equal(r.status, 401);
    // wrong token
    r = await fetch(`${c.coordUrl}/v1/files`, { headers: { Authorization: "Bearer nope" } });
    assert.equal(r.status, 401);
    // correct token
    r = await fetch(`${c.coordUrl}/v1/files`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200);
    // /healthz remains open
    r = await fetch(`${c.coordUrl}/healthz`);
    assert.equal(r.status, 200);
    // /metrics requires token
    r = await fetch(`${c.coordUrl}/metrics`);
    assert.equal(r.status, 401);
    r = await fetch(`${c.coordUrl}/metrics`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(r.status, 200);

    // storage node also requires token
    const sNode = c.nodeUrls[0]!;
    r = await fetch(`${sNode}/blocks/${"a".repeat(64)}`);
    assert.equal(r.status, 401);
  } finally {
    await c.shutdown();
  }
});

test("auth: client with token round-trips through coord+storage", async () => {
  const c = await startCluster({ nodes: 3, replicas: 2, token: TOKEN });
  try {
    const data = randomBytes(2 * 1024 * 1024 + 17);
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "auth-up-"));
    const src = path.join(tmp, "src.bin");
    await fs.writeFile(src, data);

    const client = new Client(c.coordUrl, 1024 * 1024, TOKEN);
    await client.upload(src, "auth.bin");
    const got = await client.downloadBuffer("auth.bin");
    assert.equal(got.length, data.length);
    assert.equal(got.compare(data), 0);

    // a client without the token must fail
    const anon = new Client(c.coordUrl, 1024 * 1024, "");
    await assert.rejects(anon.list());
    await fs.rm(tmp, { recursive: true, force: true });
  } finally {
    await c.shutdown();
  }
});

test("metrics: /metrics returns Prometheus text format with expected series", async () => {
  const c = await startCluster({ nodes: 3, replicas: 2 });
  try {
    const client = new Client(c.coordUrl, 1024 * 1024);
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "metrics-"));
    const src = path.join(tmp, "src.bin");
    await fs.writeFile(src, randomBytes(2 * 1024 * 1024));
    await client.upload(src, "metric-test.bin");

    const r = await fetch(`${c.coordUrl}/metrics`);
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /^# TYPE minidss_http_requests_total counter$/m);
    assert.match(body, /minidss_http_requests_total\{method="POST",route="\/v1\/files\/:name\/init",status="200"\} 1/);
    assert.match(body, /minidss_http_requests_total\{method="PUT",route="\/v1\/files\/:name\/blocks\/:idx",status="200"\} 2/);
    assert.match(body, /^# TYPE minidss_storage_node_up gauge$/m);
    assert.match(body, /minidss_replica_writes_total\{outcome="success"\} \d+/);
    assert.match(body, /^# TYPE minidss_files_total gauge$/m);
    assert.match(body, /minidss_files_total\{state="complete"\} 1/);

    // storage node /metrics
    const sr = await fetch(`${c.nodeUrls[0]}/metrics`);
    assert.equal(sr.status, 200);
    const sb = await sr.text();
    assert.match(sb, /^# TYPE minidss_storage_blocks_total gauge$/m);
    assert.match(sb, /^# TYPE minidss_storage_bytes_total gauge$/m);

    await fs.rm(tmp, { recursive: true, force: true });
  } finally {
    await c.shutdown();
  }
});

test("structured logging: X-Request-Id echoed back; custom ID propagated", async () => {
  const c = await startCluster({ nodes: 3, replicas: 1 });
  try {
    // server generates one when client omits
    let r = await fetch(`${c.coordUrl}/v1/files`);
    const generated = r.headers.get("x-request-id");
    assert.ok(generated && /^[0-9a-f]{16}$/.test(generated), `got ${generated}`);

    // server echoes when client provides
    const id = "00112233aabbccdd";
    r = await fetch(`${c.coordUrl}/v1/files`, { headers: { "x-request-id": id } });
    assert.equal(r.headers.get("x-request-id"), id);
  } finally {
    await c.shutdown();
  }
});

test("health probe: down node is detected and metrics flip; writes still succeed", async () => {
  const c = await startCluster({
    nodes: 3,
    replicas: 2,
    probeIntervalMs: 200,
  });
  try {
    // kill node 0 BEFORE the upload so placement picks healthy nodes only
    await c.stopStorage(0);
    // give the probe a couple ticks to mark it down
    await new Promise((r) => setTimeout(r, 600));

    // verify gauge dropped to 0 for the killed node
    const mres = await fetch(`${c.coordUrl}/metrics`);
    const body = await mres.text();
    const killedNode = c.nodeUrls[0]!;
    const re = new RegExp(
      `minidss_storage_node_up\\{node="${killedNode.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}"\\} 0`,
      "m",
    );
    assert.match(body, re);

    // upload should still succeed, routed to the two healthy nodes
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "probe-"));
    const src = path.join(tmp, "src.bin");
    const data = randomBytes(1024 * 1024 + 5);
    await fs.writeFile(src, data);
    const client = new Client(c.coordUrl, 1024 * 1024);
    await client.upload(src, "probe.bin");
    const got = await client.downloadBuffer("probe.bin");
    assert.equal(got.compare(data), 0);
    await fs.rm(tmp, { recursive: true, force: true });
  } finally {
    await c.shutdown();
  }
});
