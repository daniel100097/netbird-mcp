import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const base = { NETBIRD_API_TOKEN: "test-netbird-token" };

describe("environment configuration", () => {
  test("defaults to stdio and read-only tools", () => {
    const config = loadConfig(base);
    expect(config.transport).toBe("stdio");
    expect(config.readOnly).toBe(true);
    expect(config.apiUrl).toBe("https://api.netbird.io/api");
    expect(config.features.peers).toBe(true);
  });
  test.each(["false", "0", "no", "off", " FALSE "])(
    "disables features with %s",
    (value) => {
      expect(
        loadConfig({ ...base, NETBIRD_ENABLE_PEER_CONTROL: value }).features
          .peerControl,
      ).toBe(false);
      expect(
        loadConfig({ ...base, NETBIRD_ENABLE_REVERSE_PROXY: value }).features
          .reverseProxy,
      ).toBe(false);
    },
  );
  test("rejects misspelled flags instead of enabling them", () => {
    expect(() =>
      loadConfig({ ...base, NETBIRD_ENABLE_PEERS: "flase" }),
    ).toThrow("NETBIRD_ENABLE_PEERS");
  });
  test.each(["sse", "http"])(
    "requires network authentication in %s mode",
    (transport) => {
      expect(() => loadConfig({ ...base, MCP_TRANSPORT: transport })).toThrow(
        "MCP_AUTH_TOKEN",
      );
      expect(
        loadConfig({
          ...base,
          MCP_TRANSPORT: transport,
          MCP_AUTH_TOKEN: "mcp-token",
        }).transport,
      ).toBe(transport);
    },
  );
  test("requires the NetBird token without leaking its value", () => {
    expect(() => loadConfig({})).toThrow("NETBIRD_API_TOKEN is required");
    expect(() => loadConfig({ NETBIRD_API_TOKEN: "secret\nvalue" })).toThrow(
      "must not contain whitespace",
    );
  });
  test("supports self-hosted API prefixes", () => {
    expect(
      loadConfig({
        ...base,
        NETBIRD_API_URL: "http://netbird:8080/management/api/",
      }).apiUrl,
    ).toBe("http://netbird:8080/management/api");
  });
  test.each([
    "file:///api",
    "https://secret:password@example.com/api",
    "https://example.com/api?token=secret",
    "https://example.com/api#fragment",
    "https://example.com",
  ])("rejects invalid API URL %s", (url) => {
    expect(() => loadConfig({ ...base, NETBIRD_API_URL: url })).toThrow(
      "NETBIRD_API_URL",
    );
  });
  test.each(["0", "-1", "65536", "3.5", "oops"])(
    "rejects invalid port %s",
    (port) => {
      expect(() => loadConfig({ ...base, MCP_PORT: port })).toThrow("MCP_PORT");
    },
  );
  test("rejects invalid transport, timeout, host, and origin settings", () => {
    expect(() => loadConfig({ ...base, MCP_TRANSPORT: "socket" })).toThrow(
      "MCP_TRANSPORT",
    );
    expect(() => loadConfig({ ...base, NETBIRD_TIMEOUT_MS: "NaN" })).toThrow(
      "NETBIRD_TIMEOUT_MS",
    );
    expect(() => loadConfig({ ...base, MCP_ALLOWED_HOSTS: "*" })).toThrow(
      "MCP_ALLOWED_HOSTS",
    );
    expect(() =>
      loadConfig({ ...base, MCP_ALLOWED_HOSTS: "example.com:3000" }),
    ).toThrow("MCP_ALLOWED_HOSTS");
    expect(() =>
      loadConfig({ ...base, MCP_ALLOWED_ORIGINS: "https://example.com/path" }),
    ).toThrow("MCP_ALLOWED_ORIGINS");
  });
});
