export const featureEnvironment = {
  peers: "NETBIRD_ENABLE_PEERS",
  peerControl: "NETBIRD_ENABLE_PEER_CONTROL",
  groups: "NETBIRD_ENABLE_GROUPS",
  policies: "NETBIRD_ENABLE_POLICIES",
  routes: "NETBIRD_ENABLE_ROUTES",
  networks: "NETBIRD_ENABLE_NETWORKS",
  dns: "NETBIRD_ENABLE_DNS",
  setupKeys: "NETBIRD_ENABLE_SETUP_KEYS",
  users: "NETBIRD_ENABLE_USERS",
  accounts: "NETBIRD_ENABLE_ACCOUNTS",
  events: "NETBIRD_ENABLE_EVENTS",
  postureChecks: "NETBIRD_ENABLE_POSTURE_CHECKS",
  reverseProxy: "NETBIRD_ENABLE_REVERSE_PROXY",
} as const;

export type Feature = keyof typeof featureEnvironment;
type Environment = Record<string, string | undefined>;

export interface Config {
  transport: "stdio" | "sse" | "http";
  apiUrl: string;
  apiToken: string;
  apiTimeoutMs: number;
  readOnly: boolean;
  features: Record<Feature, boolean>;
  host: string;
  port: number;
  authToken?: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  maxSseSessions: number;
}

function boolean(env: Environment, name: string, fallback: boolean): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  if (["true", "1", "yes", "on"].includes(value)) return true;
  if (["false", "0", "no", "off"].includes(value)) return false;
  throw new Error(
    `${name} must be a boolean (true/false, 1/0, yes/no, on/off)`,
  );
}

function integer(
  env: Environment,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  ) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

function list(value: string | undefined, fallback: string[]): string[] {
  return value === undefined
    ? fallback
    : value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

function token(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();
  if (value && /\s/.test(value))
    throw new Error(`${name} must not contain whitespace`);
  return value || undefined;
}

export function loadConfig(env: Environment = process.env): Config {
  const transport = env.MCP_TRANSPORT?.trim().toLowerCase() || "stdio";
  if (transport !== "stdio" && transport !== "sse" && transport !== "http") {
    throw new Error("MCP_TRANSPORT must be stdio, sse, or http");
  }
  const apiToken = token(env, "NETBIRD_API_TOKEN");
  if (!apiToken) throw new Error("NETBIRD_API_TOKEN is required");
  let url: URL;
  try {
    url = new URL(env.NETBIRD_API_URL?.trim() || "https://api.netbird.io/api");
  } catch {
    throw new Error(
      "NETBIRD_API_URL must be an absolute HTTP(S) URL including /api",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "NETBIRD_API_URL must use HTTP(S), without credentials, query, or fragment",
    );
  }
  const apiUrl = url.href.replace(/\/+$/, "");
  if (!url.pathname.replace(/\/+$/, "").endsWith("/api")) {
    throw new Error(
      "NETBIRD_API_URL must end with /api (for example https://api.netbird.io/api)",
    );
  }
  const authToken = token(env, "MCP_AUTH_TOKEN");
  if (transport !== "stdio" && !authToken) {
    throw new Error("MCP_AUTH_TOKEN is required for sse/http mode");
  }
  const allowedHosts = list(env.MCP_ALLOWED_HOSTS, [
    "localhost",
    "127.0.0.1",
    "[::1]",
  ]).map((host) => host.toLowerCase());
  if (
    !allowedHosts.length ||
    allowedHosts.some((host) => host.includes("*") || /[\s/?#@]/.test(host))
  ) {
    throw new Error(
      "MCP_ALLOWED_HOSTS must contain explicit hostnames, without wildcards or URLs",
    );
  }
  for (const host of allowedHosts) {
    try {
      const parsed = new URL(`http://${host}`);
      if (parsed.hostname !== host || parsed.port || parsed.pathname !== "/")
        throw new Error();
    } catch {
      throw new Error(
        "MCP_ALLOWED_HOSTS must contain hostnames without ports; bracket IPv6 addresses",
      );
    }
  }
  const allowedOrigins = list(env.MCP_ALLOWED_ORIGINS, []);
  for (const origin of allowedOrigins) {
    try {
      const parsed = new URL(origin);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.origin !== origin
      )
        throw new Error();
    } catch {
      throw new Error(
        "MCP_ALLOWED_ORIGINS must contain exact HTTP(S) origins without paths",
      );
    }
  }
  const features = Object.fromEntries(
    Object.entries(featureEnvironment).map(([key, name]) => [
      key,
      boolean(env, name, true),
    ]),
  ) as Config["features"];
  return {
    transport,
    apiUrl,
    apiToken,
    authToken,
    features,
    apiTimeoutMs: integer(env, "NETBIRD_TIMEOUT_MS", 30_000, 300_000),
    readOnly: boolean(env, "NETBIRD_READ_ONLY", true),
    host: env.MCP_HOST?.trim() || "127.0.0.1",
    port: integer(env, "MCP_PORT", 3000, 65535),
    allowedHosts,
    allowedOrigins,
    maxSseSessions: integer(env, "MCP_MAX_SSE_SESSIONS", 100, 10_000),
  };
}
