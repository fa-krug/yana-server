import { z } from "zod";

import {
  ApiEventSchema,
  ArticleContentSchema,
  ArticlePatchBodySchema,
  ArticleSummarySchema,
  FeedSchema,
  ReadingPositionPatchBodySchema,
  ReadingPositionSchema,
  RunSchema,
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

  defineEndpoint({
    method: "POST",
    path: "/api/v1/aggregate",
    tag: "Runs",
    summary: "Trigger aggregation now",
    description:
      "Enqueues one `aggregate` job per caller-owned enabled feed, grouped under a single " +
      "run. A caller with zero enabled feeds still gets a run back, already completed with " +
      "`totalJobs: 0` -- `runId` is always a real, non-null id.",
    auth: "bearer-or-cookie",
    response: {
      status: 202,
      schema: z.object({ runId: z.number().int() }),
      description: "The id of the created run.",
    },
    errors: [{ status: 401, code: "unauthorized", when: "no valid Bearer token or session." }],
  }),

  defineEndpoint({
    method: "GET",
    path: "/api/v1/runs/{id}",
    tag: "Runs",
    summary: "Poll a run's progress",
    description:
      "The poll target for a run created by `POST /api/v1/aggregate`. Prefer " +
      "`GET /api/v1/jobs/events` for live progress; this is the always-available fallback.",
    auth: "bearer-or-cookie",
    response: { status: 200, schema: RunSchema, description: "The run's current counters." },
    errors: [
      { status: 401, code: "unauthorized", when: "no valid Bearer token or session." },
      {
        status: 404,
        code: "not_found",
        when: "the run doesn't exist, or isn't owned by the caller.",
      },
    ],
  }),

  defineEndpoint({
    method: "GET",
    path: "/api/v1/jobs/events",
    tag: "Jobs",
    summary: "Live job/run/reading-position notifications (SSE)",
    description:
      "A long-lived `text/event-stream` connection carrying `job`, `run` and " +
      "`readingPosition` events for the caller, in place of polling " +
      "`GET /api/v1/runs/{id}`. Best-effort: a dropped connection loses only low-latency " +
      "notification, never data -- the `jobs`/`runs` tables and " +
      "`GET /api/v1/reading-position` remain the source of truth to fall back to. See the " +
      "SSE events overview for the payload shapes and reconnection guidance.",
    auth: "bearer-or-cookie",
    response: {
      status: 200,
      schema: ApiEventSchema,
      description: "One event per SSE `data:` frame (see the SSE events overview).",
      contentType: "text/event-stream",
    },
    errors: [{ status: 401, code: "unauthorized", when: "no valid Bearer token or session." }],
  }),

  defineEndpoint({
    method: "GET",
    path: "/api/v1/images/{hash}",
    tag: "Images",
    summary: "Fetch a feed logo, article image, or embed thumbnail by content hash",
    description:
      "Serves image bytes by their SHA-256 content hash (64 lowercase hex chars). Used by " +
      "both the native client and the web UI's own `<img>` tags. A hash is reachable through " +
      "any of three independent paths -- a caller-owned feed's logo, a caller-owned article's " +
      "body image, or an embed thumbnail -- and a hash owned only by a different user 404s " +
      "exactly as a nonexistent one would.",
    auth: "bearer-or-cookie",
    response: {
      status: 200,
      schema: null,
      description: "The raw image bytes, with the stored Content-Type.",
      contentType: "image/*",
    },
    errors: [
      { status: 401, code: "unauthorized", when: "no valid Bearer token or session." },
      {
        status: 404,
        code: "not_found",
        when: "the hash is malformed, unknown, or not reachable through the caller's own feeds.",
      },
    ],
  }),

  defineEndpoint({
    method: "GET",
    path: "/api/v1/reading-position",
    tag: "Reading position",
    summary: "Get the cross-device current-article pointer",
    description:
      "Returns the caller's current reading position, or `{ articleId: null, updatedAt: null " +
      "}` if it was never set.",
    auth: "bearer-or-cookie",
    response: {
      status: 200,
      schema: ReadingPositionSchema,
      description: "The current pointer.",
    },
    errors: [{ status: 401, code: "unauthorized", when: "no valid Bearer token or session." }],
  }),

  defineEndpoint({
    method: "PATCH",
    path: "/api/v1/reading-position",
    tag: "Reading position",
    summary: "Set the cross-device current-article pointer",
    description:
      "Sets the pointer to `articleId`, stamping `updatedAt` with the server's clock. " +
      "Last-writer-wins across devices. Publishes a `readingPosition` SSE event to every " +
      "other open `GET /api/v1/jobs/events` connection for the caller.",
    auth: "bearer-or-cookie",
    request: { body: ReadingPositionPatchBodySchema },
    response: {
      status: 200,
      schema: ReadingPositionSchema,
      description: "The pointer after the update.",
    },
    errors: [
      { status: 400, code: "invalid_body", when: "articleId is missing or not an integer." },
      { status: 401, code: "unauthorized", when: "no valid Bearer token or session." },
      {
        status: 404,
        code: "not_found",
        when: "the article doesn't exist, or its feed isn't owned by the caller.",
      },
    ],
  }),
];
