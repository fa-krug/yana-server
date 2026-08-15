# API documentation: generated, drift-checked, rendered in-app

## Goal

`/api/v1/**` (13 routes) plus the three flows a native-client author needs to
reach it (`/device/pair`, `/webview-session-token`, `/webview-session`) have no
documentation today beyond the design record
(`docs/superpowers/specs/2026-08-03-client-api-design.md`, which predates
several routes and is a decision log, not reference material) and the route
source itself. This spec adds a generated OpenAPI 3.1 document, rendered as a
browsable in-app reference, with a CI check that fails when the document
drifts from the routes it describes.

Explicitly out of scope: the web-UI-internal SSE routes
(`/api/jobs/status-stream`, `/api/jobs/[id]/log-stream`,
`/api/runs/[id]/status-stream`), `/api/feeds/export`, `/media/avatars/**`, and
anything under `/api/auth/**` (Better Auth's own surface, documented
upstream). These are implementation detail of the web UI, not the client
contract, and are free to change without a compatibility conversation.

## Why generated rather than hand-written

Two guarantees this repo already relies on elsewhere (`defineIntegration()`'s
compiler-checked fields, the `en.json`/`de.json` parity test) come from making
an omission a build failure rather than a discipline problem. Hand-written
Markdown with a "does every route have an entry" CI check catches a missing
*endpoint*; it cannot catch a *field* the code returns that the doc doesn't
mention, or the reverse. Since `zod` 4.4.3 is already a pinned dependency and
ships `z.toJSONSchema()` natively, schema-driven generation costs no new
runtime dependency for the spec itself — only for the rendering.

## 1. Schema layer (`src/lib/api/docs/schemas.ts`)

One zod schema per wire shape used anywhere in `/api/v1/**`:
`ArticleSummarySchema`, `FeedSchema`, `TagSchema`, `ReadingPositionSchema`,
`SyncPageSchema` (the three-cursor `new`/`updated`/`removed` envelope),
`RunSchema`, the SSE event payload union, `ApiErrorSchema` (the
`{ error: { code, message } }` envelope every route already shares via
`apiErrorResponse()`), and the request-body schemas currently declared
route-locally (today: `reading-position`'s `patchBody`, `articles/[id]`'s PATCH
body).

**`src/lib/api/serializers.ts` inverts to consume these**, rather than
declaring interfaces independently:

```ts
export type ArticleSummaryWire = z.infer<typeof ArticleSummarySchema>;
```

The exported type name and every consumer's import stay unchanged — this is a
one-file change with no call-site churn. What changes is the guarantee:
`serializeArticleSummary()` returning a field `ArticleSummarySchema` doesn't
declare, or vice versa, is now a `tsc` error instead of something only a
reviewer's attention catches.

**Request schemas move the opposite direction**: a route imports its body
schema *from* `schemas.ts` instead of declaring it inline, so the schema the
docs describe and the schema the route validates against are the same object,
not two values a test has to prove equal.

## 2. Registry (`src/lib/api/docs/define.ts` + `registry.ts`)

Follows the `defineIntegration()` shape already established in
`src/lib/integrations/define.ts`: one declaration per endpoint, required
fields the compiler enforces, no annotation living inside route files (a
Next.js route module may only export HTTP method handlers and segment
config — anything else is unsupported surface).

```ts
export interface EndpointDoc<Req extends z.ZodType, Res extends z.ZodType> {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;                 // "/api/v1/reading-position"
  tag: string;                  // groups endpoints in the rendered nav
  summary: string;
  description: string;          // markdown; the "why", not a restatement of the path
  auth: "bearer-or-cookie" | "bearer-only" | "one-time-token" | "none";
  request?: { query?: z.ZodType; body?: Req };
  response: { status: number; schema: Res; description: string };
  errors: Array<{ status: number; code: string; when: string }>;
  example?: { request?: unknown; response: unknown };
}

export function defineEndpoint<Req extends z.ZodType, Res extends z.ZodType>(
  doc: EndpointDoc<Req, Res>,
): EndpointDoc<Req, Res> {
  return doc;
}
```

