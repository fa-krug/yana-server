import { z } from "zod";

import {
  AiPromptResponseSchema,
  ApiEventPayloadSchema,
  ArticleContentSchema,
  ArticlePatchBodySchema,
  ArticleSummarySchema,
  FeedSchema,
  JobSchema,
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
    example: {
      request: { starred: true },
      response: {
        id: 1,
        feedId: 2,
        name: "An article headline",
        identifier: "https://example.com/articles/an-article-headline",
        date: "2026-08-10T12:00:00.000Z",
        author: "Jane Doe",
        icon: null,
        read: false,
        starred: true,
        createdAt: "2026-08-10T12:05:00.000Z",
        updatedAt: "2026-08-15T09:30:00.000Z",
      },
    },
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
    path: "/api/v1/jobs/{id}",
    tag: "Jobs",
    summary: "Poll one job's progress",
    description:
      "The durable state of a single job, including the `article.reload` job " +
      "`POST /api/v1/articles/{id}/reload` returns. Such a job has `runId: null` and is " +
      "invisible to `GET /api/v1/runs/{id}`. `progress` is the progress signal (0-100); " +
      "`status` says whether the work has ended and whether it succeeded. Unlike the SSE " +
      "stream this can be asked again at any time, so a client that was offline, or was " +
      "restarted, can still learn how its job ended.",
    auth: "bearer-or-cookie",
    response: { status: 200, schema: JobSchema, description: "The job's current state." },
    errors: [
      { status: 401, code: "unauthorized", when: "no valid Bearer token or session." },
      {
        status: 404,
        code: "not_found",
        when: "the job doesn't exist, or isn't owned by the caller.",
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
      schema: ApiEventPayloadSchema,
      description:
        "One event per SSE `data:` frame -- the bare payload only; the event name " +
        "(`job`/`run`/`readingPosition`) is carried in the SSE `event:` line, never in the " +
        "JSON body. See the SSE events overview.",
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

  defineEndpoint({
    method: "POST",
    path: "/api/v1/ai/prompt",
    tag: "AI",
    summary: "Run a free-form prompt against the caller's configured AI provider",
    description:
      "Runs `prompt` against the caller's active AI provider using their stored credentials " +
      "and global tuning values -- no per-request overrides. Subject to the caller's daily " +
      "and monthly AI request limits.",
    auth: "bearer-or-cookie",
    request: { body: z.object({ prompt: z.string().min(1) }) },
    response: {
      status: 200,
      schema: AiPromptResponseSchema,
      description: "The provider's response.",
    },
    errors: [
      { status: 400, code: "invalid_prompt", when: "prompt is missing or empty." },
      { status: 400, code: "prompt_too_long", when: "prompt exceeds the configured length limit." },
      { status: 401, code: "unauthorized", when: "no valid Bearer token or session." },
      { status: 409, code: "no_active_provider", when: "no AI provider is configured." },
      {
        status: 502,
        code: "provider_unauthorized",
        when: "the configured provider rejected the stored credentials.",
      },
      { status: 502, code: "provider_error", when: "the provider could not fulfil the prompt." },
    ],
  }),

  defineEndpoint({
    method: "POST",
    path: "/api/v1/auth/webview-session-token",
    tag: "Auth & pairing",
    summary: "Mint a one-time token to bootstrap a ManagementWebView session",
    description:
      "Mints a short-lived, single-use token bound to the caller's own device session, for " +
      "immediate exchange at `GET /webview-session` inside a `WKWebView` -- lets the native " +
      "client reach the web UI's cookie session without ever handling a password or passkey " +
      "in a webview. See the Auth & pairing overview.",
    auth: "bearer-only",
    response: {
      status: 200,
      schema: z.object({ token: z.string(), expiresAt: z.iso.datetime() }),
      description: "The one-time token and its expiry.",
    },
    errors: [
      { status: 401, code: "unauthorized", when: "no valid Bearer device-session token." },
    ],
  }),

  defineEndpoint({
    method: "GET",
    path: "/device/pair",
    tag: "Auth & pairing",
    summary: "Mint a device session and redirect back to the native app",
    description:
      "Reached from `/login`'s `next` parameter after the user signs in through the ordinary " +
      "web form inside the native app's pairing webview. Mints a new device session and " +
      "redirects to `<scheme>://auth-callback?token=...&state=...`, echoing back the caller- " +
      "supplied `state` unchanged -- CSRF protection is the app's own responsibility, not this " +
      "route's. See the Auth & pairing overview for the full pairing flow.",
    auth: "session-cookie",
    request: {
      query: z.object({
        state: z.string().min(1),
        scheme: z.string().optional().describe('Defaults to "yana"; only "yana" is accepted.'),
        deviceName: z.string().optional().describe("Truncated to 64 characters if longer."),
      }),
    },
    response: {
      status: 307,
      schema: null,
      description: "Redirect to the native app's registered custom URL scheme.",
    },
    errors: [
      {
        status: 400,
        code: "no_code_empty_body",
        when:
          "state is missing, or scheme is not an allowed scheme -- a plain 400 with no " +
          "JSON error body.",
      },
    ],
  }),

  defineEndpoint({
    method: "GET",
    path: "/webview-session",
    tag: "Auth & pairing",
    summary: "Exchange a one-time token for a real session cookie",
    description:
      "The `ManagementWebView` landing point: verifies the token minted by " +
      "`POST /api/v1/auth/webview-session-token`, sets a real session cookie for that exact " +
      "device session, and redirects to `next` (validated same-origin, default `/feeds`). Any " +
      "missing, invalid, expired or already-used token falls back to `/login?next=...`, " +
      "indistinguishable from a plain signed-out visit.",
    auth: "one-time-token",
    request: {
      query: z.object({
        token: z.string(),
        next: z.string().optional().describe("A same-origin path; defaults to /feeds."),
      }),
    },
    response: {
      status: 302,
      schema: null,
      description: "Redirect to `next` with the session cookie set, or to /login on failure.",
    },
    errors: [],
  }),

  defineEndpoint({
    method: "GET",
    path: "/api/v1/openapi.json",
    tag: "Meta",
    summary: "Fetch this OpenAPI document",
    description:
      "Returns the OpenAPI 3.1 document describing this entire API -- what `/api-docs` " +
      "renders. Signed-in only, same as the rendered reference page.",
    // The route (`src/app/api/v1/openapi.json/route.ts`) calls `requireUser()`, the ordinary
    // signed-in-user session -- not `requireApiUser()` -- so unlike every other /api/v1 route
    // there is no Bearer path here at all: this is documentation reachable from inside the
    // app, not a client-API data endpoint.
    auth: "session-cookie",
    response: {
      status: 200,
      // The document's own shape isn't itself one of this registry's zod schemas, so `null`
      // documents it the same way `images/{hash}`'s non-JSON-schema-able response does.
      schema: null,
      description: "The OpenAPI 3.1 document as JSON.",
    },
    errors: [{ status: 401, code: "unauthorized", when: "no valid session (redirects to /login)." }],
  }),
];
