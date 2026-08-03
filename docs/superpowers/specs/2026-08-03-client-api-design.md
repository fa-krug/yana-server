# Client API Design (Phase 13)

**Status:** approved design, ready for planning.

**Supersedes the "open questions" in** `2026-07-30-nextjs-migration-direction.md` and
`docs/superpowers/plans/nextjs-13-client-api.md`. All nine previously-open questions
are resolved below. Rewrite `nextjs-13-client-api.md` from this document rather than
from its own stale draft.

## Goal

A tailored HTTP API for the first-party iOS/macOS client: paginated + incremental
article sync, feed and tag listing, star/read toggling, on-demand aggregation and
per-article reload with completion notification, and content-addressed image
serving (article images and feed logos alike). Multi-tenant throughout — every
query scoped to the authenticated user, no exceptions.

There is currently no client API at all (the retired Django app never had one
beyond a health check), so everything here is new.

## 1. Auth & device pairing

The web UI already has a full login experience (Better Auth, passkeys included).
Rather than have the native client reimplement passkey ceremonies and session
management, it reuses that UI inside a `WKWebView` and receives a durable
credential at the end.

**Flow:**

1. The app opens a `WKWebView` pointed at `/login`.
2. The user signs in exactly as on the web (password or passkey).
3. On success, the page navigates to a new, session-cookie-authenticated route,
   `GET /device/pair?scheme=yana&deviceName=<name>`. This route:
   - mints a Better Auth API key via the `apiKey` plugin, named/tagged for this
     device (not a bespoke token table — one credential system, same as the
     web session),
   - responds with a redirect to `yana://auth-callback?token=<key>&keyId=<id>`.
4. The app's `WKWebView` navigation delegate intercepts that custom-scheme
   redirect **before it becomes a network request** (`decidePolicyForNavigationAction`),
   extracts the token, stores it in Keychain, and dismisses the webview.
5. Every subsequent `/api/v1/**` request carries `Authorization: Bearer <token>`.

`src/lib/api/auth.ts` resolves that header to a user via Better Auth's API key
verification, the same role `requireUser()`/`requireAdmin()` play for cookie
sessions — a Bearer-token analog, not a replacement for the existing session
model, which the web UI keeps using unchanged.

**Device management UI.** `/account` gains a "Devices" section listing this
user's API keys (device name, created date, last used) with a revoke button per
key, backed by Better Auth's existing key management — no new storage. This is
in scope for this phase, built alongside the API itself.

## 2. Data model changes

Three schema changes, all additive except the logo column swap.

**Tombstones.** New table `article_tombstones`:

| column | type | notes |
|---|---|---|
| `id` | int, PK | |
| `articleId` | int | the deleted article's former id |
| `userId` | int, FK → `users` | denormalized deliberately — after the article (and possibly its feed) is gone, nothing else lets a tombstone be scoped to its owner |
| `deletedAt` | timestamp, default now | |

Indexed on `(userId, deletedAt)`. Every hard-delete path — the retention job,
and feed deletion (which cascades into `articles`) — selects the affected
article ids and inserts tombstones for them *before* the delete, inside the
same `writeTransaction()`. The retention job additionally prunes its own
tombstones once they're older than its retention window — a tombstone can't
usefully outlive the window that makes cursors past it invalid anyway (see
cursor-expiry, §3).

**Runs.** New table `runs`:

| column | type | notes |
|---|---|---|
| `id` | int, PK | |
| `userId` | int, FK → `users` | |
| `status` | text | `pending` / `running` / `completed` / `failed` |
| `totalJobs` | int | |
| `completedJobs` | int, default 0 | |
| `failedJobs` | int, default 0 | |
| `createdAt` | timestamp | |
| `finishedAt` | timestamp, nullable | |

`jobs` gains a nullable `runId` (FK → `runs`). `src/lib/jobs/queue.ts`'s
`complete()` and `fail()` are extended: when a job carrying a `runId` reaches a
terminal state, atomically bump the parent run's counters, and flip the run to
`completed`/`failed` once `completedJobs + failedJobs === totalJobs`. This is
the only behavioral change to the existing job queue; job claiming, retry
backoff, and orphan-reset are untouched.

**Content-addressed feed logos.** `feeds.logo` (relative file path) and
`feeds.logoSourceUrl`'s storage role are replaced by `feeds.logoImageHash`
(nullable text, referencing `articleImages.contentHash`). `logoSourceUrl`
itself is kept (still needed to re-resolve a logo without re-discovering the
source). The existing `articleImages` table — already contentHash-unique, with
`file`/`contentType`/`width`/`height`/`byteSize` — is reused rather than adding
a second images table; `src/lib/jobs/handlers/logo.ts` writes into it the same
way article-image extraction does, so two feeds sharing an identical favicon
dedupe automatically.

