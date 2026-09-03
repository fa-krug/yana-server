# Pipeline Review 2 — Data Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** plan `2026-09-03-pipeline-review-1-correctness.md` complete,
with `npm test` green in the working tree. Nothing is merged between plans (see
"Execution model" below). Task 6 completes a `TODO` plan 1 leaves at
`scheduler.ts:109`.

**Goal:** Close the paths that lose data permanently, leak disk forever, or
leave a client's local store inconsistent with the server. Found by a
comprehensive review on 2026-09-03.

**Architecture:** Two new capabilities — a pre-flight AI-configuration check in
front of enqueueing, and a mark-and-sweep media GC in the nightly retention job
— plus four invariant repairs to existing write paths. One migration (Task 6).

**Tech Stack:** TypeScript, Drizzle ORM + better-sqlite3, zod, Vitest (real
migrated SQLite per test, no driver mocks), next-intl catalogs.

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

- Every write goes through `writeTransaction()` (`BEGIN IMMEDIATE`), callback
  **synchronous**.
- **Every hard-delete of an article writes an `articleTombstones` row in the
  same transaction.** This is the invariant stated at
  `src/lib/db/schema/articles.ts:120-130`; Task 3 exists because one path
  violates it.
- Deleting stored media must `unlink` the file, not only the row — the repo's
  own convention (see the avatar rules in `CLAUDE.md`).
- New columns get a `drizzle-kit generate` migration, never hand-written. A
  table that gains *and* loses columns in one generate cannot be produced
  non-interactively — split into two migrations.
- `messages/en.json` and `messages/de.json` stay key-for-key identical.
- Real-database tests only. Before pushing:
  `npm run lint && npm run format:check && npm run typecheck && npm test`.


## Amendment (2026-09-03, owner ruling during execution)

`restoreFeedsBulk()` (`src/lib/feeds/actions.ts:544`) was found to have **no
caller anywhere** — no UI, no `/api/v1` route, no catalog key; `grep -rn
"restoreFeeds" src` returns only the definition and one test. The `feed.restore`
path has been dead since it was written (the 2026-08-04 and 2026-08-05 plans
both list it among functions they did not change).

**Owner decision: delete the restore path entirely** rather than gate it. It is
the most destructive path in the codebase and nothing reaches it, so removing it
is strictly better than hardening it.

This supersedes three things in the plan text below, which are left in place for
their evidence but must NOT be implemented as written:

- **Task 0 is new** (below) and does the deletion. It runs first.
- **Task 1 Step 4** ("Gate restore before it deletes") is **dropped** — there is
  no restore to gate. Task 1's other six steps stand unchanged.
- **Task 3 Step 3** (starred articles in restore) is **moot**. The owner's
  ruling — restore should preserve starred articles, matching retention — is
  recorded here so it binds if `feed.restore` is ever reintroduced, but there is
  nothing to implement.
- **Task 2's** hard-delete site list loses `handlers/restore.ts:36`; three sites
  remain (`retention.ts:54`, `articles/actions.ts:105`, `feeds/actions.ts:496`).

---

### Task 0: Delete the dead `feed.restore` path

**Why.** Nothing calls it, and it deletes every article of a feed before
re-aggregating. `handleAggregateJob` covers the reachable case.

**No migration is needed:** `jobs.kind` is a plain `text` column
(`schema/jobs.ts:57`) with no CHECK constraint and no enum, and an unregistered
kind already fails its job cleanly (`worker.ts:138-141`) rather than crashing the
worker — so any historical `feed.restore` row in an existing database is inert.

**Files:**
- Delete: `src/lib/jobs/handlers/restore.ts`
- Modify: `src/lib/jobs/handlers/index.ts` (drop the import and registration)
- Modify: `src/lib/feeds/actions.ts` (drop `restoreFeedsBulk`)
- Modify: `src/lib/jobs/queue.ts` (drop `"feed.restore"` from
  `AGGREGATE_HANDLER_JOB_KINDS` at line 39, and its mentions at lines 28 and 453)
