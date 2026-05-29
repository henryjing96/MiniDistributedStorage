// In-process test cluster: N storage nodes + 1 coordinator on ephemeral ports.

import type { Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoordinatorServer } from "../src/coordinator/server.js";
import { MetaStore } from "../src/metastore.js";
import { StorageServer } from "../src/storage/server.js";

export interface Cluster {
  coordUrl: string;
  nodeUrls: string[];
  store: MetaStore;
  tmpRoot: string;
  /** Stop a storage node (simulate crash). Keeps its data + port. */
  stopStorage: (i: number) => Promise<void>;
  /** Restart a previously stopped storage node on its original port. */
  startStorage: (i: number) => Promise<void>;
  shutdown: () => Promise<void>;
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

export async function startCluster(opts: {
  nodes: number;
  replicas: number;
}): Promise<Cluster> {
  const tmpRoot = await mkdtemp(join(tmpdir(), "minidss-e2e-"));
  const dataDirs: string[] = [];
  const ports: number[] = [];
  const servers: (Server | null)[] = [];

  const boot = async (i: number): Promise<void> => {
    const srv = new StorageServer({
      dataDir: dataDirs[i]!,
      nodeId: `node-${i}`,
      logger: () => {},
    });
    await srv.init();
    const http = srv.createHttpServer();
    // ports[i] is 0 on first boot (ephemeral) or the captured port on restart
    const assigned = await listen(http, ports[i] ?? 0);
    ports[i] = assigned;
    servers[i] = http;
  };

  for (let i = 0; i < opts.nodes; i++) {
    dataDirs.push(join(tmpRoot, `stor${i}`));
    ports.push(0);
    servers.push(null);
    await boot(i);
  }

  const nodeUrls = ports.map((p) => `http://127.0.0.1:${p}`);

  const store = new MetaStore(join(tmpRoot, "coordinator.db"));
  const coord = new CoordinatorServer({
    store,
    storageNodes: nodeUrls,
    replicas: opts.replicas,
    logger: () => {},
  });
  const coordHttp = coord.createHttpServer();
  const coordPort = await listen(coordHttp, 0);
  const coordUrl = `http://127.0.0.1:${coordPort}`;

  const stopStorage = async (i: number): Promise<void> => {
    const s = servers[i];
    if (!s) return;
    await closeServer(s);
    servers[i] = null;
  };

  const startStorage = async (i: number): Promise<void> => {
    if (servers[i]) return;
    await boot(i);
  };

  const shutdown = async (): Promise<void> => {
    await closeServer(coordHttp);
    store.close();
    for (let i = 0; i < servers.length; i++) {
      const s = servers[i];
      if (s) await closeServer(s);
    }
    await rm(tmpRoot, { recursive: true, force: true });
  };

  return { coordUrl, nodeUrls, store, tmpRoot, stopStorage, startStorage, shutdown };
}
