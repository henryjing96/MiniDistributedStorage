import { parseAddr, parseFlags, pick } from "../config.js";
import { StorageServer } from "./server.js";

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const addr = pick(flags, "addr", "MINIDSS_ADDR", ":9982");
  const dataDir = pick(flags, "data", "MINIDSS_DATA", "data");
  const nodeId = pick(flags, "id", "MINIDSS_NODE_ID", "");

  const srv = new StorageServer({ dataDir, nodeId });
  await srv.init();

  const { host, port } = parseAddr(addr);
  const http = srv.createHttpServer();

  const shutdown = () => {
    console.log("shutting down...");
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  http.listen(port, host, () => {
    console.log(`storage listening on ${addr} | data=${dataDir} id=${nodeId}`);
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
