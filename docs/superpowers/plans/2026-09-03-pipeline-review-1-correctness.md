# Pipeline Review 1 — Correctness Bugs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five confirmed correctness bugs in the aggregation / reload /
AI-application path that cost money on every cycle or behave differently per
account. Each was found by a comprehensive review on 2026-09-03 and each is
invisible to the current 2443-test suite.

**Context — why these five together:** they share one root cause. In every case
the same rule is implemented in two places and one copy drifted, while a comment
asserts the drift cannot happen. Fixing them individually is cheap; the
*structural* de-duplication that prevents recurrence is plan 3, which should not
be started until this plan is merged and green.

**Architecture:** Five independent, surgical fixes. No new modules, no schema
changes, no migrations. Each task is self-contained and can be done in any
order, but each must land with a regression test that fails before the fix.

**Tech Stack:** TypeScript, Drizzle ORM + better-sqlite3, Vitest (real migrated
SQLite per test, no driver mocks).

## Execution model — read this first

All four plans run in **one session on one branch**, with the model's context
cleared repeatedly along the way. **Nothing is merged until the last change of
plan 4.** Two consequences, and neither is optional:

- **This file is the progress record.** Tick each `- [ ]` to `- [x]` as you
  finish it, in the same commit as the work. After a context clear, the only
  reliable answer to "where am I" is this file plus `git log`. A finished step
  left unticked will be redone; an unfinished step ticked early will be skipped.
- **Commit per task, never per plan.** Use the message prefix
  `refactor(review-N): Task M — <what>` (or `fix(...)`/`test(...)` as
  appropriate) so `git log --oneline` reconstructs progress at a glance. A
  single giant commit is unbisectable, and with no intermediate merge there is
  no CI run to catch a bad one.

### Resuming after a context clear

1. `git log --oneline -20` — find the last `review-N` commit.
2. Open this file and find the first unticked `- [ ]`.
3. If the two disagree, trust `git log` and the working tree, not the
   checkboxes — then correct the checkboxes.
4. `git status` must be clean before starting a new task. If it is not, the
   previous task was interrupted mid-edit: finish or revert it first.
5. Re-read the task's own "The bug" preamble before touching code. Every task
   here restates its evidence with `file:line` precisely so a cleared context
   does not have to trust a summary.

### Verification, given nothing merges

`npm run lint && npm run format:check && npm run typecheck && npm test` must be
green **at the end of every task**, not just at the end of the plan. With no
intermediate merge there is no CI safety net, so the local suite is the only
signal — and a break introduced in plan 1 that surfaces in plan 4 is
expensive to locate. Do not defer verification to "the end".

Full context for all four plans:
`docs/superpowers/specs/2026-09-03-pipeline-review-findings.md`.

## Global Constraints

- Every write goes through `writeTransaction()` (`BEGIN IMMEDIATE`) and its
  callback must be **synchronous**.
- Real-database tests only, via `src/lib/db/test-support.ts`. No driver mocks.
- `.test.ts` is the node project; `.test.tsx` is jsdom. Everything in this plan
  is `.test.ts`.
- Before pushing: `npm run lint && npm run format:check && npm run typecheck && npm test`.
- **Every task must add a test that fails before the fix and passes after.**
  Verify the failure first — a test written after the fix proves nothing.

---

### Task 1: `run.ts` must resolve the model through `resolveModel()`

**The bug.** `getAiStatus()` (`src/lib/ai/queries.ts:123`) runs every stored
model id through `resolveModel()` (`src/lib/ai/columns.ts:127`), which
substitutes `provider.defaultModel` for an id absent from the registry. But
`src/lib/ai/run.ts` reads the raw column at lines 344, 366, 403, 450, 461, 474
and 487, and `src/app/api/v1/ai/prompt/route.ts:80` does the same when reporting
which model answered.

Migration `drizzle/0003_ai_model_defaults.sql` changed only the column `DEFAULT`
(line 19); its `INSERT INTO __new_user_settings … SELECT` at line 40 copies
existing values verbatim. So every `user_settings` row created before `0003`
still holds `gpt-4o-mini` / `claude-3-5-sonnet-20240620` / `gemini-1.5-flash`
(`drizzle/0000_loud_hemingway.sql:179,182,185`).

For such a row: `/ai` renders the *substituted* current model with a green
badge, and Test passes because the probe uses the submitted, registry-validated
id — while every aggregation job sends the retired id, gets a 404, and every
article's AI stage fails permanently. The only trace is a per-article
`AI processing did not complete (providerError)` line in a job log.

