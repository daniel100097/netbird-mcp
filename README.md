# netbird-mcp

A Bun/TypeScript MCP server that acts as a client for the NetBird REST API. Built with the [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/).

- **stdio** for MCP hosts that launch a process.
- **SSE** at `/sse` with messages posted to `/messages`.
- **Streamable HTTP** at `/mcp`, including SSE responses and SDK v2 protocol support.
- 90 schema-validated API tools, with environment flags for each feature group.
- Read-only by default, Bun tests, Docker development/runtime images, and GitHub Container Registry publishing.

## Run with Docker Compose

Docker with Compose v2.24+ is sufficient; Bun does not need to be installed on the host.

```sh
cp .env.example .env
# Edit .env: set NETBIRD_API_TOKEN and a separate MCP_AUTH_TOKEN.
# To generate MCP_AUTH_TOKEN: openssl rand -hex 32
docker compose up --build -d netbird-mcp
curl http://127.0.0.1:3000/healthz
```

Use a NetBird personal access token or service-user token. `NETBIRD_API_URL` defaults to `https://api.netbird.io/api`; for self-hosted NetBird, use your management URL **including `/api`**. A path prefix such as `https://vpn.example/management/api` is supported.

The MCP bearer token protects access to this server. It is separate from the NetBird token, which the server sends upstream as `Authorization: Token …`. Credentials are loaded at runtime; `.env` is excluded from Git and image builds.

Compose publishes port 3000 on localhost. To serve another machine, configure `MCP_BIND_ADDRESS`, add your public hostname to `MCP_ALLOWED_HOSTS`, and put TLS in front of the server. When proxying SSE, disable response buffering, allow long-lived streams, and forward `/mcp`, `/sse`, and `/messages` at the root of the same public origin. Legacy SSE sessions live in one process, so multiple replicas need sticky routing for `/sse` and `/messages`.

```sh
docker compose logs -f netbird-mcp
docker compose down
```

## Connect an MCP host

For a remote connection, use `http://127.0.0.1:3000/mcp` (Streamable HTTP) or `http://127.0.0.1:3000/sse` (SSE) and send `Authorization: Bearer <MCP_AUTH_TOKEN>`. For example, in clients that support `mcpServers` with URL and header settings:

```json
{
  "mcpServers": {
    "netbird": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": {
        "Authorization": "Bearer REPLACE_WITH_MCP_AUTH_TOKEN"
      }
    }
  }
}
```

Replace `/mcp` with `/sse` for an SSE client. Its authorization header must be sent on both the stream GET and message POST requests. The project uses the official v2 `@modelcontextprotocol/server-legacy` adapter for this transport; the SDK marks it deprecated. `/mcp` uses the current v2 transport.

For **stdio through Docker**, build the image, then configure your host to launch it:

```sh
docker build -t netbird-mcp:local .
```

```json
{
  "mcpServers": {
    "netbird": {
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "--init",
        "--env-file",
        "/absolute/path/to/netbird-mcp/.env",
        "-e",
        "MCP_TRANSPORT=stdio",
        "netbird-mcp:local"
      ]
    }
  }
}
```

Keep `-i` and omit `-t`: stdout carries only MCP messages. Logs go to stderr. Stdio needs only the NetBird token; it does not require the MCP bearer token or an exposed port. The image defaults to stdio, while Compose defaults to SSE/server mode.

If your Docker daemon requires `DOCKER_HOST` or `DOCKER_CONTEXT`, pass those variables in the MCP host's process environment too; some hosts do not inherit your shell environment.

You can also launch a stdio process through Compose:

```sh
docker compose run --rm --no-deps -T -e MCP_TRANSPORT=stdio netbird-mcp
```

## Feature flags

`NETBIRD_READ_ONLY=true` removes all write tools, including domain validation (a NetBird GET endpoint with side effects). Set it to `false` to expose writes for enabled feature groups.

Every feature flag below defaults to `true`. Setting a flag to `false` prevents its tools from being registered, so they are neither listed nor callable on any transport. Configuration is read at startup; restart after editing `.env`.

| Environment flag                | Controls                                                              |
| ------------------------------- | --------------------------------------------------------------------- |
| `NETBIRD_ENABLE_PEERS`          | Peer information, accessible peers, updates, deletion, and jobs       |
| `NETBIRD_ENABLE_PEER_CONTROL`   | Peer updates, deletion, and job creation; peer reads remain available |
| `NETBIRD_ENABLE_GROUPS`         | Groups                                                                |
| `NETBIRD_ENABLE_POLICIES`       | Access policies                                                       |
| `NETBIRD_ENABLE_ROUTES`         | Routes                                                                |
| `NETBIRD_ENABLE_NETWORKS`       | Networks, network resources, and routers                              |
| `NETBIRD_ENABLE_DNS`            | Nameservers, settings, zones, and records                             |
| `NETBIRD_ENABLE_SETUP_KEYS`     | Setup keys                                                            |
| `NETBIRD_ENABLE_USERS`          | User listing, creation, updates, deletion, and current user           |
| `NETBIRD_ENABLE_ACCOUNTS`       | Account listing, updates, and deletion                                |
| `NETBIRD_ENABLE_EVENTS`         | Audit, traffic, and reverse proxy access logs                         |
| `NETBIRD_ENABLE_POSTURE_CHECKS` | Posture checks                                                        |
| `NETBIRD_ENABLE_REVERSE_PROXY`  | Reverse proxy services, domains, clusters, tokens, and access logs    |

For example, allow management of groups, policies, and other enabled areas while disabling peer control and all reverse proxy tools:

