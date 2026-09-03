# Aggregation / Reload / AI Review — Findings and Plan Index

**Date:** 2026-09-03
**Scope:** the aggregation pipeline, the reload path, and AI application —
`src/lib/aggregators/**`, `src/lib/ai/**`, `src/lib/jobs/**`,
`src/lib/articles/**`.
**Baseline at review time:** 220 test files, 2443 tests passing, typecheck
clean, 0 lint errors. **Every bug below is invisible to that suite.**

This record exists because the remediation runs as **one session on one branch**
with the model's context cleared repeatedly along the way, and **nothing is
merged until the last change**. Read it before starting any of the four plans,
and re-read it after any context clear — it is the only place the whole picture
is written down.

## The through-line

One root cause dominates, and it explains why these bugs were hard to find and
fix: **the same rule is implemented in two or more places and one copy drifted**
— frequently under a comment asserting that the drift cannot happen.

- The model `/ai` displays and the model actually billed are resolved by two
  different code paths.
- The daily-limit pacing is computed twice; the second computation discards the
  first's input.
- Comment sections are built in five places; two forgot the marker the content
  hash keys on.
- YouTube video IDs are extracted six times; the copy on the live path is the
  weakest of the six.
- `feed.userId` is converted in two places, one with `String()` and one with
  `parseInt()`.

Fixing the instances is plans 1-2. Removing the *class* is plan 3. Plan 4
deletes what nothing reaches and closes the hardening gaps found alongside.

## Confirmed high-severity findings

| # | Finding | Where |
|---|---|---|
| 1 | `/ai` shows a substituted model; `run.ts` sends the raw stored one, so pre-`0003` rows 404 forever | `ai/run.ts:344,366,403`; `ai/queries.ts:123` |
| 2 | Reddit/YouTube comments are inside the content hash → row rewrite + one paid AI request per article **per cycle** | `reddit/content.ts:262`; `youtube/aggregator.ts:305`; `content-hash.ts:34` |
| 3 | Scheduler enqueues duplicate aggregations (dedupe misses `running`, and misses kind `feed.update`) | `jobs/scheduler.ts:82-86` |
| 4 | Daily-limit pacing defeated for 14 of 16 aggregators | `rss.ts:70`; `podcast.ts:118` |
| 5 | `parseInt` on a string user id → subreddit icon works for ~16% of accounts, by id luck | `base.ts:249-259` |
| 6 | AI-enabled feed with no provider stores nothing forever, job reports green; `restore` makes it a silent wipe | `aggregate.ts:178-207`; `restore.ts:23-44` |
| 7 | Article images are never deleted — no `unlink`, no `delete(articleImages)` anywhere | four delete sites; `images/store.ts` |

## Owner decisions taken during the review

- **Orphaned images:** mark-and-sweep in the nightly retention job. Per-article
  delete is unsafe — images are content-addressed and shared across articles and
  users with no refcount. `findImageRefs()` already exists, is tested, and has
  zero callers; reuse it.
- **AI failure for a permanent reason (no provider configured):** refuse to
  enqueue at all. Block aggregation for such a feed and surface it as a feed
  configuration error in the UI, rather than running jobs that fail per article.
  The per-article skip-and-retry stays correct for genuinely transient failures.
- **Sequencing:** four plans, in order, executed in a single session on a single
  branch with context clears between them. No merge until the last change of
  plan 4.

## Plans, in execution order

1. `plans/2026-09-03-pipeline-review-1-correctness.md` — the five confirmed
   correctness bugs. Surgical, no schema changes.
2. `plans/2026-09-03-pipeline-review-2-data-integrity.md` — permanent data loss,
   media GC, tombstones, and the scheduler's own aggregation clock. One
   migration.
3. `plans/2026-09-03-pipeline-review-3-unify-parallel-paths.md` — collapse the
   duplicated rules so the class of bug cannot recur. Large diff;
   behaviour-preserving except where plans 1-2 defined the correct behaviour.
4. `plans/2026-09-03-pipeline-review-4-cleanup-and-hardening.md` — ~1,400 lines
   of proven-dead code, mechanical dedup, and seven deliberate hardening
   changes.

**Do not reorder.** Plan 3 deletes second copies of rules that plans 1-2 fix in
the first copy; running it earlier re-introduces the bugs. Plan 4 Task 2 deletes
an API plan 3 consolidates against.

## Execution model

One branch, one session, context cleared repeatedly, **no merge until the last
change of plan 4**. Each plan carries its own "Execution model" section with the
resume procedure; the essentials:

- **Tick the checkboxes** in each plan file as work completes, in the same
  commit. Together with `git log` they are the only durable progress record
  across a context clear.
- **Commit per task**, prefixed `…(review-N): Task M — …`. With no intermediate
  merge there is no CI run to catch a bad commit, so keep them bisectable.
- **Run all four checks at the end of every task**, not every plan. A break
  introduced in plan 1 that first surfaces in plan 4 is expensive to locate.
- **Before the final merge**, re-run the full suite plus a real aggregation and
  a real reload against at least one website feed, one Reddit feed and one
  YouTube feed. Much of this work is not reachable by unit tests — the seven
  high-severity findings were all invisible to a green 2443-test suite, which is
  the whole reason this review happened.

## Duplication inventory

| Area | Removable lines | Note |
|---|---|---|
| Site aggregators | ~770 | 21-line sanitizer ×6 (security-relevant), 2 comment modules, 2 multipage modules, 2 dead JSON branches |
| Embed registry + `twitter.ts` | ~450 | `convertEmbed()` has zero callers; the live path is a third implementation in `blocks/parser.ts` |
| Aggregator configuration API | ~500 | `saveOptions()` has no callers, yet 11 sites override `getConfigurationFields()` to feed it — and `registry.test.ts:215` *enforces* the duplication |
| AI layer | ~200 | 29 dead snake_case fields + 38 `??` chains; a 19-line 429 block duplicated *and* unreachable; 7 near-identical `callXxx()` |
| Blocks / clean | ~150 | 3 clone embed builders, 3 disagreeing tag drop-lists, `cleanHtml+sanitize+removeSanitized` ×6 |

## Hypotheses checked and refuted

Recorded so they are not re-investigated:

- `writeBlocks()` **is** transactional, with a synchronous callback, and the
  cascade is complete. Its `async` is cosmetic.
- `plainTextOf` is defined **once** (`blocks/plain-text.ts:16`) and re-exported
  from `parser.ts:8`. Not two implementations.
- `resolveFeedCredentials()` **is** applied at all three `createAggregator()`
  call sites.
- There are **no** dead feed options: every key declared in `specs.ts` has a
  real reader. The one drift is the reverse direction — `include_comments` is
  read by Reddit's reload path and declared nowhere, so it is unreachable from
  the UI and permanently `true`.
- A cancelled aggregate job makes **at most one** further paid AI request; the
  cancel check sits above the AI call.
- No duplicated SQL between `jobs/queue.ts` and `jobs/queries.ts` — the split is
  clean.
- The blocks round trip is sound: 20,000 fuzzed trees (nested lists, quotes in
  lists, summaries, adversarial run text) round-tripped with zero structural and
  zero text-stability failures, **provided no block canonicalizes to empty**.
  The failures are narrow and are covered by plan 3 Task 6.

## Method

Six parallel subsystem audits (AI layer, aggregation core, site aggregators,
blocks pipeline, jobs subsystem, media pipeline), each instructed to verify or
refute specific hypotheses and to report only findings it had confirmed by
reading the code. Round-trip claims were proven by executing generated cases,
not by reasoning. The seven high-severity findings above were then independently
re-verified against the source before being written down.