- Modify comments naming the kind: `src/lib/db/schema/jobs.ts:77`,
  `src/lib/jobs/log-bus.ts:9`, `src/lib/jobs/scheduler.ts:87`
- Modify: `src/lib/jobs/handlers/handlers.test.ts`,
  `src/lib/feeds/actions.test.ts` (drop the restore cases)

- [x] **Step 1:** Remove the handler, its registration, and `restoreFeedsBulk`.
- [x] **Step 2:** Narrow `AGGREGATE_HANDLER_JOB_KINDS` to
      `["aggregate", "feed.update"]`. **Care:** plan 1 Task 3 (commit `0aeeac70`)
      widened the scheduler's dedupe to exactly this constant — the dedupe must
      still cover both remaining kinds. Re-read that commit before editing.
- [x] **Step 3:** Update every comment that names `feed.restore` as a live kind.
      Do not leave a comment describing a handler that no longer exists.
- [x] **Step 4:** Delete the restore tests. Do not weaken a surviving test to
      make it pass.
- [x] **Step 5: Verify** — full four checks.

---

### Task 1: Refuse to enqueue aggregation for an AI-enabled feed with no working provider

**The bug.** `applyAiToBlocks()` (`src/lib/ai/run.ts:735-742`) returns
`{status: "failed", reason: "noProvider"}` for two **permanent** configuration
states — no `userSettings` row, and no `activeAiProvider`. `handleAggregateJob`
(`src/lib/jobs/handlers/aggregate.ts:178-207`) treats *every* `failed` outcome
identically: skip the article, write no row, write no `contentHash`, `continue`.

So for a feed with "translate" ticked and no AI provider configured:

- Every article is skipped; `created=0, updated=0`.
- The job **completes successfully** — `/jobs` is all green.
- The log says "it will be retried on the next run", which is true and useless.
- `feeds.updatedAt` is still bumped (`aggregate.ts:288`), so the scheduler
  re-runs on interval forever, producing an infinitely repeating no-op.

**This is permanent article loss.** `enrichArticles`
(`src/lib/aggregators/website.ts:206-214`) documents that "an aggregation run
only ever sees the entries the feed currently lists, so once this one ages out
of that window nothing refetches it." Skipped articles age out and are gone.

Compounding: `handleRestoreJob` (`src/lib/jobs/handlers/restore.ts:23-44`)
deletes every article of the feed *first* and then calls `handleAggregateJob`.
With a misconfigured provider, a restore is a total, silent, unrecoverable wipe.

**Decision (owner, 2026-09-03): refuse to enqueue at all.** Block aggregation
for an AI-enabled feed with no working provider and surface it as a feed
configuration error in the UI, rather than letting jobs run and fail per
article.

**Files:**
- Create: `src/lib/ai/readiness.ts`
- Modify: `src/lib/jobs/scheduler.ts`
- Modify: `src/lib/feeds/actions.ts`
- Modify: `src/lib/jobs/handlers/restore.ts`
- Modify: `src/components/feeds/` (the feed row/list — surface the state)
- Modify: `messages/en.json`, `messages/de.json`
- Create: `src/lib/ai/readiness.test.ts`; modify `scheduler.test.ts`,
  `handlers.test.ts`

**Interfaces:**
- Produces: `aiReadinessFor(feedOptions, settings): "ok" | "noProvider" | "notNeeded"`
  — consumed by the scheduler, the manual-update actions, and the feeds UI.

- [x] **Step 1: Write the failing tests**

(a) `tick()` does not enqueue for an overdue feed with `ai_translate: true`
whose owner has no `activeAiProvider`. (b) `updateFeedsBulk` reports a refusal
rather than enqueueing for such a feed. (c) `handleRestoreJob` deletes nothing
when the feed is in that state. Confirm all FAIL.

