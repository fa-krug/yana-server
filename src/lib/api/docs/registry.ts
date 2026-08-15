import { z } from "zod";

import {
  ArticleContentSchema,
  ArticlePatchBodySchema,
  ArticleSummarySchema,
  FeedSchema,
  SyncPageSchema,
  SyncResyncRequiredSchema,
  TagSchema,
} from "./schemas";
import { defineEndpoint, type EndpointDoc } from "./define";

export const ENDPOINT_REGISTRY: EndpointDoc[] = [
  defineEndpoint({
    method: "GET",
    path: "/api/v1/feeds",
    tag: "Feeds",
    summary: "List the caller's feeds",
    description:
      "Returns every feed owned by the caller, each carrying its `tagIds` so the " +
      "client can render feed/tag associations without a second round trip per feed.",
    auth: "bearer-or-cookie",
    response: {
      status: 200,
      schema: z.object({ feeds: z.array(FeedSchema) }),
      description: "The caller's feeds.",
    },
    errors: [{ status: 401, code: "unauthorized", when: "no valid Bearer token or session." }],
  }),

  defineEndpoint({
    method: "GET",
    path: "/api/v1/tags",
    tag: "Tags",
    summary: "List the caller's tags",
    description: "Returns every tag owned by the caller.",
    auth: "bearer-or-cookie",
    response: {
      status: 200,
      schema: z.object({ tags: z.array(TagSchema) }),
      description: "The caller's tags.",
    },
    errors: [{ status: 401, code: "unauthorized", when: "no valid Bearer token or session." }],
  }),

  defineEndpoint({
    method: "GET",
    path: "/api/v1/articles/sync",
    tag: "Sync",
    summary: "Delta-sync articles across three independently cursored streams",
    description:
      "Returns `new`, `updated` and `removed` deltas since the given `cursor`, scoped to the " +
      "caller's own feeds. See the Sync protocol overview for the cursor and resync model.",
    auth: "bearer-or-cookie",
    request: {
      query: z.object({
        cursor: z.string().optional().describe("Opaque cursor from a prior response's nextCursor."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Max rows per stream per call. Default 200, clamped to [1, 500]."),
      }),
    },
    response: {
      status: 200,
      schema: z.union([SyncPageSchema, SyncResyncRequiredSchema]),
      description:
        "A sync page, or `{ resyncRequired: true }` when the cursor is older than the " +
        "retention job's tombstone-prune horizon and a full resync is required.",
    },
    errors: [{ status: 401, code: "unauthorized", when: "no valid Bearer token or session." }],
    example: {
      request: { cursor: null, limit: 200 },
      response: { new: [], updated: [], removed: [], nextCursor: "eyJuZXdQb3MiOlswLDBdfQ" },
    },
  }),

  defineEndpoint({
    method: "PATCH",
    path: "/api/v1/articles/{id}",
    tag: "Articles",
    summary: "Set an article's read/starred state",
    description:
      "Updates `read` and/or `starred` on one article owned by the caller. At least one of " +
      "the two fields is required.",
    auth: "bearer-or-cookie",
    request: { body: ArticlePatchBodySchema },
    response: {
      status: 200,
      schema: ArticleSummarySchema,
      description: "The article after the update.",
    },
    errors: [
      { status: 400, code: "invalid_body", when: "neither starred nor read was provided." },
      { status: 401, code: "unauthorized", when: "no valid Bearer token or session." },
      {
        status: 404,
        code: "not_found",
        when: "the article doesn't exist, or its feed isn't owned by the caller.",
      },
    ],
    example: { request: { starred: true }, response: null },
  }),

  defineEndpoint({
    method: "GET",
    path: "/api/v1/articles/{id}/content",
    tag: "Articles",
    summary: "Fetch an article's rendered content blocks",
    description:
      "Returns the article's content as a Yana wire-format document (version + block tree). " +
      "See the Content format overview for the block union.",
    auth: "bearer-or-cookie",
    response: {
      status: 200,
      schema: ArticleContentSchema,
      description: "The article's content blocks.",
    },
    errors: [
      { status: 401, code: "unauthorized", when: "no valid Bearer token or session." },
      {
        status: 404,
        code: "not_found",
        when: "the article doesn't exist, or its feed isn't owned by the caller.",
      },
    ],
  }),

  defineEndpoint({
    method: "POST",
    path: "/api/v1/articles/{id}/reload",
    tag: "Articles",
    summary: "Re-fetch and re-extract one article",
    description:
      "Enqueues an `article.reload` job for one caller-owned article -- the same job the web " +
      "UI's bulk reload action uses, here scoped to a single article via the API.",
    auth: "bearer-or-cookie",
    response: {
      status: 202,
      schema: z.object({ jobId: z.number().int() }),
      description: "The id of the enqueued job.",
    },
    errors: [
      { status: 401, code: "unauthorized", when: "no valid Bearer token or session." },
      {
        status: 404,
        code: "not_found",
        when: "the article doesn't exist, or its feed isn't owned by the caller.",
      },
    ],
  }),
];