```dotenv
NETBIRD_READ_ONLY=false
NETBIRD_ENABLE_PEER_CONTROL=false
NETBIRD_ENABLE_REVERSE_PROXY=false
```

Peer writes require both peer flags. Reverse proxy logs require both the events and reverse proxy flags. These switches control this server's tool exposure; NetBird token permissions still apply. A disabled peer-control flag does not prevent enabled policy/group tools from changing network access.

Tools use explicit endpoints and validated request schemas, with no unrestricted HTTP request tool. Path parameters are top-level arguments, filters are under `query`, and write payloads are under `body`:

```json
{ "name": "netbird_list_peers", "arguments": { "query": { "name": "laptop" } } }
```

```json
{
  "name": "netbird_get_network_resource",
  "arguments": { "networkId": "network-id", "resourceId": "resource-id" }
}
```

```json
{
  "name": "netbird_create_group",
  "arguments": { "body": { "name": "developers", "peers": ["peer-id"] } }
}
```

Results contain JSON text and `structuredContent: { "data": ... }`. API failures return MCP tool errors with HTTP status. Calls have a timeout, propagate cancellation, refuse redirects, and limit responses to 10 MiB. Writes are never automatically retried.

Tool coverage is an explicit allowlist, not the entire NetBird API. Billing, identity-provider integrations, user-token management, bootstrap/setup, and other unlisted APIs are not exposed. Newer or cloud-only endpoints may return an upstream error on older/self-hosted NetBird deployments. Read an existing object before using PUT; some APIs require the complete payload.

## Other environment settings

See [.env.example](.env.example) for a complete starting configuration.

| Variable               | Default                      | Purpose                                                                    |
| ---------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| `NETBIRD_API_TOKEN`    | Required                     | NetBird API credential                                                     |
| `NETBIRD_API_URL`      | `https://api.netbird.io/api` | Management API base URL                                                    |
| `NETBIRD_TIMEOUT_MS`   | `30000`                      | Per-call timeout, up to 300000 ms                                          |
| `MCP_TRANSPORT`        | `stdio`                      | `stdio`, `sse`, or `http`; both network modes serve both endpoints         |
| `MCP_AUTH_TOKEN`       | Required in network mode     | Shared bearer token for MCP clients                                        |
| `MCP_HOST`             | `127.0.0.1`                  | Listener; Docker/Compose overrides to `0.0.0.0`                            |
| `MCP_PORT`             | `3000`                       | Listening port and Compose published port                                  |
| `MCP_BIND_ADDRESS`     | `127.0.0.1`                  | Compose-only host interface for port publishing                            |
| `MCP_ALLOWED_HOSTS`    | `localhost,127.0.0.1,[::1]`  | Allowed request hostnames, without scheme or port                          |
| `MCP_ALLOWED_ORIGINS`  | Empty                        | Exact comma-separated browser origins; requests without Origin are allowed |
| `MCP_MAX_SSE_SESSIONS` | `100`                        | Maximum simultaneous legacy SSE connections                                |

Boolean flags accept `true/false`, `1/0`, `yes/no`, and `on/off`, case-insensitively. Invalid configuration fails at startup. `/healthz` is a liveness endpoint and does not call NetBird. HTTP bodies are limited to 1 MiB. This is a shared-token service: all authenticated MCP clients use the same NetBird credential and feature settings.

## Development and tests

Application and catalog-generation code lives in `src/`; Bun tests live in `tests/`.

```sh
# Entire check suite in Docker; test execution needs no network or real credentials.
docker compose --profile test run --build --rm test

# Watch source changes in Docker (after configuring .env).
docker compose --profile dev up --build dev

# Run a single test file in Docker.
docker compose --profile test run --rm test bun test tests/transports.test.ts
```

For local Bun 1.4.2+ development:

```sh
bun install --frozen-lockfile
bun run check
bun run build
MCP_TRANSPORT=stdio bun run start
# Or use .env's network settings:
bun run dev
```

The tests exercise configuration, API authentication, path safety, error redaction, timeouts/cancellation, input validation, feature removal, real HTTP/SSE connections, real stdio subprocesses, and shutdown. NetBird responses are supplied by local fixtures; no live NetBird account is needed.

The checked-in [tool catalog](src/netbird/catalog.json) is generated from NetBird's OpenAPI schema at the revision recorded in [generate-catalog.ts](src/scripts/generate-catalog.ts). Regular builds are offline with respect to NetBird's schema. To update it, review the explicit route allowlist and pinned revision, then run:

```sh
bun run generate:catalog
# Or, after building the development image:
docker compose --profile dev run --rm --no-deps dev bun run generate:catalog
```

Review the generated diff and rerun checks before committing it. Attribution for the schema is in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## GitHub image publishing

[.github/workflows/image.yml](.github/workflows/image.yml) builds on branch pushes and pull requests. The Docker build runs formatting, TypeScript checks, and Bun tests before producing the runtime image.

Pushes to the repository's default branch publish `ghcr.io/<owner>/<repo>:latest` and a `sha-…` tag. Tags such as `v0.1.0` publish version tags (`0.1.0`, `0.1`) and a commit tag. Published images support `linux/amd64` and `linux/arm64`; pull requests build without publishing. Authentication uses GitHub's built-in `GITHUB_TOKEN` with `packages: write`.

After pushing this project to GitHub, replace `netbird-mcp:local` in your Docker client command with the GHCR image name. GitHub packages may initially be private; set the package visibility to public if anonymous pulls are desired. No registry credentials or NetBird secrets are needed in the workflow.
