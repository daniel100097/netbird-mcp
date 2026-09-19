// Explicit route allowlist: upstream additions never become tools automatically.
import {
  fromJsonSchema,
  type JsonSchemaType,
} from "@modelcontextprotocol/server";
import type { Feature } from "../config.ts";
import type { Method, ToolDefinition } from "../netbird/types.ts";
import { schemaValidator } from "../netbird/schema.ts";

const revision = "7d8f4fa31c2c8a3ebd40f041065ddbae6055d5f3";
const source = `https://raw.githubusercontent.com/netbirdio/netbird/${revision}/shared/management/http/api/openapi.yml`;
type Schema = Record<string, unknown>;
interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema: Schema;
  explode?: boolean;
}
interface Operation {
  summary: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: { content: Record<string, { schema: Schema }> };
}
interface OpenApi {
  paths: Record<
    string,
    Partial<Record<Lowercase<Method>, Operation>> & { parameters?: Parameter[] }
  >;
}
type Route = [
  path: string,
  noun: string,
  feature: Feature,
  getAction?: "list" | "get" | "validate",
];
const routes: Route[] = [];
function resource(
  path: string,
  singular: string,
  plural: string,
  id: string,
  feature: Feature,
) {
  routes.push(
    [path, plural, feature, "list"],
    [`${path}/{${id}}`, singular, feature, "get"],
  );
}
resource("/peers", "peer", "peers", "peerId", "peers");
routes.push(
  ["/peers/{peerId}/accessible-peers", "accessible_peers", "peers"],
  ["/peers/{peerId}/jobs", "peer_jobs", "peers"],
  ["/peers/{peerId}/jobs/{jobId}", "peer_job", "peers", "get"],
);
resource("/groups", "group", "groups", "groupId", "groups");
resource("/policies", "policy", "policies", "policyId", "policies");
resource("/routes", "route", "routes", "routeId", "routes");
resource("/networks", "network", "networks", "networkId", "networks");
resource(
  "/networks/{networkId}/resources",
  "network_resource",
  "network_resources",
  "resourceId",
  "networks",
);
resource(
  "/networks/{networkId}/routers",
  "network_router",
  "network_routers",
  "routerId",
  "networks",
);
resource(
  "/dns/nameservers",
  "dns_nameserver",
  "dns_nameservers",
  "nsgroupId",
  "dns",
);
resource("/dns/zones", "dns_zone", "dns_zones", "zoneId", "dns");
resource(
  "/dns/zones/{zoneId}/records",
  "dns_record",
  "dns_records",
  "recordId",
  "dns",
);
routes.push(["/dns/settings", "dns_settings", "dns", "get"]);
resource("/setup-keys", "setup_key", "setup_keys", "keyId", "setupKeys");
resource("/users", "user", "users", "userId", "users");
routes.push(["/users/current", "current_user", "users", "get"]);
resource("/accounts", "account", "accounts", "accountId", "accounts");
resource(
  "/posture-checks",
  "posture_check",
  "posture_checks",
  "postureCheckId",
  "postureChecks",
);
routes.push(
  ["/events/audit", "audit_events", "events"],
  ["/events/network-traffic", "traffic_events", "events"],
  ["/events/proxy", "reverse_proxy_events", "reverseProxy"],
);
resource(
  "/reverse-proxies/services",
  "reverse_proxy_service",
  "reverse_proxy_services",
  "serviceId",
  "reverseProxy",
);
resource(
  "/reverse-proxies/domains",
  "reverse_proxy_domain",
  "reverse_proxy_domains",
  "domainId",
  "reverseProxy",
);
resource(
  "/reverse-proxies/proxy-tokens",
  "reverse_proxy_token",
  "reverse_proxy_tokens",
  "tokenId",
  "reverseProxy",
);
resource(
  "/reverse-proxies/clusters",
  "reverse_proxy_cluster",
  "reverse_proxy_clusters",
  "clusterAddress",
  "reverseProxy",
);
routes.push([
  "/reverse-proxies/domains/{domainId}/validate",
  "reverse_proxy_domain",
  "reverseProxy",
  "validate",
]);

const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
if (!response.ok)
  throw new Error(
    `Unable to download pinned NetBird schema: HTTP ${response.status}`,
  );
const document = Bun.YAML.parse(await response.text()) as OpenApi;

