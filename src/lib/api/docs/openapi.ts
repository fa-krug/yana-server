// src/lib/api/docs/openapi.ts
import { z } from "zod";

import { ApiErrorSchema } from "./schemas";
import { ENDPOINT_REGISTRY } from "./registry";
import type { EndpointDoc } from "./define";
import { CONVENTIONS_MARKDOWN, OVERVIEW_MARKDOWN, TAG_DESCRIPTIONS } from "./narrative";

interface ContentEntry {
  schema: unknown;
  examples?: Record<string, { value: unknown }>;
}

interface OpenApiOperation {
  summary: string;
  description: string;
  tags: string[];
  parameters?: Array<{ name: string; in: string; required: boolean; schema: unknown }>;
  requestBody?: { required: boolean; content: Record<string, ContentEntry> };
  responses: Record<string, { description: string; content?: Record<string, ContentEntry> }>;
  security?: Array<Record<string, never[]>>;
}

export interface OpenApiDocument {
  openapi: "3.1.0";
  info: { title: string; version: string; description: string };
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
  components: {
    securitySchemes: Record<string, Record<string, string>>;
  };
}

/**
 * Maps the registry's five-way `EndpointDoc.auth` distinction down to the
 * `security` an OpenAPI operation declares. OpenAPI's security model doesn't
 * need a 1:1 mapping to the registry's finer distinction (Bearer-authoritative
 * vs. Bearer-only, for instance, are both "send a Bearer token" as far as a
 * client generator or Scalar's UI is concerned):
 * - "bearer-or-cookie" / "bearer-only" -> `bearerAuth`.
 * - "session-cookie" -> `cookieAuth`.
 * - "one-time-token" -> no standard scheme (it's a query-string token, not a
 *   header or cookie) -- callers instead get a sentence in the operation's own
 *   description; see `oneTimeTokenNote` below.
 * - "none" -> an explicit empty `security: []`, distinguishing "no auth" from
 *   "not yet documented."
 */
function securityFor(auth: EndpointDoc["auth"]): OpenApiOperation["security"] | undefined {
  switch (auth) {
    case "bearer-or-cookie":
    case "bearer-only":
      return [{ bearerAuth: [] }];
    case "session-cookie":
      return [{ cookieAuth: [] }];
    case "one-time-token":
      return undefined;
    case "none":
      return [];
  }
}

const ONE_TIME_TOKEN_NOTE =
  "\n\n**Auth note:** the one-time token is passed as a `token` query parameter, not a " +
  "header or cookie -- there is no standard OpenAPI security scheme for that, so it isn't " +
  "reflected in this operation's `security`.";

/** Turns an `endpoint.example` entry into the `examples` map a `ContentEntry` takes. */
function exampleEntry(value: unknown): Record<string, { value: unknown }> | undefined {
  return value === undefined ? undefined : { default: { value } };
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

    const responseExamples = exampleEntry(endpoint.example?.response);
    const responses: OpenApiOperation["responses"] = {};
    responses[String(endpoint.response.status)] = {
      description: endpoint.response.description,
      ...(endpoint.response.schema
        ? {
            content: {
              [endpoint.response.contentType ?? "application/json"]: {
                schema: toJsonSchema(endpoint.response.schema),
                ...(responseExamples ? { examples: responseExamples } : {}),
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

    const security = securityFor(endpoint.auth);
    const requestExamples = exampleEntry(endpoint.example?.request);

    const operation: OpenApiOperation = {
      summary: endpoint.summary,
      description:
        endpoint.description + (endpoint.auth === "one-time-token" ? ONE_TIME_TOKEN_NOTE : ""),
      tags: [endpoint.tag],
      responses,
      ...(security !== undefined ? { security } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(endpoint.request?.body
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: toJsonSchema(endpoint.request.body),
                  ...(requestExamples ? { examples: requestExamples } : {}),
                },
              },
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
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        cookieAuth: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
      },
    },
  };
}