(Test (c) is dropped along with Step 4 below — `handlers/restore.ts` no longer
exists as of Task 0's deletion of the dead `feed.restore` path. Only (a) and
(b) were written, and both were confirmed failing before the fix.)

- [x] **Step 2: Build `aiReadinessFor()`**

One function, one place the rule lives. It must reuse `wantsAi()` from
`@/lib/ai/run` (do not write a second copy of "is AI on" — that predicate was
already duplicated once and drifted, see its doc comment) and
`activeProvider()` from `@/lib/ai/queries` (which correctly requires the
provider's `*Enabled` flag, unlike `run.ts`'s bare truthiness test on
`activeAiProvider`).

Return `notNeeded` when `wantsAi()` is false, `ok` when a provider resolves, and
`noProvider` otherwise.

- [x] **Step 3: Gate the three enqueue paths**

The scheduler (`scheduler.ts:117`), `updateFeedsBulk`
(`src/lib/feeds/actions.ts:537`) and any single-feed update action must consult
it. The scheduler should skip silently but log once per feed per tick — not once
per article. The user-triggered actions must return a catalog `errorKey` so the
UI can say *why*, never a raw string.

(The single-feed update action is `updateFeedsBulk` itself — `feed-form.tsx`'s
"Update now" calls it with a one-element array — so gating `updateFeedsBulk`
covers both. `POST /api/v1/aggregate` also enqueues `"aggregate"` jobs, one per
enabled feed of the Bearer-authenticated caller; left ungated, since it is not
one of the three paths this step names and the native client has no UI here to
surface a refusal to — flagged in the report as worth a follow-up.)

- [x] ~~**Step 4: Gate restore before it deletes**~~ — **dropped**. Superseded
  by the amendment above: Task 0 deleted `handlers/restore.ts` (and the dead
  `feed.restore` path entirely) immediately before this task ran, so there is
  no restore left to gate.

- [x] **Step 5: Surface it in the feeds UI**

A feed in `noProvider` state needs a visible badge or warning in the feed list
linking to `/ai`. Both catalogs get the key. Follow the existing
`section-kit.tsx` reporting conventions — a catalog key, never provider prose.

- [x] **Step 6: Keep the per-article arm for transient failures**

Do **not** remove `aggregate.ts`'s skip-and-retry — it remains correct for
genuinely transient reasons (a 429, a 503). This task removes the *permanent*
reasons from ever reaching it. Add a comment at `aggregate.ts:178` recording
that split, so a future reader does not "simplify" the pre-flight check away.

- [x] **Step 7: Verify** — `npm test src/lib/jobs src/lib/ai src/lib/feeds`, then CI.

---

### Task 2: Mark-and-sweep GC for article images

**The bug.** `grep -rn "unlink" src` outside tests returns only
`auth/bootstrap.ts`, `users/actions.ts` and `account/actions.ts` — the avatar
path. There is no `fs.unlink`, no `fs.rm` and no `delete(articleImages)`
anywhere else in the tree.

Four hard-delete sites for articles, none of which touch `article_images` rows
or files:
- `src/lib/jobs/handlers/retention.ts:54` (the nightly job, highest volume)
- `src/lib/jobs/handlers/restore.ts:36`
- `src/lib/articles/actions.ts:105`
- `src/lib/feeds/actions.ts:496` (also orphans `feeds.logoImageHash`)

So `media/article_images/` and the `article_images` table grow **monotonically
for the lifetime of the instance**. At the default 60-day
`articleRetentionDays`, every image ever fetched outlives its article
permanently.

**Why not a per-article delete.** Images are content-addressed
(`article_images/<sha256>.<ext>`, `src/lib/aggregators/images/store.ts:139`) and
**shared with no refcount** — one row can be referenced by many articles across
many users, because two feeds carrying the same wire photo dedupe to one hash.
Deleting "this article's images" would break other users' articles.

