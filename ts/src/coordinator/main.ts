import { parseAddr, parseFlags, pick } from "../config.js";
import { MetaStore } from "../metastore.js";
import { CoordinatorServer } from "./server.js";

function splitTrim(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const addr = pick(flags, "addr", "MINIDSS_ADDR", ":9981");
  const dbPath = pick(flags, "db", "MINIDSS_DB", "coordinator.db");
  const nodesStr = pick(
    flags,
    "nodes",
    "MINIDSS_NODES",
    "http://127.0.0.1:9982,http://127.0.0.1:9983,http://127.0.0.1:9984",
  );
  const replicas = Number(pick(flags, "replicas", "MINIDSS_REPLICAS", "1"));

  const nodes = splitTrim(nodesStr);
  if (nodes.length === 0) {
    console.error("no storage nodes configured");
    process.exit(1);
  }

  const store = new MetaStore(dbPath);
  const srv = new CoordinatorServer({ store, storageNodes: nodes, replicas });

  const { host, port } = parseAddr(addr);
  const http = srv.createHttpServer();

  const shutdown = () => {
    console.log("shutting down...");
    http.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  http.listen(port, host, () => {
    console.log(
      `coordinator listening on ${addr} | nodes=${JSON.stringify(nodes)} replicas=${replicas} db=${dbPath}`,
    );
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