function resolveRef(ref: string): unknown {
  if (!ref.startsWith("#/"))
    throw new Error(`External schema reference is not supported: ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .reduce<unknown>((value, key) => {
      if (!value || typeof value !== "object")
        throw new Error(`Missing reference: ${ref}`);
      return (value as Schema)[key.replace(/~1/g, "/").replace(/~0/g, "~")];
    }, document);
}

// Inline request schemas so each advertised MCP input schema is self-contained.
function normalize(value: unknown, refs: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => normalize(v, refs));
  if (!value || typeof value !== "object") return value;
  const object = value as Schema;
  if (typeof object.$ref === "string") {
    if (refs.includes(object.$ref))
      throw new Error(`Recursive schema: ${object.$ref}`);
    return normalize(
      { ...(resolveRef(object.$ref) as Schema), ...object, $ref: undefined },
      [...refs, object.$ref],
    );
  }
  const normalized: Schema = {};
  for (const [key, entry] of Object.entries(object)) {
    if (
      ["example", "nullable", "xml", "discriminator", "externalDocs"].includes(
        key,
      ) ||
      key.startsWith("x-") ||
      entry === undefined
    )
      continue;
    normalized[key] = normalize(entry, refs);
  }
  if (object.nullable === true)
    return { anyOf: [normalized, { type: "null" }] };
  return normalized;
}

const tools: ToolDefinition[] = [];
for (const [path, noun, feature, getAction = "list"] of routes) {
  const pathItem = document.paths[`/api${path}`];
  if (!pathItem) throw new Error(`Missing API path ${path}`);
  for (const method of ["get", "post", "put", "patch", "delete"] as const) {
    const operation = pathItem[method];
    if (!operation) continue;
    const action =
      method === "get"
        ? getAction
        : { post: "create", put: "update", patch: "patch", delete: "delete" }[
            method
          ];
    // Collection POST uses the corresponding item's singular name.
    const itemRoute = routes.find(
      ([candidate]) =>
        candidate.startsWith(`${path}/{`) &&
        candidate.slice(path.length + 1).indexOf("/") === -1,
    );
    const toolNoun = method === "post" && itemRoute ? itemRoute[1] : noun;
    const properties: Schema = {};
    const required: string[] = [];
    const queryProperties: Schema = {};
    const queryRequired: string[] = [];
    const parameters = [
      ...(pathItem.parameters ?? []),
      ...(operation.parameters ?? []),
    ];
    for (const parameter of parameters) {
      const schema = normalize({
        ...parameter.schema,
        description: parameter.description,
      }) as Schema;
      if (parameter.in === "path") {
        properties[parameter.name] = {
          ...schema,
          type: "string",
          minLength: 1,
          pattern: "^(?!\\.{1,2}$)[^/\\\\%?#\\s]+$",
        };
        required.push(parameter.name);
      } else if (parameter.in === "query") {
        queryProperties[parameter.name] = schema;
        if (parameter.required) queryRequired.push(parameter.name);
      } else throw new Error(`Unsupported parameter location: ${parameter.in}`);
    }
    if (Object.keys(queryProperties).length) {
      properties.query = {
        type: "object",
        properties: queryProperties,
        required: queryRequired,
        additionalProperties: false,
      };
      if (queryRequired.length) required.push("query");
    }
    const body = operation.requestBody?.content["application/json"]?.schema;
    if (body) {
      properties.body = normalize(body);
      required.push("body");
    }
    const inputSchema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties,
      required,
      additionalProperties: false,
    } as JsonSchemaType;
    // Compile now: fail regeneration if a published request schema is invalid.
    fromJsonSchema(inputSchema, schemaValidator);
    tools.push({
      name: `netbird_${action}_${toolNoun}`,
      description: `${operation.description || operation.summary}. ${method.toUpperCase()} /api${path}`,
      method: method.toUpperCase() as Method,
      path,
      features: [
        feature,
        ...(feature === "peers" && method !== "get"
          ? ["peerControl" as const]
          : []),
        ...(path === "/events/proxy" ? ["events" as const] : []),
      ],
      write: method !== "get" || getAction === "validate",
      queryParameters: parameters
        .filter((p) => p.in === "query")
        .map((p) => ({ name: p.name, explode: p.explode ?? true })),
      inputSchema,
    });
  }
}
if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
  throw new Error("Duplicate tool names");
await Bun.write(
  new URL("../netbird/catalog.json", import.meta.url),
  JSON.stringify({ source, tools }, null, 2) + "\n",
);
console.error(`Generated ${tools.length} tools from NetBird ${revision}`);
