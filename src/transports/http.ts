import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  hostHeaderValidation,
  toNodeHandler,
} from "@modelcontextprotocol/node";
import { createMcpHandler, type McpServer } from "@modelcontextprotocol/server";
import { SSEServerTransport } from "@modelcontextprotocol/server-legacy/sse";
import type { Config } from "../config.ts";
import { NetBirdClient } from "../netbird/client.ts";
import { createNetBirdServer } from "../server.ts";

export const MAX_REQUEST_BYTES = 1024 * 1024;
class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (
    req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    throw new HttpError(415, "Content-Type must be application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  // Do not destroy the socket before a 413 response can be delivered.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES)
      throw new HttpError(413, "Request exceeds the 1 MiB limit");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

function authorized(header: string | undefined, token: string): boolean {
  const match = /^Bearer (\S+)$/i.exec(header ?? "");
  if (!match?.[1]) return false;
  const actual = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function startHttpServer(
  config: Config,
  client = new NetBirdClient(config),
) {
  if (!config.authToken)
    throw new Error("MCP_AUTH_TOKEN is required for sse/http mode");
  const authToken = config.authToken;
  const factory = () => createNetBirdServer(config, client);
  const mcp = createMcpHandler(factory, { responseMode: "sse" });
  const handleMcp = toNodeHandler(mcp);
  const validateHost = hostHeaderValidation(config.allowedHosts);
  const sessions = new Map<
    string,
    { transport: SSEServerTransport; server: McpServer }
  >();

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    if (!validateHost(req, res)) return;
    const origin = req.headers.origin;
    if (origin !== undefined) {
      if (!config.allowedOrigins.includes(origin)) {
        json(res, 403, { error: "Origin not allowed" });
        return;
      }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Expose-Headers",
        "Mcp-Session-Id, MCP-Protocol-Version, WWW-Authenticate",
      );
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz" && req.method === "GET") {
      json(res, 200, { status: "ok" });
      return;
    }
    if (!["/mcp", "/sse", "/messages"].includes(url.pathname)) {
      json(res, 404, { error: "Not found" });
      return;
    }
    if (req.method === "OPTIONS") {
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
      );
      res.writeHead(204).end();
      return;
    }
    if (!authorized(req.headers.authorization, authToken)) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="netbird-mcp"');
      json(res, 401, { error: "Invalid or missing bearer token" });
      return;
    }
    if (Number(req.headers["content-length"] ?? 0) > MAX_REQUEST_BYTES) {
      res.setHeader("Connection", "close");
      json(res, 413, { error: "Request exceeds the 1 MiB limit" });
      return;
    }
    if (url.pathname === "/mcp") {
      const body = req.method === "POST" ? await readJson(req) : undefined;
      await handleMcp(req, res, body);
      return;
    }
    if (url.pathname === "/sse" && req.method === "GET") {
      if (sessions.size >= config.maxSseSessions) {
        json(res, 503, { error: "SSE session limit reached" });
        return;
      }
      res.setHeader("X-Accel-Buffering", "no");
      const transport = new SSEServerTransport("/messages", res);
      const server = factory();
      sessions.set(transport.sessionId, { transport, server });
      const heartbeat = setInterval(() => {
        if (!res.destroyed) res.write(": keepalive\n\n");
      }, 15_000);
      heartbeat.unref();
      res.once("close", () => {
        clearInterval(heartbeat);
        sessions.delete(transport.sessionId);
        void server.close().catch(() => {});
      });
      try {
        await server.connect(transport);
      } catch (error) {
        clearInterval(heartbeat);
        sessions.delete(transport.sessionId);
        await server.close();
        throw error;
      }
      return;
    }
    if (url.pathname === "/messages" && req.method === "POST") {
      const id = url.searchParams.get("sessionId");
      if (!id) {
        json(res, 400, { error: "Missing sessionId" });
        return;
      }
      const session = sessions.get(id);
      if (!session) {
        json(res, 404, { error: "Unknown SSE session" });
        return;
      }
      await session.transport.handlePostMessage(req, res, await readJson(req));
      return;
    }
    res.setHeader(
      "Allow",
      url.pathname === "/sse" ? "GET, OPTIONS" : "POST, OPTIONS",
    );
    json(res, 405, { error: "Method not allowed" });
  }

  const http = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 413) res.setHeader("Connection", "close");
      json(res, status, {
        error:
          error instanceof HttpError ? error.message : "Internal server error",
      });
    });
  });
  http.requestTimeout = 15_000;
  http.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(config.port, config.host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("Unable to determine listening address");
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    get sessionCount() {
      return sessions.size;
    },
    close(): Promise<void> {
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) =>
          http.close((error) => (error ? reject(error) : resolve())),
        );
        await Promise.allSettled([
          mcp.close(),
          ...Array.from(sessions.values(), ({ server }) => server.close()),
        ]);
        sessions.clear();
        http.closeAllConnections();
        await stopped;
      })();
      return closing;
    },
  };
}