**Decision (owner, 2026-09-03): mark-and-sweep in the retention job.**

Note `findImageRefs()` (`store.ts:48-60`) is exported, tested
(`store.test.ts:50`) and has **zero production callers** — it looks exactly like
the helper a sweep was going to use, written and never wired up. Reuse it.

**Files:**
- Modify: `src/lib/aggregators/images/store.ts` (add the sweep)
- Modify: `src/lib/jobs/handlers/retention.ts`
- Modify: `src/lib/aggregators/images/store.test.ts`,
  `src/lib/jobs/handlers/handlers.test.ts`

- [x] **Step 1: Write the failing test**

Store two images, reference one from an article block, delete the other's
article, run the sweep, and assert the unreferenced row **and its file** are
gone while the referenced one survives. Confirm it FAILS.

- [x] **Step 2: Enumerate every reference root**

The live roots are `articleBlocks.imageRef`, `articleBlocks.embedThumbnailRef`
and `feeds.logoImageHash`. **Read the schema and confirm this list is complete
before writing the sweep** — a missed root deletes a live image, which is far
worse than the leak being fixed. If any column stores a ref inside prose rather
than as a column, `findImageRefs()` is the helper for extracting it.

- [x] **Step 3: Implement the sweep**

Select every `article_images.contentHash` not present in the union of roots,
delete those rows and `fs.rm` their files. Chunk both the query and the delete —
`SQLITE_MAX_VARIABLE_NUMBER` is 999 on some builds, and
`blocks/storage.ts:142-147` already chunks its inserts at 100 for exactly this
reason.

Delete the **row and the file in the right order**: unlink first, then the row,
or a crash between them leaves a row pointing at nothing (unservable) rather
than a file nothing points at (merely leaked). Prefer leaking to breaking.

- [x] **Step 4: Wire it into the retention job**

`handlers/retention.ts` runs once per boot across every user. Run the sweep
**after** the article deletions in the same job, so a run cleans up what it just
orphaned. Log the count swept to the job output.

- [x] **Step 5: Consider directory sharding — decide, do not silently skip**

`media/article_images/` is flat, one file per hash
(`store.ts:139`). With cleanup in place, growth is bounded, so sharding may no
longer be needed. If you decide against it, record that decision in a comment;
if for it, note that existing files must be migrated, which makes it its own
task rather than a step here.

- [x] **Step 6: Verify** — `npm test src/lib/aggregators/images src/lib/jobs`, then CI.

---

### Task 3: `deleteArticles()` must write tombstones

**The bug.** `src/lib/articles/actions.ts:103-111` deletes rows directly. Every
other hard-delete path writes an `articleTombstones` row first, in the same
transaction — `handlers/retention.ts:28-57`, `handlers/restore.ts:23-39`,
`feeds/actions.ts:481-492` — and `src/lib/db/schema/articles.ts:120-130` states
the rule as an invariant: "Every hard-delete path … must insert one of these."

Consequence: a native client that has synced these articles never learns they
were deleted. They stay in the client's local store indefinitely;
`syncArticles`'s `removed` stream will never mention them.

**Files:**
- Modify: `src/lib/articles/actions.ts`
- Modify: `src/lib/articles/actions.test.ts`

- [x] **Step 1:** Write a failing test asserting a tombstone row exists after
      `deleteArticles()`.
- [x] **Step 2:** Insert the tombstones **inside the same `writeTransaction`** as
      the delete. Copy the shape from `retention.ts:36-44`; do not invent a
      variant.
- [ ] **Step 3:** (moot — `restore.ts` was deleted earlier in this plan per the
      Amendment above; there is no restore path left to compare against.)
- [x] **Step 4: Verify.**

---

### Task 4: `updateArticle()` must not silently duplicate an article across feeds

