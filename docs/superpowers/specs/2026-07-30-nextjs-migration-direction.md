# Direction: Migrating Yana to Next.js

**Date:** 2026-07-30
**Status:** Direction record + architecture spec — the decisions the 18 phase plans build on
**Scope:** Why we are moving to Next.js, the target architecture, the schema, the aggregator parity
contract, and the phase route. Individual phases are planned in `docs/superpowers/plans/nextjs-*.md`.

**Progress (2026-08-01):** Phase 0 (goldens), phase 1 (scaffold), phase 2
(schema), phase 3 (app shell) and **phase 4 (authentication)** are done, and
**phase 14's folder swap has been executed early** — the Next.js app is the
repository root and the Django tree now sits in `old/`. Phases 5–13 and 15 are
open. Two decisions below were changed by that early swap: Python is **not**
deleted (`old/` is kept as read-only reference until nothing needs to read it),
and CI no longer publishes or deploys. See
`docs/superpowers/plans/nextjs-14-folder-swap.md`.

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

The new project was scaffolded in `yana-next/` and **now is the repository root** — phase 14's swap
ran early. Python lives in `old/`, read-only. Plans written before the swap use `yana-next/`-prefixed
paths; read those as repository-root paths.

## Stack

| Concern | Choice | Rationale |
|---|---|---|
| Framework | Next.js (App Router), TypeScript `strict` | Exact version pinned at scaffold |
| Runtime | Node LTS current at scaffold time | `better-sqlite3` prebuilds must cover the ABI |
| DB access | Drizzle + `better-sqlite3` | Drizzle's most mature SQLite driver; prebuilt binaries for all target platforms (required by phase 15); exposes `pragma()` so the tuned PRAGMAs port 1:1 |
| UI | shadcn/ui + Tailwind, mobile-first | — |
| Toasts | `sonner` | shadcn's own recommendation |
| i18n | `next-intl` | EN/DE; App Router native |
| Auth | **Better Auth** | Decided by passkeys: first-class WebAuthn, Drizzle adapter, cookie sessions. Auth.js passkey support is still experimental. **Corrected in phase 4:** this row originally credited "an admin plugin matching the 'admin boolean, no roles or groups' requirement". At 1.6.25 the `admin()` plugin is role-based (`role`/`banned`/`banReason`/`banExpires`), so no such match exists — the requirement was changed rather than the library. See the phase 4 note below |
| Lint / format | **ESLint + Prettier** | The `create-next-app` default and the beaten path. Biome was considered and rejected on ecosystem familiarity — its `next`/`drizzle`/`types` domains do cover this project, so the swap stays available later as a config-only change |
| Type check | `tsc --noEmit` | The `mypy` analogue |
| Tests | Vitest | Golden-fixture assertions dominate the suite |
| HTML parsing | **`cheerio` on its default `htmlparser2` backend — explicitly not parse5** | Load-bearing. See "Hazard 2" below |
| Images | `sharp` | Replaces Pillow. See "Hazard 1" below |
| Feed parsing | Chosen in phase 11a *against the goldens* | `feedparser` is extremely lenient; the replacement is selected by which candidate passes, not by reputation |
| Reddit | Direct OAuth calls | No maintained TS equivalent of `praw`; the surface actually used is small |

Deliberately not ported: `django-autocomplete-light`, `django-import-export`, `djangoql` (admin-only,
and admin is what we are replacing) and `supervisord` (single process now).

**Amended.** CI was to keep the Django pipeline's job graph exactly, changing only the commands
inside the test job. It does not: the multi-arch manifest and the Portainer redeploy are **gone**
(the early folder swap removed them — production still runs the last Django image, and publishing
`:latest` from here would swap a working aggregator for an unfinished port), and the image jobs
build both architectures with `push: false` so the Dockerfile keeps getting exercised. Phase 4 added
one job step the Django pipeline had no equivalent of: a **dev-boot smoke** that starts `next dev`
and fetches `/health`, `/login` and `/`. Nothing else in CI ever runs the application, and phase 4
produced two bundler-class regressions that only a running server catches. Restoring publish and
deploy is phase 15's business; see `.github/workflows/ci.yml`, whose header carries the current
rule.

## Schema

Greenfield permits idiomatic names, so the `core_*` prefix goes.

**Ported unchanged** — same columns, same indexes, same constraints: `articles`, `article_blocks`,
`article_inline_runs`, `article_images`, `user_settings`, `reddit_subreddits`, `youtube_channels`.

