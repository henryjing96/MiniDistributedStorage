import { loadToken } from "../auth.js";
import { parseAddr, parseFlags, pick } from "../config.js";
import { Logger } from "../logger.js";
import { StorageServer } from "./server.js";

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const addr = pick(flags, "addr", "MINIDSS_ADDR", ":9982");
  const dataDir = pick(flags, "data", "MINIDSS_DATA", "data");
  const nodeId = pick(flags, "id", "MINIDSS_NODE_ID", "");
  const tokenFile = pick(flags, "token-file", "MINIDSS_TOKEN_FILE", "");
  const tokenInline = flags.get("token") ?? "";

  const token = await loadToken({
    file: tokenFile || undefined,
    inline: tokenInline || undefined,
    envName: "MINIDSS_TOKEN",
  });

  const log = new Logger("storage");
  const srv = new StorageServer({ dataDir, nodeId, token, logger: log });
  await srv.init();

  const { host, port } = parseAddr(addr);
  const http = srv.createHttpServer();

  const shutdown = (): void => {
    log.info("shutdown_start");
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  http.listen(port, host, () => {
    log.info("listening", { addr, data: dataDir, id: nodeId, auth_enabled: token !== "" });
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
