# Direction: Migrating Yana to Next.js

**Date:** 2026-07-30
**Status:** Direction record + architecture spec — the decisions the 18 phase plans build on
**Scope:** Why we are moving to Next.js, the target architecture, the schema, the aggregator parity
contract, and the phase route. Individual phases are planned in `docs/superpowers/plans/nextjs-*.md`.

## Background

Yana is a self-hosted RSS aggregator. Its current form is a Django 6.0 server whose verification
surface is the Django admin, per
[2026-07-29-client-server-remigration-direction.md](2026-07-29-client-server-remigration-direction.md).
That route (Specs 0–5) brought server-side aggregation to parity with the iOS client, moved images to
content-addressed storage, and replaced HTML article bodies with the typed *Yana content format*.
It deliberately shipped **no HTTP API** — admin plus management commands only.

This project has migrated across stacks before, in the opposite direction. Commit `c19d137` moved an
Angular + Node/Drizzle application into `old/`, `8fde9be` deleted it (428 files), and migration
`0029_drop_legacy_drizzle_tables` removed its tables. That tree included a complete TypeScript
aggregator implementation at `old/src/server/aggregators/`.

## Decision

**Yana becomes a Next.js application. Python is removed entirely.**

One language, one toolchain, one process. The Django admin is replaced by a purpose-built web UI —
which is the actual driver: admin was only ever the *interim* verification surface, and the features
this migration adds (auth with passkeys, per-user account management, a real feeds/articles/tags UI,
a settings surface) are things admin cannot reasonably become.

The recovered TypeScript tree is a **structural** reference only, never a behavior source: it
predates Specs 0–5, so it knows nothing about the block format, hosted images, or iOS parity. All
behavior comes from the current Python.

Consequences accepted:

- The 13.4k-LOC aggregator layer is reimplemented in TypeScript. This is ~40% of the work and the
  only part with a hard, testable correctness bar. The parity contract below exists for it.
- `django-q2` scheduling is replaced by a SQLite-backed job queue.
- Django's ORM-level SQLite tuning moves to explicit Drizzle/`better-sqlite3` PRAGMAs.
- No data migrates. Existing installs restart from an empty database.

## Pinned decisions

These were settled in brainstorming and are not reopened by individual phase plans.

| Decision | Choice | Consequence |
|---|---|---|
| Completeness | Full TypeScript rewrite; Python deleted | Aggregators ported, not wrapped |
| Tenancy | Multi-tenant — per-user feeds, tags, articles, credentials | Every query scoped by owner |
| Tags | Real tags, many per feed | Changes the client API contract (array, not scalar) |
| Parity proof | Frozen golden JSON, generated from Python once | Becomes phase 0 |
| Data | Greenfield, no migration | Enables idiomatic naming and dropping `Article.content` |
| Jobs | SQLite `jobs` table + in-process worker | Durable, retryable, one process |
| Planning | Direction record + per-phase plans, detail front-loaded | 18 plans, later ones structural |

The new project is scaffolded in **`yana-next/`** and moves to the repository root in phase 14.

## Stack

| Concern | Choice | Rationale |
|---|---|---|
| Framework | Next.js (App Router), TypeScript `strict` | Exact version pinned at scaffold |
| Runtime | Node LTS current at scaffold time | `better-sqlite3` prebuilds must cover the ABI |
| DB access | Drizzle + `better-sqlite3` | Drizzle's most mature SQLite driver; prebuilt binaries for all target platforms (required by phase 15); exposes `pragma()` so the tuned PRAGMAs port 1:1 |
| UI | shadcn/ui + Tailwind, mobile-first | — |
| Toasts | `sonner` | shadcn's own recommendation |
| i18n | `next-intl` | EN/DE; App Router native |
| Auth | **Better Auth** | Decided by passkeys: first-class WebAuthn, Drizzle adapter, cookie sessions, and an admin plugin matching the "admin boolean, no roles or groups" requirement. Auth.js passkey support is still experimental |
| Lint / format | **ESLint + Prettier** | The `create-next-app` default and the beaten path. Biome was considered and rejected on ecosystem familiarity — its `next`/`drizzle`/`types` domains do cover this project, so the swap stays available later as a config-only change |
| Type check | `tsc --noEmit` | The `mypy` analogue |
| Tests | Vitest | Golden-fixture assertions dominate the suite |
| HTML parsing | **`cheerio` on its default `htmlparser2` backend — explicitly not parse5** | Load-bearing. See "Hazard 2" below |
| Images | `sharp` | Replaces Pillow. See "Hazard 1" below |
| Feed parsing | Chosen in phase 11a *against the goldens* | `feedparser` is extremely lenient; the replacement is selected by which candidate passes, not by reputation |
| Reddit | Direct OAuth calls | No maintained TS equivalent of `praw`; the surface actually used is small |

