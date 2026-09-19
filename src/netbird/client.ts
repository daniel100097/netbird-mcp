import type { Config } from "../config.ts";
import type { ToolArguments, ToolDefinition } from "./types.ts";

export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
export type Fetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class NetBirdApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "NetBirdApiError";
  }
}

async function readResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new NetBirdApiError(
          "NetBird response exceeds the 10 MiB limit; narrow the query",
        );
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

export class NetBirdClient {
  constructor(
    private readonly config: Pick<
      Config,
      "apiUrl" | "apiToken" | "apiTimeoutMs"
    >,
    private readonly fetcher: Fetch = fetch,
  ) {}

  async request(
    tool: ToolDefinition,
    args: ToolArguments,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const path = tool.path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
      const value = args[name];
      if (
        typeof value !== "string" ||
        !value ||
        /[/\\%?#\s]/.test(value) ||
        value === "." ||
        value === ".."
      ) {
        throw new NetBirdApiError(`Invalid path parameter: ${name}`);
      }
      return encodeURIComponent(value);
    });
    const url = new URL(this.config.apiUrl + path);
    for (const parameter of tool.queryParameters) {
      const value = args.query?.[parameter.name];
      if (value === undefined) continue;
      const values = Array.isArray(value) ? value : [value];
      if (parameter.explode)
        for (const item of values)
          url.searchParams.append(parameter.name, String(item));
      else url.searchParams.set(parameter.name, values.join(","));
    }
    const timeout = AbortSignal.timeout(this.config.apiTimeoutMs);
    try {
      const response = await this.fetcher(url, {
        method: tool.method,
        headers: {
          Authorization: `Token ${this.config.apiToken}`,
          Accept: "application/json",
          ...(args.body !== undefined
            ? { "Content-Type": "application/json" }
            : {}),
        },
        ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
        // Never replay credentials or a write to a redirect destination.
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const text = await readResponse(response);
      if (!response.ok) {
        let detail = "";
        try {
          const data: unknown = JSON.parse(text);
          if (
            data &&
            typeof data === "object" &&
            "message" in data &&
            typeof data.message === "string"
          ) {
            detail =
              ": " +
              data.message
                .replaceAll(this.config.apiToken, "[redacted]")
                .replace(/[\r\n\t]/g, " ")
                .slice(0, 500);
          }
        } catch {
          /* Non-JSON error bodies may contain proxy internals; omit them. */
        }
        throw new NetBirdApiError(
          `NetBird API returned HTTP ${response.status}${detail}`,
          response.status,
        );
      }
      if (!text.trim()) return { success: true };
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new NetBirdApiError(
          "NetBird API returned invalid JSON",
          response.status,
        );
      }
    } catch (error) {
      if (error instanceof NetBirdApiError) throw error;
      if (signal?.aborted)
        throw new NetBirdApiError("NetBird request cancelled");
      if (timeout.aborted)
        throw new NetBirdApiError(
          `NetBird request timed out after ${this.config.apiTimeoutMs} ms`,
        );
      throw new NetBirdApiError(
        "Unable to reach NetBird API (network, TLS, or redirect error)",
      );
    }
  }
}
