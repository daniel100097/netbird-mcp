import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.ts";
import { createNetBirdServer, enabledTools } from "./server.ts";
import { startHttpServer } from "./transports/http.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const runtime =
    config.transport === "stdio"
      ? serveStdio(() => createNetBirdServer(config))
      : await startHttpServer(config);
  console.error(
    `netbird-mcp: ${enabledTools(config).length} tools; ${config.readOnly ? "read-only" : "writes enabled"}; ${config.transport === "stdio" ? "stdio" : `listening on ${config.host}:${config.port} (/sse, /mcp)`}`,
  );
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 5_000);
    deadline.unref();
    try {
      await runtime.close();
      process.exitCode = 0;
    } catch {
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  if (config.transport === "stdio")
    process.stdin.once("end", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(
    `netbird-mcp: ${error instanceof Error ? error.message : "Startup failed"}`,
  );
  process.exitCode = 1;
});
