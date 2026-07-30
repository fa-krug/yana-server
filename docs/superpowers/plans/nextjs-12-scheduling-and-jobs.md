# Phase 12: Scheduling & Jobs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Structural, with the claim protocol specified concretely because it is the one part that is subtly wrong if written casually.

**Goal:** Scheduled aggregation, a durable in-process worker, retention cleanup, and the bulk actions phases 9 and 10 deferred — feed update (drip-feed through the daily allowance), feed restore (clear and refill), article reload, and the logo backlog.

**Architecture:** The `jobs` table from phase 2 is the broker, as django-q2's ORM broker was. A worker loop starts inside the Next.js process, claims jobs with a conditional `UPDATE` inside `BEGIN IMMEDIATE`, and runs them. A scheduler tick enqueues due aggregation runs. One process, no Redis, and it survives restart because the queue is on disk.

**Tech Stack:** better-sqlite3, phase 11c's aggregators, phase 1's `writeTransaction`.

## Global Constraints

- The claim must be **atomic**. A conditional `UPDATE ... WHERE status='pending'` returning a changed-row count is the mechanism; a `SELECT` followed by an `UPDATE` is a race that runs a job twice.
- The worker starts from `instrumentation.ts`, guarded to the **Node runtime** and to a **single instance**. Next.js can initialise a module more than once; two worker loops in one process double every job.
- A crashed job must not stay `running` forever. Startup resets orphaned `running` rows whose `startedAt` predates the process, and the loop enforces a per-job timeout.
- Retries use exponential backoff by pushing `runAt` forward. A job at `maxAttempts` becomes `failed` with its error retained — never silently dropped.
- Aggregation respects the **adaptive time-of-day quota** ported in 11a, not a flat limit. The direction record retains this deliberately: drip-feed pacing suits an always-on server.
- Bulk actions enqueue and return immediately. A long action must never run inside a request handler.
- `restore` is destructive — it deletes a feed's articles. It confirms with counts and is never a default.
- Retention deletes by **`createdAt`**, never `date`, and exempts starred articles. Keying off `date` would delete articles almost immediately whenever their publish date already sits near the cutoff.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/jobs/queue.ts` | `enqueue`, `claim`, `complete`, `fail`, `resetOrphaned` |
| `src/lib/jobs/worker.ts` | The loop |
| `src/lib/jobs/handlers/index.ts` | `kind` → handler registry |
| `src/lib/jobs/handlers/{aggregate,logo,reload,restore,retention}.ts` | Handlers |
| `src/lib/jobs/scheduler.ts` | Tick enqueuing due feeds |
| `src/app/(app)/jobs/page.tsx` | Read-only job list |
| `src/instrumentation.ts` | Starts worker and scheduler once |

---

### Task 1: The queue

**Interfaces:** `enqueue(kind, payload, options?): number`, `claim(): Job | null`, `complete(id)`, `fail(id, error)`, `progress(id, percent)`, `resetOrphaned(before: Date): number`

- [ ] **Write the failing test for the race first**

```ts
describe("claim", () => {
  it("never hands the same job to two callers", () => {
    const id = enqueue("noop", {});
    const first = claim();
    const second = claim();
    expect(first?.id).toBe(id);
    // The whole point of the conditional UPDATE.
    expect(second).toBeNull();
  });

  it("skips a job whose runAt is in the future", () => {
    enqueue("noop", {}, { runAt: new Date(Date.now() + 60_000) });
    expect(claim()).toBeNull();
  });

  it("claims the oldest eligible job first", () => {
    const older = enqueue("noop", { n: 1 }, { runAt: new Date(Date.now() - 2000) });
    enqueue("noop", { n: 2 }, { runAt: new Date(Date.now() - 1000) });
    expect(claim()?.id).toBe(older);
  });

  it("resets a job orphaned by a crash", () => {
    const id = enqueue("noop", {});
    claim();
    expect(resetOrphaned(new Date(Date.now() + 1000))).toBe(1);
    expect(claim()?.id).toBe(id);
  });
});

