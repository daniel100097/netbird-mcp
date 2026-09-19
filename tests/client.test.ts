import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { MAX_RESPONSE_BYTES, NetBirdClient } from "../src/netbird/client.ts";
import { toolDefinitions } from "../src/server.ts";

const config = loadConfig({
  NETBIRD_API_TOKEN: "secret-netbird-token",
  NETBIRD_API_URL: "https://netbird.example/management/api",
});
const tool = (name: string) => toolDefinitions.find((t) => t.name === name)!;

describe("NetBird API client", () => {
  test("preserves self-hosted prefixes, encodes filters, and uses Token auth", async () => {
    let request: Request | undefined;
    let redirect: RequestRedirect | undefined;
    const client = new NetBirdClient(config, async (url, init) => {
      request = new Request(url, init);
      redirect = init?.redirect;
      return Response.json([{ id: "peer-1" }]);
    });
    expect(
      await client.request(tool("netbird_list_peers"), {
        query: { name: "a & b", ip: "100.64.0.1" },
      }),
    ).toEqual([{ id: "peer-1" }]);
    expect(new URL(request!.url).pathname).toBe("/management/api/peers");
    expect(new URL(request!.url).searchParams.get("name")).toBe("a & b");
    expect(request!.headers.get("authorization")).toBe(
      "Token secret-netbird-token",
    );
    expect(redirect).toBe("error");
  });
  test("sends JSON writes once and handles an empty delete response", async () => {
    const requests: Request[] = [];
    const client = new NetBirdClient(config, async (url, init) => {
      requests.push(new Request(url, init));
      return new Response(null, { status: 204 });
    });
    expect(
      await client.request(tool("netbird_update_group"), {
        groupId: "group-1",
        body: { name: "devs", peers: ["peer-1"] },
      }),
    ).toEqual({ success: true });
    expect(requests[0]!.method).toBe("PUT");
    expect(await requests[0]!.json()).toEqual({
      name: "devs",
      peers: ["peer-1"],
    });
    expect(requests).toHaveLength(1);
  });
  test.each([
    "..",
    ".",
    "../users",
    "%2e%2e",
    "x/y",
    "x\\y",
    "x?name=y",
    "x#hash",
  ])("rejects path traversal or path rewriting via %s", async (peerId) => {
    let calls = 0;
    const client = new NetBirdClient(config, async () => {
      calls++;
      return Response.json({});
    });
    await expect(
      client.request(tool("netbird_get_peer"), { peerId }),
    ).rejects.toThrow("Invalid path parameter");
    expect(calls).toBe(0);
  });
  test("returns API status and redacts credentials from errors", async () => {
    const client = new NetBirdClient(config, async () =>
      Response.json(
        { message: "Denied secret-netbird-token" },
        { status: 403 },
      ),
    );
    await expect(
      client.request(tool("netbird_list_peers"), {}),
    ).rejects.toThrow("HTTP 403: Denied [redacted]");
  });
  test("omits HTML error bodies and rejects malformed success JSON", async () => {
    const failed = new NetBirdClient(
      config,
      async () => new Response("<html>proxy-secret</html>", { status: 502 }),
    );
    await expect(
      failed.request(tool("netbird_list_peers"), {}),
    ).rejects.toThrow("NetBird API returned HTTP 502");
    const malformed = new NetBirdClient(
      config,
      async () => new Response("not-json"),
    );
    await expect(
      malformed.request(tool("netbird_list_peers"), {}),
    ).rejects.toThrow("invalid JSON");
  });
  test("limits response bodies", async () => {
    const client = new NetBirdClient(
      config,
      async () => new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1)),
    );
    await expect(
      client.request(tool("netbird_list_peers"), {}),
    ).rejects.toThrow("10 MiB limit");
  });
  test("times out stalled requests", async () => {
    const client = new NetBirdClient(
      { ...config, apiTimeoutMs: 10 },
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => reject(init!.signal!.reason),
            { once: true },
          );
        }),
    );
    await expect(
      client.request(tool("netbird_list_peers"), {}),
    ).rejects.toThrow("timed out");
  });
  test("propagates cancellation to fetch", async () => {
    const controller = new AbortController();
    const client = new NetBirdClient(config, async (_url, init) => {
      controller.abort();
      expect(init!.signal!.aborted).toBe(true);
      throw init!.signal!.reason;
    });
    await expect(
      client.request(tool("netbird_list_peers"), {}, controller.signal),
    ).rejects.toThrow("cancelled");
  });
  test("does not follow redirects or forward credentials to another host", async () => {
    let destinationCalls = 0;
    const destination = Bun.serve({
      port: 0,
      fetch: () => {
        destinationCalls++;
        return Response.json([]);
      },
    });
    const redirector = Bun.serve({
      port: 0,
      fetch: () => Response.redirect(destination.url),
    });
    try {
      const client = new NetBirdClient({
        ...config,
        apiUrl: new URL("api", redirector.url).href,
      });
      await expect(
        client.request(tool("netbird_list_peers"), {}),
      ).rejects.toThrow("redirect error");
      expect(destinationCalls).toBe(0);
    } finally {
      await redirector.stop(true);
      await destination.stop(true);
    }
  });
});