**Tags on the wire.** No schema change. `feedTags` already models the
many-per-feed relationship; only the serializer changes (§3).

## 3. Endpoint surface

| Endpoint | Method | Purpose |
|---|---|---|
| `/device/pair` | GET | mint device API key, redirect to app (§1) |
| `/api/v1/articles/sync` | GET | paginated list **and** incremental delta, unified |
| `/api/v1/articles/:id/content` | GET | block-tree body (wire format v1) |
| `/api/v1/articles/:id` | PATCH | `{ starred?, read? }` |
| `/api/v1/articles/:id/reload` | POST | enqueue `article.reload`, returns `{ jobId }` |
| `/api/v1/aggregate` | POST | enqueue a run (one `aggregate` job per enabled feed), returns `{ runId }` |
| `/api/v1/runs/:id` | GET | run status snapshot (SSE fallback) |
| `/api/v1/jobs/events` | GET | SSE stream of job/run progress (§4) |
| `/api/v1/feeds` | GET | feed list, incl. `tagIds`, `logoImageHash` (unpaginated — per-user feed counts are small) |
| `/api/v1/tags` | GET | this user's tags (unpaginated, same reasoning) |
| `/api/v1/images/:hash` | GET | content-addressed image/logo bytes |

**Sync is one endpoint, not two.** `GET /api/v1/articles/sync?cursor=<opaque>&limit=200`.
No cursor (first call) returns everything from the beginning, paginated — this
*is* "get all articles." A later call with the previous response's cursor
returns only what changed — this *is* the delta. One code path, one cursor
format.

The cursor is opaque to the client: base64 of
`{ newPos: [createdAt, id], updatedPos: [updatedAt, id] }`. Internal shape can
change later without breaking clients as long as the server keeps accepting
what it last issued.

Response shape:

```json
{
  "new": [ /* article rows created since newPos */ ],
  "updated": [ /* article rows updated since updatedPos, excluding those already in "new" */ ],
  "removed": [ /* article ids from article_tombstones newer than the client has seen */ ],
  "nextCursor": "<opaque>"
}
```

**Cursor expiry.** If the requested cursor's `updatedPos`/`newPos` predates the
oldest surviving tombstone or the oldest retained article, the server cannot
prove the delta is complete (retention may have pruned rows *and* their
tombstones past that point) and responds `{ "resyncRequired": true }` instead
of a partial delta — explicit staleness, never silent gaps.

**Metadata sync, content on demand.** `sync` rows are lightweight: `id`,
`feedId`, `name`, `identifier`, `date`, `author`, `icon`, `read`, `starred`,
`createdAt`, `updatedAt`. No block tree — that can be large and is fetched
lazily via `GET /api/v1/articles/:id/content`, which reuses
`encodeDocument()` from `src/lib/aggregators/blocks/schema.ts` unchanged. One
encoder, shared with the `blocks_golden_v1.json` fixture iOS already tests
against.

