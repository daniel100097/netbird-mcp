import { afterEach, describe, expect, test } from "bun:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { loadConfig } from "../src/config.ts";
import { NetBirdClient, type Fetch } from "../src/netbird/client.ts";
import { createNetBirdServer, toolDefinitions } from "../src/server.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function connect(
  env: Record<string, string> = {},
  fetcher: Fetch = async () => Response.json([]),
) {
  const config = loadConfig({
    NETBIRD_API_TOKEN: "test-token",
    NETBIRD_READ_ONLY: "false",
    ...env,
  });
  const handler = createMcpHandler(() =>
    createNetBirdServer(config, new NetBirdClient(config, fetcher)),
  );
  cleanup.push(() => handler.close());
  const client = new Client(
    { name: "bun-tests", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  cleanup.push(() => client.close());
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
      fetch: (url, init) => handler.fetch(new Request(url, init)),
    }),
  );
  return client;
}

describe("MCP tool registration and calls", () => {
  test("advertises validated schemas and executes nested API operations", async () => {
    let received: Request | undefined;
    const client = await connect({}, async (url, init) => {
      received = new Request(url, init);
      return Response.json({ id: "resource-1" });
    });
    expect(client.getDiscoverResult()).toBeDefined();
    const { tools } = await client.listTools();
    expect(tools.length).toBe(211);
    expect(
      tools.find((t) => t.name === "netbird_delete_peer")?.annotations
        ?.destructiveHint,
    ).toBe(true);
    const result = await client.callTool({
      name: "netbird_get_network_resource",
      arguments: { networkId: "network-1", resourceId: "resource-1" },
    });
    expect(result.structuredContent).toEqual({ data: { id: "resource-1" } });
    expect(new URL(received!.url).pathname).toBe(
      "/api/networks/network-1/resources/resource-1",
    );
  });
  test("peer control can be disabled while peer information remains available", async () => {
    let calls = 0;
    const client = await connect(
      { NETBIRD_ENABLE_PEER_CONTROL: "false" },
      async () => {
        calls++;
        return Response.json([]);
      },
    );
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("netbird_list_peers");
    expect(names).toContain("netbird_get_peer");
    expect(names).not.toContain("netbird_update_peer");
    expect(names).not.toContain("netbird_delete_peer");
    expect(names).not.toContain("netbird_create_peer_job");
    await expect(
      client.callTool({
        name: "netbird_delete_peer",
        arguments: { peerId: "peer-1" },
      }),
    ).rejects.toThrow("not found");
    expect(calls).toBe(0);
  });
  test("read-only mode removes every mutation including GET domain validation", async () => {
    const client = await connect({ NETBIRD_READ_ONLY: "true" });
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(20);
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(
      true,
    );
    expect(
      tools.some(
        (tool) => tool.name === "netbird_validate_reverse_proxy_domain",
      ),
    ).toBe(false);
    await expect(
      client.callTool({
        name: "netbird_create_group",
        arguments: { body: { name: "devs" } },
      }),
    ).rejects.toThrow("not found");
  });
  test("disabling reverse proxy removes its services, domains, tokens, clusters, and logs", async () => {
    const client = await connect({ NETBIRD_ENABLE_REVERSE_PROXY: "false" });
    expect(
      (await client.listTools()).tools.some((tool) =>
        tool.name.includes("reverse_proxy"),
      ),
    ).toBe(false);
    await expect(
      client.callTool({
        name: "netbird_list_reverse_proxy_services",
        arguments: {},
      }),
    ).rejects.toThrow("not found");
  });
  test("action endpoints use their own names, paths, and methods", async () => {
    const received: Request[] = [];
    const client = await connect({}, async (url, init) => {
      received.push(new Request(url, init));
      return new Response(null, { status: 200 });
    });
    for (const [name, args] of [
      ["netbird_approve_user", { userId: "user-1" }],
      ["netbird_create_edr_peer_bypass", { "peer-id": "peer-1" }],
      ["netbird_sync_google_idp_integration", { id: "idp-1" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.structuredContent).toEqual({ data: { success: true } });
    }
    expect(
      received.map((r) => `${r.method} ${new URL(r.url).pathname}`),
    ).toEqual([
      "POST /api/users/user-1/approve",
      "POST /api/peers/peer-1/edr/bypass",
      "POST /api/integrations/google-idp/idp-1/sync",
    ]);
    expect(received.every((r) => r.body === null)).toBe(true);
  });
  test("does not expose billing, bootstrap, or invitee-side endpoints", () => {
    for (const excluded of [
      "/integrations/billing",
      "/integrations/msp/tenants/{id}/subscription",
      "/setup",
      "/users/invites/{token}",
      "/users/{userId}/password",
      "/users/{userId}/tokens",
    ])
      expect(
        toolDefinitions.filter(
          ({ path }) => path === excluded || path.startsWith(`${excluded}/`),
        ),
      ).toEqual([]);
  });
  test.each([
    ["PEERS", "netbird_list_peers"],
    ["GROUPS", "netbird_list_groups"],
    ["POLICIES", "netbird_list_policies"],
    ["ROUTES", "netbird_list_routes"],
    ["NETWORKS", "netbird_list_networks"],
    ["DNS", "netbird_get_dns_settings"],
    ["SETUP_KEYS", "netbird_list_setup_keys"],
    ["USERS", "netbird_get_current_user"],
    ["ACCOUNTS", "netbird_list_accounts"],
    ["EVENTS", "netbird_list_reverse_proxy_events"],
    ["EVENTS", "netbird_list_agent_network_access_logs"],
    ["POSTURE_CHECKS", "netbird_list_posture_checks"],
    ["AGENT_NETWORK", "netbird_list_agent_network_providers"],
    ["IDENTITY_PROVIDERS", "netbird_list_scim_idp_integrations"],
    ["EDR", "netbird_list_edr_bypassed_peers"],
    ["EVENT_STREAMING", "netbird_list_event_streaming_integrations"],
    ["NOTIFICATIONS", "netbird_list_notification_channels"],
    ["MSP", "netbird_list_msp_tenants"],
    ["INSTANCE", "netbird_get_instance_version"],
  ])("honors NETBIRD_ENABLE_%s (%s)", async (flag, toolName) => {
    const client = await connect({ [`NETBIRD_ENABLE_${flag}`]: "false" });
    expect(
      (await client.listTools()).tools.map((tool) => tool.name),
    ).not.toContain(toolName!);
  });
  test("validates write bodies and path IDs before contacting NetBird", async () => {
    let calls = 0;
    const client = await connect({}, async () => {
      calls++;
      return Response.json({});
    });
    for (const args of [{}, { body: {} }, { body: { name: 123 } }]) {
      expect(
        (
          await client.callTool({
            name: "netbird_create_group",
            arguments: args,
          })
        ).isError,
      ).toBe(true);
    }
    expect(
      (
        await client.callTool({
          name: "netbird_get_peer",
          arguments: { peerId: "../users" },
        })
      ).isError,
    ).toBe(true);
    expect(calls).toBe(0);
    await client.callTool({
      name: "netbird_create_group",
      arguments: { body: { name: "devs" } },
    });
    expect(calls).toBe(1);
  });
  test("returns upstream failures as MCP tool errors", async () => {
    const client = await connect({}, async () =>
      Response.json({ message: "No permission" }, { status: 403 }),
    );
    const result = await client.callTool({
      name: "netbird_list_peers",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("HTTP 403: No permission");
  });
});
