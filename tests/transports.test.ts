import { afterEach, describe, expect, test } from "bun:test";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { loadConfig, type Config } from "../src/config.ts";
import { NetBirdClient } from "../src/netbird/client.ts";
import { MAX_REQUEST_BYTES, startHttpServer } from "../src/transports/http.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const headers = { Authorization: "Bearer test-mcp-token" };
async function serve(overrides: Partial<Config> = {}) {
  const config = {
    ...loadConfig({
      NETBIRD_API_TOKEN: "test-netbird-token",
      MCP_TRANSPORT: "sse",
      MCP_AUTH_TOKEN: "test-mcp-token",
    }),
    port: 0,
    ...overrides,
  };
  const requests: Request[] = [];
  const server = await startHttpServer(
    config,
    new NetBirdClient(config, async (url, init) => {
      requests.push(new Request(url, init));
      return Response.json([{ id: "peer-1", name: "test-peer" }]);
    }),
  );
  cleanup.push(() => server.close());
  return { server, base: `http://127.0.0.1:${server.port}`, requests };
}

describe("HTTP and SSE transports", () => {
  test.each(["auto", "legacy"] as const)(
    "completes real Streamable HTTP calls in %s mode",
    async (mode) => {
      const { base, requests } = await serve();
      const client = new Client(
        { name: "http-tests", version: "1.0.0" },
        mode === "auto" ? { versionNegotiation: { mode: "auto" } } : {},
      );
      cleanup.push(() => client.close());
      const contentTypes: string[] = [];
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers },
          fetch: async (url, init) => {
            const response = await fetch(url, init);
            contentTypes.push(response.headers.get("content-type") ?? "");
            return response;
          },
        }),
      );
      expect(
        (await client.listTools()).tools.map((tool) => tool.name),
      ).toContain("netbird_list_peers");
      expect(
        (await client.callTool({ name: "netbird_list_peers", arguments: {} }))
          .structuredContent,
      ).toEqual({ data: [{ id: "peer-1", name: "test-peer" }] });
      expect(requests).toHaveLength(1);
      expect(
        contentTypes.some((type) => type.includes("text/event-stream")),
      ).toBe(true);
    },
  );
  test("completes the two-endpoint SSE handshake and cleans up disconnected sessions", async () => {
    const { base, server } = await serve();
    const client = new Client({ name: "sse-tests", version: "1.0.0" });
    cleanup.push(() => client.close());
    await client.connect(
      new SSEClientTransport(new URL(`${base}/sse`), {
        requestInit: { headers },
      }),
    );
    expect(server.sessionCount).toBe(1);
    expect(
      (await client.callTool({ name: "netbird_list_peers", arguments: {} }))
        .structuredContent,
    ).toEqual({ data: [{ id: "peer-1", name: "test-peer" }] });
    await client.close();
    for (let i = 0; i < 30 && server.sessionCount; i++) await Bun.sleep(10);
    expect(server.sessionCount).toBe(0);
  });
  test("health is public, but all MCP endpoints require the separate bearer token", async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    for (const path of ["/sse", "/mcp", "/messages?sessionId=made-up"]) {
      const method = path.startsWith("/sse") ? "GET" : "POST";
      expect((await fetch(base + path, { method })).status).toBe(401);
      expect(
        (
          await fetch(base + path, {
            method,
            headers: { Authorization: "Bearer test-netbird-token" },
          })
        ).status,
      ).toBe(401);
    }
  });
  test("blocks unapproved Host and Origin headers", async () => {
    const { base } = await serve({ allowedOrigins: ["https://mcp.example"] });
    expect(
      (
        await fetch(`${base}/healthz`, {
          headers: { Host: "attacker.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/mcp`, {
          headers: { ...headers, Origin: "https://attacker.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${base}/mcp`, {
          headers: { ...headers, Origin: "https://mcp.example:444" },
        })
      ).status,
    ).toBe(403);
    const preflight = await fetch(`${base}/mcp`, {
      method: "OPTIONS",
      headers: { Origin: "https://mcp.example" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://mcp.example",
    );
  });
  test("rejects malformed JSON, oversized bodies, unsupported media, and unknown sessions", async () => {
    const { base } = await serve();
    expect(
      (
        await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (await fetch(`${base}/mcp`, { method: "POST", headers, body: "{}" }))
        .status,
    ).toBe(415);
    expect(
      (
        await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: " ".repeat(MAX_REQUEST_BYTES + 1),
        })
      ).status,
    ).toBe(413);
    expect(
      (await fetch(`${base}/messages`, { method: "POST", headers })).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${base}/messages?sessionId=unknown`, {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(404);
    expect(
      (await fetch(`${base}/sse`, { method: "POST", headers })).status,
    ).toBe(405);
  });
  test("bounds SSE sessions and releases capacity when a connection closes", async () => {
    const { base, server } = await serve({ maxSseSessions: 1 });
    const stream = await fetch(`${base}/sse`, { headers });
    expect(stream.status).toBe(200);
    expect((await fetch(`${base}/sse`, { headers })).status).toBe(503);
    await stream.body!.cancel();
    for (let i = 0; i < 30 && server.sessionCount; i++) await Bun.sleep(10);
    expect(server.sessionCount).toBe(0);
    const replacement = await fetch(`${base}/sse`, { headers });
    expect(replacement.status).toBe(200);
    await replacement.body!.cancel();
  });
  test("enforces the body limit on chunked uploads without Content-Length", async () => {
    const { base } = await serve();
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < 17; i++)
            controller.enqueue(new Uint8Array(65536));
          controller.close();
        },
      }),
    });
    expect(response.status).toBe(413);
  });
  test("shutdown closes active SSE streams and can be called twice", async () => {
    const { base, server } = await serve();
    const response = await fetch(`${base}/sse`, { headers });
    const reader = response.body!.getReader();
    await reader.read();
    await server.close();
    expect((await reader.read()).done).toBe(true);
    expect(server.sessionCount).toBe(0);
    await server.close();
  });
});

describe("stdio entry point", () => {
  test.each(["auto", "legacy"] as const)(
    "serves real subprocess tool calls in %s mode with clean stdout",
    async (mode) => {
      const upstream = Bun.serve({
        port: 0,
        fetch: (request) => {
          expect(request.headers.get("authorization")).toBe(
            "Token test-netbird-token",
          );
          return Response.json([{ id: "peer-stdio" }]);
        },
      });
      cleanup.push(() => upstream.stop(true));
      const client = new Client(
        { name: "stdio-tests", version: "1.0.0" },
        mode === "auto" ? { versionNegotiation: { mode: "auto" } } : {},
      );
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--no-env-file", "src/index.ts"],
        cwd: new URL("..", import.meta.url).pathname,
        env: {
          MCP_TRANSPORT: "stdio",
          NETBIRD_API_TOKEN: "test-netbird-token",
          NETBIRD_API_URL: new URL("api", upstream.url).href,
          NETBIRD_ENABLE_REVERSE_PROXY: "false",
          NETBIRD_READ_ONLY: "true",
        },
        stderr: "pipe",
      });
      let stderr = "";
      transport.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      cleanup.push(() => client.close());
      await client.connect(transport);
      expect(
        (await client.listTools()).tools.some((tool) =>
          tool.name.includes("reverse_proxy"),
        ),
      ).toBe(false);
      expect(
        (await client.callTool({ name: "netbird_list_peers", arguments: {} }))
          .structuredContent,
      ).toEqual({ data: [{ id: "peer-stdio" }] });
      expect(stderr).toContain("netbird-mcp:");
      await client.close();
    },
    10_000,
  );
});
