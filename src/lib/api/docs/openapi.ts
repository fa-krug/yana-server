// src/lib/api/docs/openapi.ts
import { z } from "zod";

import { ApiErrorSchema } from "./schemas";
import { ENDPOINT_REGISTRY } from "./registry";
import { CONVENTIONS_MARKDOWN, OVERVIEW_MARKDOWN, TAG_DESCRIPTIONS } from "./narrative";

interface OpenApiOperation {
  summary: string;
  description: string;
  tags: string[];
  parameters?: Array<{ name: string; in: string; required: boolean; schema: unknown }>;
  requestBody?: { required: boolean; content: Record<string, { schema: unknown }> };
  responses: Record<
    string,
    { description: string; content?: Record<string, { schema: unknown }> }
  >;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
}

/** OpenAPI path templates use `{param}`; Next's route segments already match this exactly
 * (see `path` values in `registry.ts`, e.g. `/api/v1/articles/{id}`), so no translation step
 * is needed here. */
function toJsonSchema(schema: z.ZodType): unknown {
  return z.toJSONSchema(schema, { target: "openapi-3.0" });
}

function buildErrorsMarkdown(): string {
  const byCode = new Map<string, Array<{ method: string; path: string }>>();
  for (const endpoint of ENDPOINT_REGISTRY) {
    for (const err of endpoint.errors) {
      const list = byCode.get(err.code) ?? [];
      list.push({ method: endpoint.method, path: endpoint.path });
      byCode.set(err.code, list);
    }
  }
  const rows = [...byCode.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, occurrences]) => {
      const endpoints = occurrences.map((o) => `\`${o.method} ${o.path}\``).join(", ");
      return `| \`${code}\` | ${endpoints} |`;
    });
  return [
    "## Errors",
    "",
    'Every error takes the shape `{ "error": { "code": "...", "message": "..." } }`. ' +
      "`message` is server-authored prose for a human and never echoes anything the " +
      "caller submitted.",
    "",
    "| Code | Emitted by |",
    "|---|---|",
    ...rows,
  ].join("\n");
}

export function buildOpenApiDocument(): OpenApiDocument {
  const tagNames = [...new Set(ENDPOINT_REGISTRY.map((e) => e.tag))];

  const paths: OpenApiDocument["paths"] = {};
  for (const endpoint of ENDPOINT_REGISTRY) {
    const parameters: OpenApiOperation["parameters"] = [];
    if (endpoint.path.includes("{")) {
      for (const match of endpoint.path.matchAll(/\{(\w+)\}/g)) {
        parameters.push({
          name: match[1],
          in: "path",
          required: true,
          schema: { type: "string" },
        });
      }
    }
    if (endpoint.request?.query) {
      const queryShape = endpoint.request.query as z.ZodObject;
      for (const [name, fieldSchema] of Object.entries(queryShape.shape)) {
        parameters.push({
          name,
          in: "query",
          required: !fieldSchema.isOptional(),
          schema: toJsonSchema(fieldSchema),
        });
      }
    }

    const responses: OpenApiOperation["responses"] = {};
    responses[String(endpoint.response.status)] = {
      description: endpoint.response.description,
      ...(endpoint.response.schema
        ? {
            content: {
              [endpoint.response.contentType ?? "application/json"]: {
                schema: toJsonSchema(endpoint.response.schema),
              },
            },
          }
        : {}),
    };
    for (const err of endpoint.errors) {
      responses[String(err.status)] = {
        description: err.when,
        content: { "application/json": { schema: toJsonSchema(ApiErrorSchema) } },
      };
    }

    const operation: OpenApiOperation = {
      summary: endpoint.summary,
      description: endpoint.description,
      tags: [endpoint.tag],
      responses,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(endpoint.request?.body
        ? {
            requestBody: {
              required: true,
              content: { "application/json": { schema: toJsonSchema(endpoint.request.body) } },
            },
          }
        : {}),
    };

    paths[endpoint.path] ??= {};
    paths[endpoint.path][endpoint.method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "Yana Client API",
      version: "1",
      description: [OVERVIEW_MARKDOWN, buildErrorsMarkdown(), CONVENTIONS_MARKDOWN].join("\n\n"),
    },
    tags: tagNames.map((name) => ({ name, description: TAG_DESCRIPTIONS[name] ?? "" })),
    paths,
  };
}