**Corrected 2026-07-31 (phase 2 review):** `feeds` was listed here and does not belong — it carries
two deliberate changes, deviations 1 and 5 below.

The `uniq_block_position` caveat ports with it: SQLite treats NULLs as distinct in a unique index, so
the constraint does **not** cover root-level rows (`parentId IS NULL`). Root position uniqueness stays
enforced in application code, as it is today in `core/blocks/storage.py`.

**Dropped**: `auth_*`, `django_q_*`, `django_session`, `django_admin_log`, `django_content_type`,
`django_migrations`.

**Added**: `users`, `sessions`, `accounts`, `passkeys` (Better Auth), and `jobs`.

### Deviations from "the same schema as we currently have"

Five, each deliberate. (Four when this was written; the fifth was already implemented in phase 2 and
went unrecorded until that phase's review — see below.)

1. **`tags` + `feed_tags`** replaces `FeedGroup` + the single `Feed.group` FK. A feed's grouping
   becomes an array, which is a client API contract change — carried into phase 13's open questions.
   `Feed.group` therefore does not exist: `feeds` has no `group` column at all.
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
5. **`Feed.user` is tightened to `NOT NULL` with `ON DELETE CASCADE`.** Django had
   `null=True, on_delete=SET_NULL`, which allowed an unowned feed. Multi-tenancy makes that
   meaningless — an unowned feed is invisible to every query — and the `NOT NULL` FK is what makes
   the ownership cascade in the diagram below actually delete a user's feeds, articles, blocks and
   runs rather than orphan them. Recorded here retroactively: phase 2 shipped it, this record
   claimed `feeds` was ported unchanged.

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

The generator runs Python, and phase 14 retires Python. So golden generation cannot live in phase 11
where it is consumed — it is **phase 0**, run before any TypeScript aggregator code exists, its
output committed as a durable artifact. Every later phase is then free to remove Python without
losing the oracle.

This held up under the early swap: Python still exists in `old/`, but it no longer runs as configured,
so the committed corpus — not the Python tree — is the oracle in practice. Treat it as frozen.

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
| 14 | `nextjs-14-folder-swap.md` | ~~13~~ — **ran after 1**, so all later phases work at the root |
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

### A note on phase 14's `old/` — reversed

~~This repository has run this exact manoeuvre before: `c19d137` moved the previous stack into `old/`
and `8fde9be` deleted it 428 files later. Treat `old/` as a short-lived staging area for the swap, not
an archive — **git history is the archive**. Phase 14 should therefore delete `old/` in the same phase
that creates it.~~

**Superseded 2026-07-31.** The swap ran early, with phases 2–13 still ahead, and every one of them
reads Python to port it. Reading `old/core/aggregators/heise/aggregator.py` in the working tree beats
resurrecting it from a tag on every question, so `old/` is **kept** — read-only, built by nothing,
edited by nobody. The argument above was not wrong, only early: delete `old/` once phase 13 lands and
nothing needs to read Python. `CLAUDE.md` carries the rules; `nextjs-14-folder-swap.md` records the
delta.

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
| **Per-user** time zone | **Only this half is still open.** Phase 4 settled the process-level default: `src/i18n/request.ts` configures next-intl with `process.env.TZ \|\| "UTC"`, documented in `.env.example`. It had to, and not as scope creep — the account page's passkey list is the first rendered date, and with no configured zone next-intl falls back to the *environment's*: the container's on the server, the visitor's own in the browser, which is a hydration mismatch plus an ENVIRONMENT_FALLBACK warning on every render. Phases 5–10 inherit a working deployment-wide default and one question: whether a `user_settings.time_zone` column is worth it. Do not re-litigate the default |

## Carried forward from phase 5's review

Phase 5 shipped `/users` **and the reusable CRUD kit under it**. Phases 8, 9 and 10 (tags, feeds,
articles) build their lists on that kit, so its contracts are inherited rather than merely
available — this section is what the next agent adding a **list page** reads first. That is phase 8:
phase 6 (integrations) added forms rather than a list and consumed only `<ConfirmDestructive>`, and
phase 7 extends the same page.

- **The kit's contracts, in the order they are easiest to get wrong.**
  - **Select-all is page-scoped.** `toggleAll()` in `src/components/crud/selection.ts` never reaches
    beyond the ids on the current page, and ids selected on other pages survive it untouched.
    Selecting rows nobody has looked at is how a bulk delete removes more than the operator meant
    to. A partial page counts as "select all", matching every other table an operator has used.
  - **`run` and `onConfirm` resolve a `boolean`; success is not merely the absence of a throw.**
    `<ConfirmDestructive>` closes only on `true`, so a refusal leaves the dialog standing over the
    list it refers to, with the toast beside it. An action that returned `{ ok: false }` and threw
    nothing would otherwise close the dialog and look like it worked. `run` **is** that `onConfirm`
    for a destructive bulk action, which is why the two signatures have to agree.
  - **`buildListHref(pathname, current, changes)` is three arguments, merge-and-reset** (human
    ruling C). `q`, `pageSize` and `filters` change _what_ the list shows, so any of them actually
    changing value resets to page one — an explicit `changes.page` in the same call loses, because
    it was computed against the old result set. `sort`/`dir` deliberately do **not** reset:
    re-ordering the same rows does not invalidate the page. `changes.filters` **merges per key**
    (the whole-record replacement, and the hand-written spread that worked around it, went in the
    phase's fix wave); clear one filter with `""`.
  - **There are no per-page defaults, and the parameter that promised them is gone.** A second
    defaults object reaches `parseListParams` but neither `useListParams()` — which three kit
    components call, and the page does not render directly — nor `buildListHref`'s *omission* rule,
    which decides that `pageSize: 25` is the value left out of the URL. **Do not put a default sort
    in a `NAV_ITEMS` href** (`/articles?sort=publishedAt&dir=desc`) to work around that — `src/lib/nav.ts`'s
    `LABELS` map is keyed on the exact href string and `breadcrumbsFor()` looks up hrefs it rebuilds
    from the pathname alone, so a query-bearing href misses that lookup and the breadcrumb prints
    the raw segment instead of its label; `src/components/app-sidebar.tsx` matches the active item
    with `pathname.startsWith(item.href)`, which a query string never satisfies either, so the item
    never highlights. The honest state: a feature's own `queries.ts` already falls back to a default
    ordering when `sort` is empty (`SORTABLE[params.sort] ?? users.createdAt` in
    `src/lib/users/queries.ts`), so a bare visit is sorted sensibly with nothing to configure — the
    open cost is that `<DataTable>`'s header computes `aria-sort` from the client-parsed `sort`
    alone, so it reads `"none"` on the column actually driving the order. Closing that for real
    needs one defaults object read by `parseListParams`, `useListParams()`, all three kit components
    *and* `buildListHref()`, so the parse/emit round trip stays inverse — no phase has built that yet.
- **A feature's client-safe constants live in a dependency-free `fields.ts`; its `queries.ts` is
  server-only.** `src/lib/users/fields.ts` imports only `@/lib/auth/roles`; `queries.ts` reaches
  `getDb()`. This is the `@/lib/avatar` ↔ `@/lib/avatar-storage` split, and phase 5 hit it live —
  one constant imported out of `queries.ts` dragged `better-sqlite3` into the browser bundle, as an
  opaque bundler error rather than the stated rule. **Now lint-enforced**: `eslint.config.mjs`
  restricts `**/lib/*/queries` from `src/components/**`, so every phase's `queries.ts` is covered
  without the rule being extended. `allowTypeImports` is on — an `import type` for a row projection
  is erased before bundling and is the preferred form.
- **`attemptIn(namespace, keys)`, one binding per feature in `<feature>/result.ts`** (human ruling
  E). Never `await` a server action bare from a client component. See the phase-4 entry below for
  the unification this closed.
- **A page authorizes and awaits its record in the page body, never inside a `<Suspense>` —
  `src/app/(app)/users/[id]/page.tsx` is the precedent, and it is the one a later phase will get
  wrong.** `notFound()` (and `redirect()`, and `forbidden()`) can only produce a status while the
  response is still open; inside a boundary, after the shell has flushed, it truncates a 200
  instead. So a detail route has no data region at all: it awaits one indexed primary-key lookup at
  the top and lets `src/app/(app)/loading.tsx` be the fallback. The `<Suspense>` a *list* page keeps
  is for rows whose absence is an empty table rather than a 404, and its `requireAdmin()` still sits
  above the boundary. That same top-of-page `await` is also what opts the route out of
  prerendering, so it needs no `connection()` call.
- **`users.role` is a comma-separated list, and a form must not collapse one on the way past.**
  `<UserForm>` seeds its two-option select through `isAdminRole()` but submits the **stored** string
  unless the operator actually picks a role — otherwise saving a last name rewrites the column, a
  write nobody asked for. Any later form editing a list-valued column inherits this.

## Carried forward from phase 6's review

Phase 6 shipped `/integrations` with two providers. **Phase 7 adds three AI providers to the same
page**, which is what turns both items below from "a shape one could factor out" into work worth
doing — they are recorded here rather than built because at two call sites each generalisation would
have been guessed from one example, and both were reviewed as correct to defer. A phase-7 agent
should build them *first*, before the third provider, not after the fifth.

- **`src/components/integrations/section-parts.tsx` is hard-wired to the `integrations` catalog
  namespace.** `useReportOutcome()` and `StatusBadge` both call `useTranslations("integrations")`, so
  an `ai` namespace makes all 74 lines uncopyable — and the copy that gets made instead is the toast
  reporter, which is the one piece where a mistake means "the wrong outcome, with no message". Fix
  shape: **`reportOutcomeIn(namespace)`**, mirroring `attemptIn()` in `src/lib/attempt.ts` exactly —
  a factory per feature, keys spelled out at the binding site so `NamespaceKey<Namespace>` stays
  compiler-checked (TypeScript cannot prove a literal is a member of that type while `Namespace` is
  still a parameter, which is why `attemptIn` takes its two keys as arguments). The three
  success/fallback keys (`saved`/`tested`/`removed` and their failures) are the ones to parameterise.
- **`storedCredentials()` hard-codes three columns, and `verifyYoutube`/`verifyReddit` are 90% the
  same sequence** (parse → load the row → resolve each secret → guard the empty case → probe → log →
  judge). Five providers means `actions.ts` at roughly 700 lines of near-twins, and the risk moves
  *between* providers, where no test looks: one provider's resolve rules or empty-credential guard
  drifting from the next's is invisible in a review of either function. Fix shape: a
  **`defineIntegration({ schema, secretColumns, flagColumn, probe, keys, requiredKey })`** descriptor
  that produces the save, test and remove actions for a provider from one declaration — the divergence
  then lives in data, where a table of five is readable at a glance. Two properties must survive it:
  Save and Test have to keep sharing the resolve-and-probe path exactly (`actions.test.ts` pins this
  by running both entry points on one submission and comparing the requests they made), and
  `quotaMeansVerified` must stay a **required** field, so a new provider cannot inherit YouTube's
  answer by omission.
- **The AI providers' probes each need their own two answers decided, not copied.** Whether a rate
  limit proves the credential was accepted, and whether a 200 body has to be inspected, are facts
  about a provider's API — see the `quotaMeansVerified` and success-arm notes in `CLAUDE.md`. OpenAI,
  Anthropic and Gemini answer 429 for *both* "your key is fine, slow down" and, in some tiers,
  quota/credit exhaustion, so this is not a formality.

## Carried forward from phase 4's review

Decisions phase 4's whole-branch review surfaced that belong to a **later** phase.

- ~~**Phase 5 owns the `<Select>` `items` gap.** Already listed under phase 3's known gaps; phase 5 is
  the first phase to add new selects, so it is the phase that closes it.~~ **Closed.** See that entry
  under phase 3's known gaps for what shipped.
- **A social or OAuth provider widens the bootstrap's "can this account sign in" test.**
  `completeDefaultAdmin()` in `src/lib/auth/bootstrap.ts` knows exactly two things: an
  `accounts` row with `providerId = "credential"`, and the `passkeys` table. An admin at
  `admin@admin.com` whose only login is OAuth reads as "no way to sign in", and the published
  default password gets minted back for them.
- **`attempt()` is the pattern every later form copies.** `src/lib/account/result.ts`: never `await`
  a server action bare from a client component; `unstable_rethrow` first; then recognise the
  signed-out response rather than reporting it as a network failure. Phase 5's user CRUD is the
  first place this gets copied, and ~~a third caller is the point at which it and
  `login-form.tsx`'s namesake should be unified.~~ **Closed** (human ruling E): the third caller
  arrived and the three were unified into one implementation, `src/lib/attempt.ts`.
  `attemptIn(namespace, keys)` returns a binding whose `errorKey` stays checked against
  that one catalog namespace instead of widening to `string`, and it preserves the caller's own
  result type, so `attempt(() => createUser(…))` still resolves something carrying `id`. **One
  binding per feature, in `<feature>/result.ts`** — a `"use server"` module can export nothing but
  async functions, which is why the type and the binding cannot live beside the actions.
- **Identity changing without re-rendering the root layout is a standing hazard, not a sign-in
  quirk.** Sign-in and sign-out are both full document navigations for it. An account switcher or
  impersonation done in place would reproduce the mixed-locale render.
- **`requireAdmin()` must be called at the top of a page or layout, never inside a Suspense
  boundary**, or its `notFound()` arrives after the first byte and truncates the stream instead of
  producing a 404. Nothing, lint included, flags its currently-unused export — do not "clean it up".

## Repository note

`fa-krug/Yana` is the iOS/macOS client; `fa-krug/yana-server` is this project. GitHub's
case-insensitive redirect resolves `Yana` → `yana`, which has already caused one misconfigured
`origin` here. Always write `yana-server` when you mean this repo.

## Carried forward from phase 2's review

Decisions phase 2's whole-phase review surfaced that belong to a **later** phase. Recorded here
because phase 2's workspace is deleted, not because they are open questions for phase 2.

- **Phase 4 (auth) — settled, with one decision reversed.** The mapping question resolved to
  `usePlural: true` and nothing else: the Drizzle adapter indexes the **table object**, so it
  matches JS property names, and phase 2's camelCase-property/snake_case-column shape already lined
  up. No per-field mapping was needed.

  The reversal: **`role` replaced `isAdmin` as the authorization model, and `users.is_admin` was
  dropped** (migration `0002`). Enabling `admin()` — which the tech table above assumed was
  boolean-shaped — forces `role`, `banned`, `banReason` and `banExpires` onto the user model, and
  running a boolean beside the plugin's `role` would have been two sources of truth for the same
  authorization question, one written by `setRole` and one by our own UI. A string also scales past
  two tiers where a boolean needs a migration. Still no groups and no permission table: `"admin"` is
  the only role anything reads, and the plugin's endpoints go unused because phase 5 hand-rolls user
  CRUD and declines impersonation.

  Also settled in phase 4: **there is no self-registration.** `disableSignUp` closes
  `/api/auth/sign-up/email`, because an open sign-up on a self-hosted server hands an account to
  anyone who can reach the host. Accounts come from the startup bootstrap and from admin creation in
  phase 5, both through `createUserWithPassword()` in `src/lib/auth/server.ts`.

  And **every `/admin/*` endpoint the plugin mounts is closed** (`disabledPaths`). None of phases
  4–13 calls one — phase 5 hand-rolls user CRUD and declines impersonation — and left open they were
  three live hazards, not dead weight: `/admin/set-role` took an unvalidated role array,
  `/admin/create-user` wrote no `user_settings` row (so `getSettings()` threw for that user forever),
  and `/admin/update-user` passes `ctx.body.data` straight to `internalAdapter.updateUser`, which is
  an arbitrary-column write. **Phase 5 must not reopen one to save writing a query.**

  Two structural facts phase 4 introduced that this record did not name, and that phases 5–13 build
  directly on:

  - **`src/proxy.ts` is where route protection lives** — Next 16's rename of `middleware.ts`, and
    not cosmetic: a Proxy defaults to the **Node.js** runtime, and the exported function is `proxy`,
    not `middleware`. Half a rename is a file Next silently never calls, which leaves every route
    unguarded with nothing failing. It checks cookie *presence* only and may not reach the database
    (pinned by `src/proxy.test.ts`); the real gate is `requireUser()`/`requireAdmin()` in the layout
    or the server action. **Every new public path is one line in `PUBLIC_PREFIXES` and a decision
    about the whole unauthenticated surface**, and every extension added to its matcher is a path
    shape that can never be guarded again.
  - **Migrations run in the application's startup path**, not from an entrypoint script.
    `register()` in `src/instrumentation.ts` awaits `runStartupTasks()`, which migrates and then
    ensures an admin exists — one path for `next dev`, `npm start` and the container alike, so a
    fresh checkout is not running against an empty database. `docker-entrypoint.sh` is deleted. Two
    consequences with teeth: **a startup failure exits the process**, so anything a later phase adds
    to `runStartupTasks()` (phase 12's job worker, above all) must not throw for a recoverable
    reason; and `src/instrumentation.ts` **imports exactly one module**, because webpack compiles
    the hook for the edge runtime too and `next.config.ts` cuts that single specifier out with an
    `IgnorePlugin`. Add startup steps inside `runStartupTasks()`, never a second import in the hook.

  **Closed.** `ensureBootstrapUser()` hard-coded `email: "admin@admin.com"` against a unique index,
  so it and any phase-4 admin at that address would collide. Phase 4 **retired the seeder** —
  `src/lib/db/bootstrap.ts` is gone, replaced by `ensureAdminExists()` in
  `src/lib/auth/bootstrap.ts`, which creates a real credentialed account through
  `createUserWithPassword()` and runs from the startup hook rather than per request.

  The collision itself turned out to be sharper than this note guessed, and phase 4's whole-branch
  review found it live: the existence check is keyed on the *role*, not the address, so anything
  that leaves `admin@admin.com` holding a non-admin role — a demotion, a ban, or the comma list
  `/admin/set-role` would write — made the bootstrap try to create an account that already existed,
  and the `SQLITE_CONSTRAINT_UNIQUE` propagated out of `register()` into `process.exit(1)`.
  Permanently: there is no self-registration and no CLI to recover with. The rule that came out of
  it, and that every later phase touching `users` inherits: **a startup repair repairs; it does not
  rethrow.** See CLAUDE.md's "The default admin" bullet.
- **The image-reaper phase.** `old/core/aggregators/services/image_store.py` scans both `image_ref`
  and `embed_thumbnail_ref`, but only `image_ref` is indexed here (faithful to Django). Greenfield is
  the moment to index `embed_thumbnail_ref` and make the second pass an index scan. Also, dropping
  `Article.content` removes the reaper's blockless-article fallback branch entirely — do not port a
  vestigial equivalent.
- **The search phase.** `plainText` is the documented search column with no index and no FTS5 table
  (parity with Django, which had neither). Choose FTS5 versus `LIKE` scans deliberately.
- **The aggregator phase.** `articles_feed_identifier_idx` is not unique, so nothing at the database
  level prevents the same `(feedId, identifier)` twice — Django was the same. Greenfield could make
  duplicate detection a constraint instead of a query, and it is far cheaper to decide before the
  table has rows.

## Carried forward from phase 3's review

Decisions phase 3's whole-phase review surfaced that belong to a **later** phase. Recorded here
because phase 3's workspace is deleted, not because they are open questions for phase 3.

- **Phases 5–13 (shadcn additions).** Every shadcn component in this repository is built on Base UI
  (`@base-ui/react`), not Radix — compose with the `render` prop (see `src/components/app-sidebar.tsx`
  and `src/components/route-breadcrumbs.tsx`), never Radix's `asChild`. Phase 3's own plan
  (`nextjs-03-app-shell.md`) pasted `asChild` snippets throughout and none of them typechecked as
  written. Expect the same friction from any shadcn/Radix example copied into phases 5–13.
- **Phase 4 (auth) must create a `user_settings` row in the same transaction that creates a user.**
  `getSettings()` (`src/lib/settings/queries.ts`) throws when the row is absent, by design — there is
  no insert-if-absent fallback there (see the file's own comment on why). Only the root layout's two
  reads degrade instead of throwing (locale → the browser's `Accept-Language`, theme → `system`); the
  dashboard and `/settings` still surface the real error through the error boundary. Without a
  settings row, a newly signed-up user would fail both.
- **Amended in phase 4 (task 4), by human ruling: a request with no stored preference negotiates its
  locale from `Accept-Language`.** Phase 3 decided the locale comes from `user_settings.language`
  and from nothing else, and for a *signed-in* user that still holds exactly — a browser header must
  never override a choice made in the application. But /login renders without a session, so there is
  no row to read, and the phase-3 rule made the first screen a German visitor ever sees English,
  with no control on it to change that. `negotiateLocale()` (`src/i18n/locale.ts`) picks between
  `en` and `de` on the fallback path in `src/i18n/request.ts` only. `<html lang>` follows it, since
  the root layout reads the same `getLocale()`.
- ~~**`timeZone` is not set in `src/i18n/request.ts`**~~ **Closed by phase 4**, and this paragraph
  contradicted the "Deferred" table above it, which already records the decision as settled. It
  **is** set — `process.env.TZ || "UTC"` — because the account page's passkey list is the first
  rendered date and an unset zone means next-intl falls back to the *environment's*: the container's
  on the server, the visitor's own in the browser, which is a hydration mismatch plus an
  ENVIRONMENT_FALLBACK warning on every render. Only the **per-user** half is still open, and only
  as a question phases 5–10 may answer with a `user_settings.time_zone` column. Do not re-litigate
  the deployment-wide default.

### Known gaps

Deliberately not fixed in phase 3 — small enough to defer, but each should be a known gap rather than
a later surprise:

- ~~**`<Select>` still renders raw enum values unless the call site passes `items`.** The two selects
  on `/settings` were fixed by passing `items` (which feeds trigger and popup from one list, so they
  cannot drift), but `src/components/ui/select.tsx` leaves the trap reachable: a new `<Select>` with
  no `items` silently shows `light`/`de` instead of a label. Base UI cannot resolve labels itself —
  `SelectValue`'s `children` callback is typed `(value: any)`, which would break the compiler-checked
  catalog keys, and `SelectRootContext` is not in the package's `exports` map, so the primitive has no
  legitimate way to self-check. Guarded today only by a doc comment there and one disciplined call
  site. **Phase 5 is the first phase to add new selects: close this then**, with a stricter app-level
  props type requiring `items`, or an ESLint rule flagging a `<Select>` without it. A comment is not a
  guard once there are nine phases of call sites.~~ **Closed.** Phase 5 took the first of the two
  options (human ruling D): `src/components/ui/select.tsx` re-declares Base UI's root props with
  `Required<Pick<…, "items">>`, so a `<Select>` without them fails `npm run typecheck` rather than
  shipping a trigger that prints `dark` or `user,admin`. The type was chosen over a lint rule because
  it also states the requirement where a caller reads it. It makes you pass _something_, not the
  right thing: build the one list and render the `<SelectItem>`s from it, and assert against the
  trigger's `[data-slot="select-value"]` — the popup is never consulted for the collapsed label, so
  a test that only opens it proves nothing.
- `src/test/next-navigation.ts`'s `pathname` module state defaults to `"/"`, and nothing forces a test
  to call `setPathname()` before rendering — a future test that forgets would quietly assert against
  the wrong route. Make the default `undefined` and throw.
- ~~`breadcrumbsFor` falls back to the raw URL segment, so a planned route like `/feeds/new` will
  render an untranslated `new`.~~ **Closed.** `ACTION_LABELS` in `src/lib/nav.ts` maps action
  segments to catalog keys, keyed by segment rather than by full href so one entry covers every
  resource. `new` is the only entry, because it is the only action that is really a URL segment —
  the CRUD phases put editing at `/tags/[id]`, not `/tags/[id]/edit`. **When adding a route whose
  last segment is a word rather than an id, add it there**, or the breadcrumb echoes the URL.
  Unlisted segments keep rendering verbatim, which is what record ids need.
- `src/app/(app)/loading.tsx` uses a 4-column `TableSkeleton` for every route in the group, including
  the settings form.
- `messages.test.ts` checks key parity but not ICU **placeholder** parity — a translation dropping
  `{minutes}` fails silently.
- `GeneralSection` applies the theme locally before the server write is confirmed and never rolls back
  on failure — the pattern every later CRUD form will copy.
- Dead catalog keys: `common.cancel`, `common.loading`. (`nav.account` was on this list and is
  live — phase 4's sidebar footer and `UNLISTED_ROUTES` in `src/lib/nav.ts` both read it.)
- Changing the language also rewrites the theme column to the local `localStorage` value.
- `global-error.tsx` is English-only (no provider, and the locale lives in SQLite, not a cookie), and
  carries no font variables or `<title>`.
- Async server components (`settings/page.tsx`, `Sections`, `LibrarySummary`) cannot be rendered by
  testing-library and stay untested. Production code was deliberately **not** reshaped to make them
  testable; the data they read is covered by the real-database tests instead.

The jsdom + testing-library harness that closes the last of these was **built at the end of phase 3**
rather than deferred, because it would have caught three of the phase's own defects — the nested
`<main>` that five reviews missed, the theme display/applied divergence, and the raw-value selects.
Every structural assertion it carries was verified by reintroducing the original defect and watching
the test fail. Extend it rather than reinventing it: see `CLAUDE.md`'s Testing convention.
