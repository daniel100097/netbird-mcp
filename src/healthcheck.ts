export {};
if ((process.env.MCP_TRANSPORT ?? "stdio") === "stdio") process.exit(0);
const host = process.env.MCP_HOST?.includes(":") ? "[::1]" : "127.0.0.1";
try {
  const response = await fetch(
    `http://${host}:${process.env.MCP_PORT ?? "3000"}/healthz`,
    {
      headers: {
        Host: (process.env.MCP_ALLOWED_HOSTS ?? "localhost")
          .split(",")[0]!
          .trim(),
      },
      signal: AbortSignal.timeout(2_000),
    },
  );
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