Deliberately not ported: `django-autocomplete-light`, `django-import-export`, `djangoql` (admin-only,
and admin is what we are replacing) and `supervisord` (single process now).

CI keeps its current job graph exactly — lint, format check, type check, test, then AMD64 and ARM64
image builds, a multi-arch manifest, and the Portainer redeploy. Only the commands inside the test
job change.

## Schema

Greenfield permits idiomatic names, so the `core_*` prefix goes.

**Ported unchanged** — same columns, same indexes, same constraints: `feeds`, `articles`,
`article_blocks`, `article_inline_runs`, `article_images`, `user_settings`, `reddit_subreddits`,
`youtube_channels`.

The `uniq_block_position` caveat ports with it: SQLite treats NULLs as distinct in a unique index, so
the constraint does **not** cover root-level rows (`parentId IS NULL`). Root position uniqueness stays
enforced in application code, as it is today in `core/blocks/storage.py`.

**Dropped**: `auth_*`, `django_q_*`, `django_session`, `django_admin_log`, `django_content_type`,
`django_migrations`.

**Added**: `users`, `sessions`, `accounts`, `passkeys` (Better Auth), and `jobs`.

### Deviations from "the same schema as we currently have"

Four, each deliberate:

1. **`tags` + `feed_tags`** replaces `FeedGroup` + the single `Feed.group` FK. A feed's grouping
   becomes an array, which is a client API contract change — carried into phase 13's open questions.