**One PATCH for read + starred**, not four star/unstar/read/unread endpoints:
`PATCH /api/v1/articles/:id { starred?: boolean, read?: boolean }`. Applied as
a plain column write — `starred = <value>, updatedAt = now()` — no per-device
state, last-write-wins. Two devices toggling the same article near-simultaneously
resolve to whichever request lands on the server last; the result propagates to
both via the next `sync` call's `updated` list. This is an accepted limitation,
not an oversight — the schema deliberately has no per-device read/star table
(the multi-tenancy decision already made a per-user join table unnecessary; a
per-*device* one would be new complexity this phase doesn't need).

**Aggregation as a run.** `POST /api/v1/aggregate` creates a `runs` row with
`totalJobs` set to the caller's enabled feed count, then enqueues one
`aggregate` job per feed with that run's id attached. Returns `{ runId }`
immediately; the run reaches `completed`/`failed` as its child jobs finish
(§2). `POST /api/v1/articles/:id/reload` enqueues a single `article.reload`
job with no run (nothing to group).

**Image ownership.** `GET /api/v1/images/:hash` requires a valid Bearer token
*and* verifies the hash is referenced by an `articleImages` row reachable from
an article or feed the caller owns — not "any authenticated user, any hash on
the instance." This costs a join per request but matches this codebase's
existing strict-ownership convention (avatars, media routes) rather than
treating a content hash as a public capability token.

## 4. Job/run notification (SSE)

`GET /api/v1/jobs/events` — a per-user, held-open connection, authenticated the
same way as any other `/api/v1/**` call. Unlike a browser `EventSource`, a
native `URLSession` request can set an `Authorization` header directly, so no
token-in-query-string workaround is needed.

The existing job worker (`src/lib/jobs/worker.ts`) already calls
`progress()`/`complete()`/`fail()` on every state change. Those calls
additionally publish to an in-process, per-user `EventEmitter` (no Redis, no
new infrastructure — consistent with the single-process job system as a
whole), which any open SSE connections for that user forward as:

```
event: job
data: {"jobId":42,"runId":7,"kind":"aggregate","status":"running","progress":60}

event: run
data: {"runId":7,"status":"completed","totalJobs":12,"completedJobs":12,"failedJobs":0}
```

SSE is a low-latency notification layer only, never the source of truth. If
the connection drops (background, network blip), the client falls back to
`GET /api/v1/runs/:id` or a plain `sync` call — no event is load-bearing for
correctness, only for how quickly the client finds out.

Push notifications (APNs) for background completion are explicitly out of
scope for this phase — a real feature with its own infrastructure (Apple Push
certs/keys, background modes), not "inform the currently-open app."

## 5. Conventions

**Errors.** A consistent envelope: `{ "error": { "code": "not_found", "message": "..." } }`,
with standard HTTP status codes. `code` is a stable, machine-readable slug —
unlike the web UI's catalog-key convention, the native client owns its own
localized strings, so nothing here needs to resolve to `messages/*.json`.

**Ownership.** "Doesn't belong to you" and "doesn't exist" both answer 404,
never 403 — the same enumeration-avoidance convention `requireAdmin()` and the
avatar route already use. Every query is scoped by the authenticated user;
this phase introduces no exception to that rule.

**File layout** (as sketched in the original phase-13 plan, now concrete):

| Path | Responsibility |
|---|---|
| `src/app/api/v1/**/route.ts` | the endpoints themselves |
| `src/lib/api/auth.ts` | Bearer token → user resolution |
| `src/lib/api/serializers.ts` | row → wire shape (incl. `tagIds`, `logoImageHash` projections) |
| `src/lib/api/sync.ts` | cursor encode/decode, delta queries, tombstone reads |
| `src/lib/api/events.ts` | the per-user `EventEmitter` registry backing SSE |

**Testing.** Same convention as the rest of the codebase: real SQLite, no
driver mocks, `.test.ts` in the node vitest project. A real API key minted
through Better Auth's plugin authenticates real requests against real route
handlers; SSE assertions read real chunks emitted off real job-row writes, not
a simulated event bus.

## Resolved: the nine original open questions

For traceability against `nextjs-13-client-api.md`'s list:

1. **Endpoint surface/shapes** — §3.
2. **Auth / per-device session model** — §1: webview login + Better Auth API
   keys, not cookie sessions and not a bespoke device-credential system.
3. **Incremental sync** — §3: unified `sync` endpoint, opaque cursor over
   `(createdAt, id)` for new rows and `(updatedAt, id)` for changed rows.
4. **Read/starred reconciliation** — §3: last-write-wins, no per-device state,
   accepted as sufficient for v1.
5. **Deletion/retention propagation** — §2: `article_tombstones`, surfaced via
   `sync`'s `removed` list; cursor-expiry makes staleness explicit.
6. **Image download/cache-invalidation** — §2/§3: content-addressed by hash
   (already true for article images; feed logos now join that mechanism too),
   served by `/api/v1/images/:hash`.
7. **Migrating existing iOS SwiftData installs** — decided: no import path.
   Server is authoritative from first sign-in; purely local state is left
   behind. Fresh start.
8. **CloudKit removed or transitional** — already removed on the iOS side;
   nothing for this API to accommodate.
9. **Tags as an array, not a single group** — §2/§3: feeds carry `tagIds`;
   `GET /api/v1/tags` is the resolution endpoint, client joins locally.

## Explicitly out of scope for this phase

- Push notifications (APNs) for background job completion.
- Bulk/offline write queuing on the client side (each PATCH/POST is a single
  synchronous round trip; no batch endpoint).
- Rate limiting specifics (left to normal infrastructure-level concerns, not
  designed here).
- Image resizing/thumbnail variants — `/api/v1/images/:hash` serves the stored
  bytes as-is.