describe("fail", () => {
  it("backs off and retries below maxAttempts", () => { /* runAt moves forward, status pending */ });
  it("marks failed at maxAttempts and keeps the error", () => { /* status failed, error retained */ });
});
```

- [ ] Implement `claim` as a single conditional `UPDATE` inside `writeTransaction`, selecting the id first *within the same transaction* and updating only if still `pending`. Verify the changed-row count is 1 before returning the job; a count of 0 means another worker won and `claim` must return `null`, not retry blindly.

---

### Task 2: The worker and scheduler

- [ ] Loop: `claim` → dispatch by `kind` → `complete` or `fail`. Empty queue sleeps (2s) rather than spinning.
- [ ] Per-job timeout. A handler exceeding it is failed with a timeout error so the loop cannot wedge.
- [ ] Single-instance guard via a module-level flag plus a `globalThis` symbol — module-level alone is insufficient because Next.js may evaluate the module more than once.
- [ ] `resetOrphaned` at startup, before the loop begins.
- [ ] Scheduler tick (every 60s) enqueues `aggregate` for each enabled feed whose last run is older than its owner's `updateIntervalMinutes` (phase 3's setting), deduplicating against an already-pending job for that feed. Without the dedupe, a slow feed accumulates a queue of identical jobs.
- [ ] Also enqueue `retention` daily, mirroring the django-q2 schedule `setup_periodic_tasks` seeded.

---

### Task 3: Handlers

| Kind | Behaviour |
|---|---|
| `aggregate` | Run the feed's aggregator with the adaptive quota; upsert articles by `(feedId, identifier)`; write blocks via 11a's storage |
| `feed.logo` | Drain phase 9's backlog: `discoverLogo` + `storeLogo` |
| `feed.update` | Manual aggregation honouring the remaining daily allowance — the drip-feed bulk action |
| `feed.restore` | Delete the feed's articles, then aggregate with the **full** daily allowance |
| `article.reload` | Re-run extraction from `rawContent`, rebuild blocks |
| `retention` | Delete articles older than `articleRetentionDays` by `createdAt`, excluding starred |

- [ ] `aggregate` must be **idempotent**: re-running must not duplicate articles. `(feedId, identifier)` is the key, and phase 2 indexed it for this.
- [ ] `article.reload` rebuilds blocks from `rawContent` — which is precisely why phase 2 kept that column when it dropped `content`. Verify it works on an article whose blocks were deleted.
- [ ] Handlers report `progress` on multi-item work so bulk actions surface movement in the UI.
- [ ] Test retention against the trap directly: an article imported today with a two-year-old `date` must **survive** a 60-day retention run.

---

### Task 4: Bulk actions and the jobs page

- [ ] Add to phase 9's feed bulk actions: **update** (`feed.update`), **restore** (`feed.restore`, confirmed with article counts), **update logo** (already present in phase 9 — now it has a consumer).
- [ ] Add to phase 10's article bulk actions: **reload** (`article.reload`).
- [ ] Each enqueues and toasts the count. Nothing waits.
- [ ] A read-only `/jobs` page listing recent jobs with status, attempts, progress and error, using phase 5's `DataTable`. Filter by status and kind. This is the operator's only window into background work — without it a failed job is invisible.
- [ ] Verify: enqueue 20 jobs, restart the process mid-run, confirm none are lost and none run twice.

---

## Self-Review

**Spec coverage.** Against bullet 12: scheduled aggregation (Task 2), feed bulk update with drip-feed (Task 3, 4), feed bulk restore clearing articles and refilling the allowance (Task 3, 4), article bulk reload (Task 3, 4), per-aggregator npm commands — **already delivered in phase 11c Task 1**, since the CLI was needed to debug the port and building it twice made no sense. Retention (Task 3) and the phase 9 logo backlog (Task 3) are carried in from earlier dependencies.

**Placeholder scan.** Task 1's claim protocol is specified concretely with its race test, because that is the part most likely to be written casually and be subtly broken. Tasks 2–4 are structural; every non-obvious constraint is stated — double-initialisation, orphan reset, scheduler dedupe, idempotent aggregation, and the retention trap.

**Type consistency.** `Job` is phase 2's inferred type. `enqueue`'s `kind` values match the handler registry keys exactly, and the table in Task 3 is the single list of them. `writeTransaction` is phase 1's.

**One dependency satisfied here rather than earlier.** Phase 9 wrote `feed.logo` rows with no consumer, deliberately, so the queue contract landed with the producer. Task 3 drains that backlog, which means the first run after this phase may process a large number of queued logo jobs — expected, not a malfunction.