`auth` is a closed union rather than a boolean or free text because the four
cases are genuinely different contracts already established in
`src/lib/api/auth.ts`: `requireApiUser()` (Bearer authoritative, cookie
fallback — what most `/api/v1/**` routes use), `requireApiBearerSession()`
(Bearer only, no cookie fallback — `webview-session-token`, and the reason is
load-bearing per that module's own comment), `one-time-token`
(`/webview-session`'s query-string token), and `none` (`/health`). Collapsing
these into "requires auth: yes/no" would document away a distinction the code
spends real effort establishing.

`registry.ts` holds one `defineEndpoint()` call per documented route (16
total: 13 under `/api/v1`, plus `/device/pair`, `/webview-session-token`,
`/webview-session`).

## 3. OpenAPI generation (`src/lib/api/docs/openapi.ts`)

`buildOpenApiDocument()` walks the registry and emits an OpenAPI 3.1 document:
per-endpoint `parameters`/`requestBody`/`responses` from each schema via
`z.toJSONSchema()`, `tags` with their narrative `description` (Section 4), and
a shared `ApiError` component schema referenced by every documented error
response.

`npm run docs:api` writes the result to `docs/api/openapi.json` (committed).
`npm run docs:api:check` rebuilds into memory and diffs against the committed
file, failing non-zero on any difference — the same shape as
`format`/`format:check`. Added to the CI command line alongside
lint/format:check/typecheck/test. A contract change then shows up as a diff in
code review, and the file is fetchable from git without a running server (for
Swift codegen, Postman import, etc.).

## 4. Narrative content (`src/lib/api/docs/narrative.ts`)

Markdown strings attached to `info.description` (top-level) and per-tag
`description` fields — not separate `.md` files, so the prose describing a
flow and the endpoint list for that flow cannot drift apart:

- **Overview** — what the API is for, base URL, versioning stance (`v1` is
  the only version so far).
- **Auth & pairing** (tag on `/device/pair`) — the Bearer-token model, cookie
  vs. Bearer precedence in `requireApiUser()`, token lifetime.
- **Sync protocol** (tag on `/articles/sync`) — the three independently
  cursored streams, `limit` clamping (1–500, default 200, and why an absent
  vs. garbage `limit` are distinguished before `Number()`), opaque cursor
  semantics.
- **SSE events** (tag on `/jobs/events`) — event types including
  `readingPosition`, expected reconnection behaviour.
- **Errors** — the `{ error: { code, message } }` envelope and the no-echo
  rule (`message` is server-authored prose only, never a value the caller
  submitted — mirroring `ProbeResult.detail`'s existing rule), plus a table of
  every `code` in the registry cross-referenced with the endpoints that emit
  it, generated from each endpoint's `errors[]` rather than hand-listed a
  second time.
- **Conventions** — ISO 8601 dates, pagination/limit conventions, `404` used
  for "not found or not yours" (never `403`, matching the existing
  `requireAdmin()`/media-route precedent).

**English only, by explicit exception.** This is developer reference
material, not product UI, so it does not go through `messages/en.json` /
`de.json` and the parity test does not apply to it. Called out here so it
reads as a decision, not an oversight against a repo-wide rule.

## 5. Rendering

- `src/app/(app)/api-docs/page.tsx` — inside `(app)`, so `requireUser()`
  already gates it via the layout and sidebar/breadcrumb chrome comes free.
  Added to `UNLISTED_ROUTES` in `src/lib/nav.ts` (same treatment as
  `/account`) rather than `NAV_ITEMS`, and linked from `/settings`'s About
  section — this is reference material, not a primary workflow, so it doesn't
  need a permanent sidebar slot.
- `GET /api/v1/openapi.json` — a route handler returning
  `buildOpenApiDocument()` as JSON. Calls `requireUser()` itself as its first
  statement (same pattern as `media/avatars/[userId]/route.ts` — a route
  handler has no layout above it enforcing anything), so the spec is only
  reachable to a signed-in user, matching the earlier "in-app, signed-in
  only" decision. No `proxy.ts` / `PUBLIC_PREFIXES` change needed, since the
  session check happens inside the handler rather than relying on the proxy's
  cookie-presence check.
- `@scalar/nextjs-api-reference` (pinned exact, per this repo's no-`^`/`~`
  policy — confirmed `next: ^15||^16, react: ^19` peer ranges, both satisfied)
  renders the fetched spec client-side. The page component is a thin wrapper;
  `package-lock.json` regenerated via `npm install` per the pinning
  convention.

## 6. Completeness enforcement

`src/lib/api/docs/registry.test.ts`: walks `src/app/api/v1/**/route.ts` plus
the three flow routes via `fs`, collects every exported HTTP method per file,
and asserts the registry has a matching `defineEndpoint()` for each
`(method, path)` pair. An endpoint added to the app with no registry entry
fails this test — the same tripwire shape as `src/instrumentation.test.ts`'s
import-list regex check. Written first (red), then filled in per Section 2
until green, per this repo's TDD convention.

## Rollout order

1. `schemas.ts` + inverted `serializers.ts` — mechanical, `npm test` proves
   nothing broke.
2. `define.ts` + `registry.ts`, with `registry.test.ts` written first (red)
   and filled in to green across all 16 routes.
3. `openapi.ts` + `docs:api`/`docs:api:check` scripts + committed
   `docs/api/openapi.json` + CI wiring.
4. `narrative.ts` content.
5. `/api-docs` page + `openapi.json` route + `@scalar/nextjs-api-reference`
   pin.

## Testing

- `registry.test.ts` (Section 6) — completeness.
- `schemas.test.ts` — each schema round-trips a real serializer output (e.g.
  `ArticleSummarySchema.parse(serializeArticleSummary(realArticleRow))`
  doesn't throw), catching the direction `tsc` can't: a schema too loose to
  reject a bad shape.
- `openapi.test.ts` — `buildOpenApiDocument()` produces valid OpenAPI 3.1
  (structural checks: every path has a response, every `$ref` resolves).
- `docs:api:check` behaviour covered by a node test that stales the committed
  file and asserts the script exits non-zero.
- `(app)/api-docs/page.test.tsx` — jsdom render, gated same as every other
  `(app)` page (see the layout tests' pattern), asserting only that the page
  renders without a session redirect and hands a spec URL to the viewer
  component — not a Scalar internals test.

## Explicitly out of scope

- i18n for the docs content (Section 4).
- Contract/integration tests that hit real routes and validate live responses
  against the generated schema (a natural follow-up, not required for this
  phase — the schema-inversion guarantee in Sections 1 and 6 is the mechanism
  this phase relies on).
- A public (unauthenticated) docs page.
- Documenting Better Auth's own `/api/auth/**` endpoints or the web-UI-internal
  SSE/export/media routes (see Goal).