**The bug.** `src/lib/articles/actions.ts:53-84` allows `feedId` to change and
(deliberately) leaves `contentHash` alone. But the aggregate handler looks a row
up by `(feedId, identifier)` (`aggregate.ts:64-69`, `220-224`). Move article X
from feed A to feed B, and feed A's next run finds no row for X's identifier and
**inserts a fresh duplicate**.

`src/lib/db/schema/articles.ts:56-58` names this exact case — "and `feedId`,
which is half the key the handler looks a row up by" — but the code no longer
honours it. Leaving `name`/`date` alone is correct (the hash is over the *source*
article now); `feedId` is not, because it is a lookup key.

**Files:**
- Modify: `src/lib/articles/actions.ts`
- Modify: `src/lib/db/schema/articles.ts` (doc drift, below)
- Modify: `src/lib/articles/actions.test.ts`

- [x] **Step 1:** Write a failing test: move an article to another feed, re-run
      aggregation on the original feed, assert no duplicate appears.
- [x] **Step 2:** Decide and implement. Either forbid changing `feedId` here, or
      write a tombstone for the old `(feedId, identifier)` pair so the original
      feed treats it as deliberately removed. Forbidding is simpler and is the
      recommended default — surface a catalog `errorKey`.
- [x] **Step 3: Fix the doc drift.** `schema/articles.ts:62-65` **and** the
      `contentHash` bullet in `CLAUDE.md` both still assert that
      `updateArticle()` nulls `contentHash`. It has not since the source-hash
      change. A future writer reading the invariant is actively misled about
      which writers comply. Correct both.
- [x] **Step 4: Verify.**

---

### Task 5: Reddit must honour `filterArticles` and must not store empty articles

**Bug A — `super` is never called.**
`src/lib/aggregators/sites/reddit/aggregator.ts:330-368` overrides
`filterArticles()` and builds its list from scratch. Every other override
(`heise.ts:280`, `caschys_blog.ts:57`, `mactechnews/aggregator.ts:101`,
`tagesschau/aggregator.ts:127`) starts with
`await super.filterArticles(articles)`.

So the feed's `maxArticleAgeDays` column is replaced by a hard-coded 60-day
window at `aggregator.ts:335`, and `promotionalLabelOf()` never runs — the
`skip_ads` option silently does nothing on Reddit, including its `onLog` trail,
so an operator gets no signal either way.

**Bug B — empty articles are stored permanently.**
`src/lib/aggregators/website.ts:215-220` refuses to store an article with no
body, with a long comment on why the drop is permanent if you get it wrong.
Reddit bypasses that path: `reddit/aggregator.ts:409-414` catches any
non-`ArticleSkipError` failure, sets `raw_content = ""; content = ""` and
**returns the article**. `aggregate.ts` has no `hasBodyContent` guard of its own
(the only call sites are `website.ts:215` and `reload.ts:213`).

A transient failure inside `buildPostContent()` therefore stores a permanently
empty article — and `articleContentHash({content: ""})` is stable, so the next
run computes the same hash, skips the row, and it is never repaired.

**Files:**
- Modify: `src/lib/aggregators/sites/reddit/aggregator.ts`
- Modify: the reddit aggregator test file

- [ ] **Step 1:** Two failing tests — `maxArticleAgeDays` respected on a Reddit
      feed, and a `buildPostContent()` failure yields no stored article.
- [ ] **Step 2:** Have the override start with `await super.filterArticles(...)`
      and apply only Reddit's *additional* rules (`min_comments`,
      `min_age_hours`) on top. Delete the hard-coded 60-day window.
- [ ] **Step 3:** Return `null`/skip instead of blanking the article on failure.
      Consider hoisting the `hasBodyContent` guard into `aggregate.ts` so it
      covers every aggregator rather than only the website family — that is the
      structural fix and prevents the third occurrence.
- [ ] **Step 4: Verify.**

---

### Task 6: Give the scheduler its own aggregation clock

