import { loadToken } from "../auth.js";
import { parseAddr, parseFlags, pick } from "../config.js";
import { Logger } from "../logger.js";
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
  const probeIntervalSec = Number(pick(flags, "probe-interval-sec", "MINIDSS_PROBE_INTERVAL_SEC", "5"));
  const probeTimeoutMs = Number(pick(flags, "probe-timeout-ms", "MINIDSS_PROBE_TIMEOUT_MS", "1000"));
  const tokenFile = pick(flags, "token-file", "MINIDSS_TOKEN_FILE", "");
  const tokenInline = flags.get("token") ?? "";

  const nodes = splitTrim(nodesStr);
  if (nodes.length === 0) {
    console.error("no storage nodes configured");
    process.exit(1);
  }

  const token = await loadToken({
    file: tokenFile || undefined,
    inline: tokenInline || undefined,
    envName: "MINIDSS_TOKEN",
  });

  const store = new MetaStore(dbPath);
  const log = new Logger("coordinator");
  const srv = new CoordinatorServer({
    store,
    storageNodes: nodes,
    replicas,
    token,
    probeIntervalMs: probeIntervalSec * 1000,
    probeTimeoutMs,
    logger: log,
  });
  srv.start();

  const { host, port } = parseAddr(addr);
  const http = srv.createHttpServer();

  const shutdown = (): void => {
    log.info("shutdown_start");
    srv.stop();
    http.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  http.listen(port, host, () => {
    log.info("listening", {
      addr,
      nodes,
      replicas,
      db: dbPath,
      auth_enabled: token !== "",
      probe_interval_sec: probeIntervalSec,
    });
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
