import type { JsonSchemaType } from "@modelcontextprotocol/server";
import type { Feature } from "../config.ts";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ToolDefinition {
  name: string;
  description: string;
  method: Method;
  path: string;
  features: Feature[];
  write: boolean;
  queryParameters: { name: string; explode: boolean }[];
  inputSchema: JsonSchemaType;
}

export type QueryValue =
  string | number | boolean | (string | number | boolean)[];
export interface ToolArguments {
  [key: string]: unknown;
  query?: Record<string, QueryValue>;
  body?: unknown;
}