**This outlives the particular migration.** The next registry refresh
reintroduces it for every row written before it.

**Files:**
- Modify: `src/lib/ai/run.ts`
- Modify: `src/app/api/v1/ai/prompt/route.ts`
- Modify: `src/lib/ai/run.test.ts`

**Interfaces:**
- Consumes: `resolveModel(provider, stored)` from `@/lib/ai/columns`,
  `AI_PROVIDERS` from `@/lib/ai/providers`.

- [x] **Step 1: Write the failing test**

In `src/lib/ai/run.test.ts`, add a case that builds settings with
`activeAiProvider: "gemini"`, `geminiEnabled: true`, `geminiApiKey: "k"` and
`geminiModel: "gemini-1.5-flash"` (a retired id absent from `AI_PROVIDERS`),
stubs `fetch`, calls `generateResponse("hi")`, and asserts the request URL
contains `AI_PROVIDERS.find(p => p.key === "gemini")!.defaultModel` rather than
`gemini-1.5-flash`. Confirm it FAILS before continuing.

- [x] **Step 2: Resolve the model in each provider branch**

In each of the seven `callXxx()` methods, replace the raw column read plus
hardcoded literal with a `resolveModel()` call against the provider's registry
entry. Do **not** invent a second lookup helper — import `resolveModel` and
`AI_PROVIDERS` and use them.

Note `resolveModel()` already handles OpenRouter's `hasDynamicModels` case
correctly (a non-empty stored value is trusted outright, because its `models`
array is only a 2-entry fallback, not the valid set). Do not special-case it
here.

- [x] **Step 3: Delete the seven hardcoded default-model literals**

Once `resolveModel()` supplies the fallback, the `?? "gpt-4o-mini"`-style tails
at `run.ts:344,366,403,451,463,476,489` are dead. Remove them. Three of the
seven currently disagree with `providers.ts` — `gpt-4o-mini` vs `gpt-5.6-luna`,
`claude-sonnet-4-20250514` vs `claude-haiku-4-5`, and `gemini-3-flash-preview`
vs `gemini-3.5-flash-lite`. The Gemini one is the sharpest: `providers.ts:238`
explicitly *excludes* `gemini-3-flash-preview` from the registry, in a comment
about previews being withdrawn out from under a stored setting.

- [x] **Step 4: Fix the reported model in the prompt endpoint**

`src/app/api/v1/ai/prompt/route.ts:80` reports the raw column as the model that
answered. Route it through `resolveModel()` so the reported value matches the
value actually sent.

- [x] **Step 5: Add a drift guard**

`src/lib/ai/defaults.test.ts` already compares the *column* defaults against
`providers.ts`. Extend it (or add beside it) a test asserting that `run.ts`
contains no hardcoded model-id literal — a specifier-style tripwire in the style
of `src/lib/avatar.test.ts`, matching e.g. `/"(gpt|claude|gemini|mistral|qwen|deepseek|openrouter)[-/][a-z0-9.\-]+"/`
against the file's source. Without this, step 3 is undone by the next person who
adds a provider.

- [x] **Step 6: Verify** — `npm test src/lib/ai` then the four CI checks.

---

### Task 2: Reddit and YouTube comments must not be inside the content hash

**The bug.** `articleContentHash()` deliberately excludes the comment section so
that "a comment changing is not the article changing"
(`src/lib/aggregators/content-hash.ts`). `withoutComments()` at
`content-hash.ts:34-37` cuts the body at the marker `COMMENTS_OPENING_TAG` =
`` `<section data-sanitized-class="${ARTICLE_COMMENTS_CLASS}">` ``, which
`formatArticleContent()` (`src/lib/aggregators/extract/format.ts:178-208`)
emits **only when passed its `commentsContent` argument**.

Three sites pass it: `sites/heise.ts:407`, `sites/mactechnews/aggregator.ts:230`,
`sites/mein_mmo/aggregator.ts:219`.

Two do not:
- `sites/reddit/content.ts:262` pushes a **bare** `<section>…</section>` into
  `contentParts`, and `sites/reddit/aggregator.ts:884-892` calls
  `formatArticleContent(content, name, identifier, labels, null, null, null, headerHtml)`
  — `commentsContent` is `null`.
- `sites/youtube/aggregator.ts:305-321` appends `<div class="youtube-comments">`
  into `htmlContent`; `aggregator.ts:446` passes no comments argument at all.

Neither string matches the marker, so `withoutComments()` strips nothing.