**Completes the `TODO` left by plan 1, Task 3.**

**The bug.** `feeds.updatedAt` carries `$onUpdate`
(`src/lib/db/schema/feeds.ts:119-122`) and `scheduler.ts:109-118` reads it as
"last aggregation time". So any Drizzle write to a feed row postpones its next
aggregation by a full interval — `storeLogo` writing `logoImageHash`
(`src/lib/feeds/logo.ts:284-287`), editing a feed in `/feeds`, or
`refreshLogos`, which delays **every** feed at once. Feeds silently stop
updating on schedule after an unrelated edit.

`aggregate.ts:288`'s `set({ updatedAt: new Date() })` is also redundant with
`$onUpdate` — the set exists only to touch the row, which reads as a mistake and
hides the double duty.

**Files:**
- Modify: `src/lib/db/schema/feeds.ts` (add `lastAggregationStartedAt`)
- Create: a migration via `drizzle-kit generate`
- Modify: `src/lib/jobs/scheduler.ts`, `src/lib/jobs/handlers/aggregate.ts`
- Modify: `scheduler.test.ts`

- [ ] **Step 1:** Failing test — editing a feed's name does not postpone its
      next scheduled aggregation.
- [ ] **Step 2:** Add a nullable `lastAggregationStartedAt` column and generate
      the migration. Nullable so existing rows are "never aggregated" and get
      picked up on the first tick.
- [ ] **Step 3:** Stamp it at **claim** time, not completion — that is what makes
      plan 1's `running`-status dedupe robust rather than merely wider.
- [ ] **Step 4:** Point the scheduler at the new column and drop the redundant
      `updatedAt` set at `aggregate.ts:288` (keep a bare touch only if something
      genuinely needs the row's `updatedAt` moved; check before removing).
- [ ] **Step 5: Verify** — including that a fresh database and an existing one
      both schedule correctly.

---

### Task 7: Deleting a pending job must not strand its run

**The bug.** `src/lib/jobs/actions.ts:109-133` deletes `pending` rows outright.
Nothing decrements `runs.totalJobs`, and `bumpRunCounters`
(`src/lib/jobs/queue.ts:468-494`) only flips a run terminal when
`completedJobs + failedJobs >= totalJobs`. So the run never reaches a terminal
state.

`waitForRun()` (`src/lib/jobs/wait-for-run.ts:29-51`) is deliberately unbounded
and only settles on a terminal status event or a closed `EventSource`. So any
dashboard action tracking that run spins forever, and `<BulkActionBar>` — which
renders `null` at `count === 0` — is held open with it.

**Files:**
- Modify: `src/lib/jobs/actions.ts`
- Modify: `src/lib/jobs/actions.test.ts`

- [x] **Step 1:** Failing test — delete one pending job of a two-job run, assert
      the run reaches a terminal state once the other finishes.
- [x] **Step 2:** Decrement `runs.totalJobs` and re-evaluate terminality **inside
      the same transaction** as the delete.
- [x] **Step 3:** Note but do not fix here — `deleteJobs` calls `requestCancel()`
      from *inside* a `writeTransaction`, which is safe only because the
      `pending` branch (which publishes SSE events) is currently unreachable
      from that set. `writeTransaction` has no savepoints. Add a comment
      recording the hazard.
- [x] **Step 4: Verify.**

---

## Done criteria

- [ ] All seven tasks complete, each with a regression test verified to fail
      first.
- [ ] The image sweep has been run against a database with real orphans and the
      before/after counts recorded in the PR description.
- [ ] The reference-root list in Task 2 Step 2 was verified against the schema,
      not assumed.
- [ ] Four CI checks green.
- [ ] `CLAUDE.md` updated: the `contentHash` invariant (Task 4), the new
      `lastAggregationStartedAt` column and what it means versus `updatedAt`
      (Task 6), and a new bullet on media GC (Task 2).