2. **`Article.content` is not created.** It currently holds processed HTML that blocks are rebuilt
   from, and the project already records it as "no longer a contract… slated for removal once blocks
   are trusted." Greenfield is the moment: nothing needs migrating, so it never exists. `rawContent`
   stays (phase 12's article reload action needs it, and it is the debugging surface), `plainText`
   stays for search, and blocks become authoritative rather than derived-and-shadowed.
3. **`user_settings` grows** `theme`, `language`, `articleRetentionDays`, `updateIntervalMinutes`.
   Retention is currently a job kwarg rather than a user setting; phase 3 promotes it.
4. **`Feed.options` gains a typed schema.** The column stays JSON, but the ~20 per-aggregator option
   keys get a **Zod schema per aggregator** in a registry. One declaration then serves three
   purposes: validating writes, typing reads, and generating phase 9's aggregator-dependent form
   body. Each option may declare a `requires: 'youtube' | 'reddit' | 'ai'` guard, which is what
   implements "hide the options where integration or AI is not configured".

`Article.icon` is retained — it is live, written by the `header_element` service as the per-article
header image.

### Ownership

```
users ──┬─< sessions / accounts / passkeys
        ├─< feeds ──┬─< articles ──┬─< article_blocks ──< article_inline_runs
        │           │              └── icon (header image)
        │           └─>< feed_tags >── tags
        └─── user_settings

article_images   (content-addressed, shared, unowned)
jobs             (kind, payload, status, attempts, runAt, progress, error)
reddit_subreddits / youtube_channels   (autocomplete caches)
```

`userId` lives on `feeds`, `tags` and `user_settings`. Articles inherit their owner through `feedId`,
which means `read` and `starred` stay plain columns on `articles` with no per-user join table — a
direct payoff of the multi-tenant decision.

## The aggregator parity contract

Bullet 11's requirement is "absolutely identical behavior in detail". This is how that is made
falsifiable.

A generator script runs every fixture through the **current Python pipeline** and writes the result to
committed golden JSON. Vitest asserts the TypeScript pipeline reproduces it.

### Hazard 1 — content hashes cannot match, and need not

`ArticleImage.content_hash` is SHA-256 over the *compressed* bytes. Python compresses with Pillow
(`WEBP quality=…, method=6`; `PNG optimize=True`; JPEG quality); TypeScript uses sharp/libvips.
Different encoders emit different bytes for identical input, so every hash differs — and therefore
every `yana-img://<hash>` inside the block tree differs, failing deep-equality on every image-bearing
fixture.

Greenfield resolves this: hashes need only be *internally* consistent (same bytes → same row), never
equal to Python's. Golden records therefore **normalize image refs to a source-URL key** and assert
image properties separately.

```
yana-img://a3f9c1…   ──normalize──▶   yana-img://{img:0}      // keyed by source-URL order
```

| Field | Assertion |
|---|---|
| block tree (refs normalized) | exact deep-equal |
| `plainText` | exact |
| title / identifier / author / date | exact |
| image `contentType` | exact |
| image `width` / `height` | exact — output dimensions come from our own deterministic integer arithmetic, which is portable |
| image `byteSize` | tolerance band (±25%) — a sanity check, not equality |
| image `contentHash` | **not compared** |

### Hazard 2 — the HTML parser

Every parse site uses `BeautifulSoup(html, "html.parser")` — Python's stdlib parser, which is *not*
HTML5-spec-compliant. This is why the stack picks `htmlparser2` over parse5: both are lenient in the
same way, whereas parse5's spec compliance (implicit tag closing, table foster-parenting) would
diverge *further* on exactly the malformed markup scraping encounters.

They still will not agree perfectly. Divergence concentrates in three files — `block_parser.py` (668
LOC), `html_cleaner.py` (277) and `content_extractor.py` (161). The goldens surface each case; phase
11a should budget for a tail of fixes there rather than a clean first pass.

### Fixture corpus

Only 5 HTML fixtures exist today (`caschys_blog`, `dark_legacy`, `explosm`, `mactechnews`,
`mactechnews_multipage`) — most Python tests use inline HTML. Nine more are recoverable from
`8fde9be^`:

| Fixture | Size |
|---|---|
| `feed_content.html` | 3.3 MB |
| `full_website.html` | 3.2 MB |
| `heise.html` | 3.2 MB |
| `tagesschau.html` | 432 KB |
| `mein_mmo.html` | 405 KB |
| `merkur.html` | 255 KB |
| `podcast.html` | 137 KB |
| `oglaf.html` | 3.8 KB |
| `reddit-api.json`, `youtube-api.json` | ~1 KB each |

**Their staleness is irrelevant.** A parity golden only requires that both implementations receive
identical bytes; whether the HTML still matches the live site is a different question answered by
different tests. Recovering them leaves a capture list of `ars_technica`, `the_verge`, and richer
Reddit and YouTube cases.

### Outside the goldens

These need conventional unit tests, because static fixtures cannot express them:

- The network layer — retry policy, the 8 MB `fetch_html` / 2 MB `fetch_binary` caps, redirects.
- The adaptive time-of-day quota. `core/aggregators/base.py:210` branches on `now.hour < 10`, so the
  port needs an **injectable clock**.
- AI calls.
- Live-site behavior.

### Sequencing consequence

The generator runs Python, and phase 14 deletes Python. So golden generation cannot live in phase 11
where it is consumed — it is **phase 0**, run before any TypeScript aggregator code exists, its
output committed as a durable artifact. Every later phase is then free to remove Python without
losing the oracle.

## Route

The 15 bullets of the original brief become 18 plans: phase 0 is inserted, and phase 11 splits three
ways.

```
0  goldens                        ── requires Python; must land before 14 deletes it
                                     also gates 11a
1  scaffold
2  schema
│
├── 3 shell ── 4 auth ──┬── 5 users
│                       ├── 6 integrations ──┐
│                       ├── 7 AI ────────────┼── 9 feeds ── 10 articles ──┐
│                       └── 8 tags ──────────┘                            │
│                                                                         │
└── 11a core ── 11b embeds ── 11c aggregators ────────────────────────────┤
     ▲                                                                   │
     └── (also needs 0)                                                  ▼
                                12 scheduling ── 13 client API ── 14 swap ── 15 npm
```

| # | Plan | Depends on |
|---|---|---|
| 0 | `nextjs-00-golden-corpus.md` | — |
| 1 | `nextjs-01-scaffold.md` | — |
| 2 | `nextjs-02-schema.md` | 1 |
| 3 | `nextjs-03-app-shell.md` | 2 |
| 4 | `nextjs-04-auth.md` | 3 |
| 5 | `nextjs-05-users-crud.md` | 4 |
| 6 | `nextjs-06-integrations.md` | 4 |
| 7 | `nextjs-07-ai.md` | 4 |
| 8 | `nextjs-08-tags-crud.md` | 4 |
| 9 | `nextjs-09-feeds-crud.md` | 6, 7, 8 |
| 10 | `nextjs-10-articles-crud.md` | 9 |
| 11a | `nextjs-11a-extraction-core.md` | 0, 2 |
| 11b | `nextjs-11b-embeds-and-media.md` | 11a |
| 11c | `nextjs-11c-aggregators.md` | 11b |
| 12 | `nextjs-12-scheduling-and-jobs.md` | 10, 11c |
| 13 | `nextjs-13-client-api.md` | 12 |
| 14 | `nextjs-14-folder-swap.md` | 13 |
| 15 | `nextjs-15-npm-package.md` | 14 |

### Why phase 11 splits three ways

It is 13.4k LOC and the only phase with a pass/fail oracle rather than a design judgment.

- **11a — extraction core + image pipeline.** `base.py`, `html_fetcher`, `content_extractor`,
  `html_cleaner`, `block_parser`, and image extract/compress/store. Every aggregator inherits this,
  so landing it first means the 16 scrapers are written once against final extraction behavior. The
  Python route used precisely this ordering for its Spec 1 → Spec 2 and it held.
- **11b — embeds & media.** ~1.2k LOC across `mein_mmo/embed_processors` (402), `bluesky` (304),
  `twitter` (281), `youtube` (233) and the Tagesschau and Reddit media processors. Independently
  testable against the goldens.
- **11c — the 16 aggregators**, plus a per-aggregator npm script replacing `test_aggregator`.

### A note on phase 14's `old/`

This repository has run this exact manoeuvre before: `c19d137` moved the previous stack into `old/`
and `8fde9be` deleted it 428 files later. Treat `old/` as a short-lived staging area for the swap, not
an archive — **git history is the archive**. Phase 14 should therefore delete `old/` in the same phase
that creates it, once the root-level Next.js tree is green, rather than leaving a dead directory to be
cleaned up by a later commit.

## Named seams

Two places where the phase order creates a join that should be designed, not discovered.

**The 3/4 settings seam.** Phase 3's settings tab persists per-user preferences, but authentication
does not exist until phase 4. Rather than reorder, phase 2 seeds a single bootstrap user row; phase 3
reads and writes that row's `user_settings`; phase 4 swaps the source of `userId` from that constant
to the session. No UI is rewritten — only where the id comes from.

**Phase 13 is not planned by this session.** The existing direction record states the client API
"needs its own session rather than an appendix here", and its open questions are unresolved:

- Endpoint surface and resource shapes.
- Authentication and the per-device session model.
- Incremental sync — cursor design, and what a client sends to catch up after being offline.
  `articles.createdAt` (indexed with `id` as tie-breaker) is the monotonic ordering key.
- Read/starred reconciliation, including conflicts between two devices.
- Deletion and retention propagation — tombstones vs. full resync.
- Image download and cache-invalidation protocol.
- Migrating each existing iOS install's SwiftData store, and what happens to on-device-only articles.
- Whether CloudKit is removed outright or kept transitionally.
- **New:** a feed's tags are now an array rather than one group.

Phase 13's plan is therefore **structural only** and carries these forward. It needs its own
brainstorming session before execution.

## Risks

| Risk | Mitigation |
|---|---|
| Aggregator behavior silently drifts | Phase 0 goldens, generated before Python can be deleted |
| Parser divergence on malformed HTML | `htmlparser2` over parse5; budget a fix tail in 11a |
| `sharp` output differs from Pillow | Hashes excluded from comparison by contract; dimensions and content type still asserted exactly |
| Feed-parser leniency gap | Candidate chosen by golden pass rate, not reputation |
| Phase 13 executed without design | Marked structural-only; requires its own brainstorm |
| `better-sqlite3` native build breaks phase 15 | Verify prebuild coverage for all target platforms during phase 1, not phase 15 |
| The npm name `yana` may be taken | Verify at the start of phase 15; scoped name is the fallback |

## Deferred

Carried over from the previous direction record and still out of scope:

| Item | Why |
|---|---|
| `fetch_single_image` response cap | The highest-volume path still reads unbounded. Any cap must stay generous — iOS deliberately raised its own to 64 MB for large Reddit GIFs |
| Flat run limit | The adaptive time-of-day quota is retained deliberately; drip-feed pacing suits an always-on server |
| AI provider expansion | iOS supports 7 providers, the server 3. Cleanly separable from this migration |
| AI options shape | Server uses flat `ai_*` keys, iOS nests under `ai`. Harmonize when phase 13 pins the options contract |
| Deleting iOS `Yana/Aggregators/` | After phase 13 ships and the server is proven authoritative |

## Repository note

`fa-krug/Yana` is the iOS/macOS client; `fa-krug/yana-server` is this project. GitHub's
case-insensitive redirect resolves `Yana` → `yana`, which has already caused one misconfigured
`origin` here. Always write `yana-server` when you mean this repo.