**Cost.** Any Reddit post or YouTube video whose top comments change between
runs — i.e. every active one — gets a different `contentHash` every cycle. The
row is rewritten, the block tree deleted and reinserted, `updatedAt` bumped back
into `/api/v1`'s sync `updated` stream, and — the expensive part — **one paid AI
request per article per cycle** on feeds with AI options on.

`content-hash.ts:128` even names the three sites this exclusion was written for
and silently omits these two.

**Files:**
- Modify: `src/lib/aggregators/sites/reddit/content.ts`
- Modify: `src/lib/aggregators/sites/reddit/aggregator.ts`
- Modify: `src/lib/aggregators/sites/youtube/aggregator.ts`
- Modify: `src/lib/aggregators/content-hash.test.ts`
- Modify: the reddit and youtube aggregator test files

**Interfaces:**
- Changes: `buildPostContent()` returns the comment section separately rather
  than concatenated into the body.

- [x] **Step 1: Write the failing tests**

In `content-hash.test.ts`, add two cases: build a Reddit article's content and a
YouTube article's content with two different comment sets but identical article
bodies, and assert `articleContentHash()` returns the **same** value for both.
Confirm both FAIL before continuing.

- [x] **Step 2: Have `buildPostContent()` return body and comments separately**

Change `sites/reddit/content.ts`'s `buildPostContent()` to return
`{ body: string; comments: string | null }` instead of one concatenated string.
`addCommentsSection` (`content.ts:220-262`) currently pushes into
`contentParts`; have it return its section instead.

- [x] **Step 3: Pass the comments through the proper parameter**

At `sites/reddit/aggregator.ts:884`, pass the returned `comments` as
`formatArticleContent`'s `commentsContent` argument instead of `null`. Note
`fetchArticleContent()` (`aggregator.ts:696-706`) also calls `buildPostContent()`
— update that call site for the new return shape; it should concatenate as
before, since reload re-derives everything.

- [x] **Step 4: Same for YouTube**

`sites/youtube/aggregator.ts:305-321` builds `<div class="youtube-comments">`
inline into `htmlContent`. Extract it and pass it as `formatArticleContent`'s
`commentsContent` at `aggregator.ts:446`.

- [x] **Step 5: Add a cross-site guard**

Add a test asserting that for **every** registered aggregator that produces a
comment section, the section is wrapped in `ARTICLE_COMMENTS_CLASS`. If a
generic assertion is impractical, at minimum extend `content-hash.test.ts` with
one case per commenting site (heise, mactechnews, mein_mmo, reddit, youtube), so
a sixth site added later has an obvious pattern to copy.

- [x] **Step 6: Verify** — `npm test src/lib/aggregators` then the four CI checks.

---

### Task 3: The scheduler must not enqueue duplicate aggregations

**The bug — two independent causes.** `src/lib/jobs/scheduler.ts:82-86` builds
its dedupe set from:

```ts
.where(and(eq(jobs.kind, "aggregate"), eq(jobs.status, "pending")))
```

**Cause 1 — `status = 'pending'` only.** `feeds.updatedAt` is the "last
aggregated" marker and is written at the **end** of `handleAggregateJob`
(`src/lib/jobs/handlers/aggregate.ts:288`). While a job is `running` the feed
still looks overdue *and* is no longer `pending`. The tick interval is 60s
(`scheduler.ts:35`); an AI-enabled aggregation takes minutes. So **every
aggregate job that outlives one tick gets a duplicate enqueued**, and with
`WORKER_CONCURRENCY = 4` both run concurrently: two fetch passes, two sets of
paid AI requests, and two writers racing the same `(feedId, identifier)` rows.

**Cause 2 — `kind = 'aggregate'` only, but three kinds run the same handler.**
`src/lib/jobs/handlers/index.ts:26-30` registers `aggregate`, `feed.update` and
`feed.restore` all onto `handleAggregateJob`, and `updateFeedsBulk`
(`src/lib/feeds/actions.ts:537`) enqueues kind **`"feed.update"`**. A user
clicking "Update feeds" therefore creates jobs the scheduler cannot see, and it
enqueues a second concurrent `aggregate` for the same feeds.

**Files:**
- Modify: `src/lib/jobs/scheduler.ts`
- Modify: `src/lib/jobs/scheduler.test.ts`

- [ ] **Step 1: Write the failing tests**

Two cases in `scheduler.test.ts`: (a) an overdue feed with an existing
**`running`** aggregate job → `tick()` enqueues nothing; (b) an overdue feed with
an existing pending **`feed.update`** job → `tick()` enqueues nothing. Confirm
both FAIL.

- [ ] **Step 2: Widen the dedupe query**

Change the `where` to cover every kind that runs the aggregate handler and every
non-terminal status:

```ts
and(
  inArray(jobs.kind, ["aggregate", "feed.update", "feed.restore"]),
  inArray(jobs.status, ["pending", "running", "cancelling"]),
)
```

Derive the kind list from the handler registry if that is clean to do, rather
than a third hand-written literal — `handlers/index.ts` is the source of truth
for which kinds run `handleAggregateJob`.

- [ ] **Step 3: Note the follow-up, do not do it here**

`feeds.updatedAt` is overloaded — it carries `$onUpdate`, so *any* feed write
(a logo store at `src/lib/feeds/logo.ts:284`, a `/feeds` edit) postpones the
next aggregation by a full interval. The clean fix is a dedicated
`feeds.lastAggregationStartedAt` stamped at claim time. That needs a migration
and belongs in **plan 2**, not here. Add a `TODO` comment at `scheduler.ts:109`
pointing at it.

- [ ] **Step 4: Verify** — `npm test src/lib/jobs` then the four CI checks.

---

### Task 4: Daily-limit pacing must not be recomputed with `collectedToday = 0`

**The bug.** `BaseAggregator.aggregate()`
(`src/lib/aggregators/base.ts:350-370`) computes
`limit = this.getCurrentRunLimit(clock, collectedToday)` and passes it to
`fetchSourceData(limit)`. But:

- `RssAggregator.fetchSourceData()` (`src/lib/aggregators/rss.ts:16`) **ignores
  its `limit` parameter entirely** (it is named `_limit`).
- `RssAggregator.parseToRawArticles()` (`rss.ts:70`) calls
  `this.getCurrentRunLimit()` with **no arguments**, so `collectedToday` falls
  back to its `= 0` default (`base.ts:142`) — and this second, unpaced
  computation is the only thing that actually truncates the entry list.
- `sites/podcast.ts:118` does the same.

`FullWebsiteAggregator extends RssAggregator`, so this is the effective path for
**14 of the 16 registered aggregators**. Only `sites/reddit/aggregator.ts:190`
and `sites/youtube/aggregator.ts:183` honour the `limit` argument.

Concrete failure: `dailyLimit = 20`, 18 already collected, run at 18:00.
`aggregate()` computes `limit = 1` correctly. `parseToRawArticles()` recomputes
with `collected = 0` → `targetQuota = 15` → slices **15** entries. The feed
stores 33 articles in a day against a limit of 20.

This is exactly the bug the comment at
`src/lib/jobs/handlers/aggregate.ts:37-45` claims to have fixed. The handler was
fixed; the two call sites inside the aggregators were not, and the handler's
`collectedToday` is discarded before it can do anything.

**Files:**
- Modify: `src/lib/aggregators/base.ts`
- Modify: `src/lib/aggregators/rss.ts`
- Modify: `src/lib/aggregators/sites/podcast.ts`
- Modify: `src/lib/aggregators/base.test.ts`, `rss.test.ts`

- [ ] **Step 1: Write the failing test**

Build an `RssAggregator` over a feed with `dailyLimit: 20` and a source with 30
entries, call `aggregate(clock, /* collectedToday */ 18)`, and assert at most 2
articles come back. Confirm it FAILS (it will return ~15).

- [ ] **Step 2: Make the limit a parameter, not a recomputation**

Change the abstract signature to
`parseToRawArticles(sourceData: unknown, limit: number): Promise<RawArticle[]>`
and have `aggregate()` pass the already-computed `limit`. Update every override
(`rss.ts`, `podcast.ts`, `reddit/aggregator.ts`, `youtube/aggregator.ts`, and any
site override) to use the parameter and **never** call `getCurrentRunLimit()`
themselves.

This is the structural fix: with the limit arriving as an argument, it cannot be
recomputed with the wrong inputs. Making `getCurrentRunLimit()` `private` after
this change would enforce it — do that if no legitimate external caller remains.

- [ ] **Step 3: Make the cutoff clock injectable for consistency**

`filterArticles()` (`base.ts:200-203`) hardcodes `new Date(Date.now() - …)`
while `getCurrentRunLimit()` accepts an injectable clock. Thread the same
`clock` through so both time-dependent decisions in one pipeline are testable
the same way.

- [ ] **Step 4: Verify** — `npm test src/lib/aggregators` then the four CI checks.

---

### Task 5: `feed.userId` must not be `parseInt`'d

**The bug.** `src/lib/db/schema/feeds.ts:79` declares
`userId: text("user_id")`, and a Better Auth id is a 32-char alphanumeric
**string** (the repo pins this pattern in `avatarFilePath()`). But
`src/lib/aggregators/base.ts:249-259` does:

```ts
const userId =
  typeof this.feed.userId === "number" ? this.feed.userId
  : typeof this.feed.userId === "string" ? parseInt(this.feed.userId, 10) || null
  : null;
```

`parseInt("aB3x…")` → `NaN` → `null`. But an id beginning with a digit (10 of 62
possible first characters, ~16% of ids) yields a meaningless truncated integer —
`parseInt("7fKq…")` → `7`, which is truthy.

Downstream the value is threaded `extractHeaderElement(url, alt, userId, onLog)`
(`header/extractor.ts:91-98`) → `HeaderElementContext.userId`
(`header/context.ts:9`, typed `number | null`) → exactly one consumer:
`fetchSubredditIcon(subreddit, userId)` (`header/strategies.ts:38-42`), which
begins `if (!subreddit || !userId) return null;`. **It is used only as a
truthiness gate** — never in a path, never in a query, never in the request.

Symptom: `RedditPostStrategy` silently returns `null` for ~84% of users and
works for ~16%, decided purely by whether their random id starts with a digit.
The extractor then falls through to `GenericImageStrategy`, so the article gets
the reddit page's `og:image` instead of the subreddit icon. Same feed, same URL,
different header image depending on which account owns it, nothing logged.

The same class gets it right one line away: `BaseAggregator.chromeLabels()`
(`base.ts:92`) passes the same field to `resolveChromeLabels()`, which does
`String(userId)` (`chrome-labels.ts:75`) and works.

The existing test pins the bug rather than the intent:
`header/extractor.test.ts:102` calls `fetchSubredditIcon("typescript", 42)` — a
number literal no production call site can produce.

**Decision: delete the parameter rather than fix the conversion.** It is a gate
with no reason to exist — the value is never used for anything but a null check.

**Files:**
- Modify: `src/lib/aggregators/base.ts`
- Modify: `src/lib/aggregators/header/context.ts`
- Modify: `src/lib/aggregators/header/extractor.ts`
- Modify: `src/lib/aggregators/header/strategies.ts`
- Modify: `src/lib/aggregators/header/extractor.test.ts`

- [ ] **Step 1: Write the failing test**

Assert that `extractHeaderElement()` on a reddit permalink attempts the
subreddit-icon fetch for a feed whose `userId` is a realistic Better Auth id
starting with a letter (e.g. `"aB3xY9kLmNoPqRsTuVwXyZ0123456789"`). Confirm it
FAILS.

- [ ] **Step 2: Remove the `userId` parameter entirely**

Drop it from `fetchSubredditIcon()`, `HeaderElementContext`,
`HeaderElementExtractor.extractHeaderElement()` and
`BaseAggregator.extractHeaderElement()` — four signatures, ~15 lines including
the `parseInt` block. `fetchSubredditIcon` keeps its `if (!subreddit) return null`
guard.

- [ ] **Step 3: Narrow `FeedLike.userId`**

`base.ts:13` declares `userId?: string | number | null`, wider than the real
`Feed.userId: string`. The `number` arm is unreachable legacy from the Django
port, where user ids were integers, and is what made the `parseInt` look
plausible. Narrow it to `string | null`, and simplify `chrome-labels.ts:65-76`'s
`String(userId)` accordingly if its signature narrows too.

- [ ] **Step 4: Fix the test that pinned the bug**

`header/extractor.test.ts:102`'s `fetchSubredditIcon("typescript", 42)` must
lose its second argument.

- [ ] **Step 5: Verify** — `npm test src/lib/aggregators` then the four CI checks.

---

## Done criteria

- [ ] All five tasks complete, each with a regression test verified to fail
      before its fix.
- [ ] `npm run lint && npm run format:check && npm run typecheck && npm test`
      all green.
- [ ] No new lint warnings beyond the 35 pre-existing ones.
- [ ] `CLAUDE.md` updated where a documented invariant changed — specifically
      the `contentHash` comment in `src/lib/db/schema/articles.ts` if Task 2
      alters what the fingerprint covers, and the aggregation bullets if Task 4
      changes `parseToRawArticles`'s signature.
