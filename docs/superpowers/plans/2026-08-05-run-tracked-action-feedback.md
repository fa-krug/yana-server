# Run-Tracked Action Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give "Run aggregation" (feeds) and "Reload" (articles) a real spinner that stays active until their enqueued background jobs actually finish, followed by one toast reporting the real outcome — for both the existing bulk actions and two new single-item buttons on the feed/article detail pages.

**Architecture:** Group each action's enqueued jobs into one `runs` row (reusing `enqueueRun()`, already used by the external `/api/v1/aggregate` endpoint), expose a session-authenticated `getRunStatus()` server action so the dashboard can poll that row, and add a small client-side poll-to-terminal helper plus a shared spinner + outcome-toast helper that four call sites (2 existing bulk actions, 2 new detail-page buttons) use identically.

**Tech Stack:** Next.js 16 / React 19 / TypeScript, Drizzle + better-sqlite3, next-intl, Vitest (node + jsdom projects), sonner (toast), lucide-react (icons).

## Global Constraints

- Line length 100, double quotes, semicolons, trailing commas (Prettier owns formatting).
- No server action is ever awaited bare from a client component — every call goes through `attemptCall()` or a feature's `attempt()` binding (`src/lib/attempt.ts`).
- Every user-facing string comes from `messages/en.json` **and** `messages/de.json` with identical key sets — add both together, never one alone.
- `.test.ts` files run in the node Vitest project (real SQLite, no mocked driver); `.test.tsx` files run in the jsdom project. The extension alone picks the project — content does not matter.
- New library tests under `src/lib/**` use a real, migrated temp-file database via `applyMigrationsAt()` (`src/lib/db/test-support.ts`), never a hand-rolled loader or a mocked driver.
- Every write goes through `writeTransaction()` from `@/lib/db/client` (or a helper that itself does, like `enqueueRun()`), never a raw `connection.exec`/`prepare` outside it.
- Ownership mismatches answer as if the row does not exist (`null`/404), never a distinguishable 403 — this is the enumeration-safety convention `requireAdmin()` and the avatar route already use.
- Run `npm run lint && npm run format:check && npm run typecheck && npm test` before considering any task's code changes complete.

---

### Task 1: `updateFeedsBulk()` groups its jobs into a run

**Files:**
- Modify: `src/lib/feeds/actions.ts:439-464` (the `updateFeedsBulk` function), and its import block at the top of the file.
- Test: `src/lib/feeds/actions.test.ts` (append a new `describe("updateFeedsBulk", ...)` block at the end of the file).

**Interfaces:**
- Consumes: `enqueueRun(userId: string, kind: string, payloads: Record<string, unknown>[]): number` from `@/lib/jobs/queue` (already exists, unchanged).
- Produces: `updateFeedsBulk(ids: number[]): Promise<{ ok: boolean; enqueued: number; runId: number }>` — the `runId` is new; `ok`/`enqueued` keep their existing meaning. Task 9 (feeds-table.tsx) and Task 11 (feed-form.tsx) call this and read `result.runId`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/feeds/actions.test.ts` (this file's convention is one fully
self-contained `describe` block per function group — copy the same harness
`describe("deleteFeeds", ...)` above it already uses):

```ts
describe("updateFeedsBulk", () => {
  let dbPath: string;
  let actions: typeof import("./actions");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let actingUserId: string | undefined;

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  async function seedUser(input: { email: string }): Promise<string> {
    const user = await createUserWithPassword({
      email: input.email,
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "user",
    });
    raw(client.getDb()).exec(`INSERT INTO user_settings (user_id) VALUES ('${user.id}')`);
    return user.id;
  }

  async function currentUserId(): Promise<string> {
    if (actingUserId) return actingUserId;
    actingUserId = await seedUser({ email: "user@example.com" });
    const cookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
    requestAs(cookie);
    cookieJar.clear();
    return actingUserId;
  }

  async function switchToOtherUser(): Promise<void> {
    await seedUser({ email: "other@example.com" });
    const cookie = await signInCookie(auth, { email: "other@example.com", password: PASSWORD });
    requestAs(cookie);
    actingUserId = undefined;
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();
    actingUserId = undefined;

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-feeds-update-bulk-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    actions = await import("./actions");
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("groups the enqueued jobs into one run owned by the caller", async () => {
    const userId = await currentUserId();
    const a = await actions.createFeed({ name: "A", aggregator: "heise", identifier: "" });
    const b = await actions.createFeed({ name: "B", aggregator: "heise", identifier: "" });

    const result = await actions.updateFeedsBulk([a.id!, b.id!]);
    expect(result.ok).toBe(true);
    expect(result.enqueued).toBe(2);

    const runRow = client
      .getDb()
      .select()
      .from(schema.runs)
      .all()
      .find((r) => r.id === result.runId)!;
    expect(runRow.userId).toBe(userId);
    expect(runRow.totalJobs).toBe(2);
    expect(runRow.status).toBe("running");

    const jobRows = client
      .getDb()
      .select()
      .from(schema.jobs)
      .all()
      .filter((j) => j.runId === result.runId);
    expect(jobRows).toHaveLength(2);
    expect(jobRows.every((j) => j.kind === "feed.update")).toBe(true);
  });

  it("filters out ids that don't belong to the caller, and still returns a valid runId", async () => {
    await currentUserId();
    const mine = await actions.createFeed({ name: "Mine", aggregator: "heise", identifier: "" });

    await switchToOtherUser();
    const theirs = await actions.createFeed({
      name: "Theirs",
      aggregator: "heise",
      identifier: "",
    });

    await currentUserId();
    const result = await actions.updateFeedsBulk([mine.id!, theirs.id!]);
    expect(result.enqueued).toBe(1);
    expect(typeof result.runId).toBe("number");
  });

  it("returns an already-completed, zero-job run for an empty id list", async () => {
    await currentUserId();
    const result = await actions.updateFeedsBulk([]);
    expect(result).toEqual({ ok: true, enqueued: 0, runId: expect.any(Number) });

    const runRow = client
      .getDb()
      .select()
      .from(schema.runs)
      .all()
      .find((r) => r.id === result.runId)!;
    expect(runRow.status).toBe("completed");
    expect(runRow.totalJobs).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/feeds/actions.test.ts -t updateFeedsBulk`
Expected: FAIL — `result.runId` is `undefined` (current implementation
returns `{ ok, enqueued }` only).

- [ ] **Step 3: Implement**

In `src/lib/feeds/actions.ts`, add `enqueueRun` to the imports:

```ts
import { currentUserId } from "@/lib/auth/session";
import { getDb, writeTransaction } from "@/lib/db/client";
import { feeds, feedTags, tags, jobs, articles, articleTombstones } from "@/lib/db/schema";
import { enqueueRun } from "@/lib/jobs/queue";
import { getSettings } from "@/lib/settings/queries";
```

Replace the whole `updateFeedsBulk` function (lines 439-464) with:

```ts
export async function updateFeedsBulk(
  ids: number[],
): Promise<{ ok: boolean; enqueued: number; runId: number }> {
  const userId = await currentUserId();

  const validFeeds = getDb()
    .select({ id: feeds.id })
    .from(feeds)
    .where(and(inArray(feeds.id, ids), eq(feeds.userId, userId)))
    .all();

  const runId = enqueueRun(
    userId,
    "feed.update",
    validFeeds.map((f) => ({ feedId: f.id })),
  );

  return { ok: true, enqueued: validFeeds.length, runId };
}
```

Note the early `if (ids.length === 0) return { ok: true, enqueued: 0 }` guard
is dropped: an empty `ids` array now falls straight through to
`enqueueRun(userId, "feed.update", [])`, which is explicitly documented as
legal (`src/lib/jobs/queue.ts`) and returns an already-`"completed"`,
zero-job run — matching the third test above.

`jobs` stays imported (still used by `refreshLogos()` and
`restoreFeedsBulk()` lower in the same file, which are unchanged).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/feeds/actions.test.ts`
Expected: PASS (including every pre-existing test in this file — this
confirms `refreshLogos`/`restoreFeedsBulk`/`deleteFeeds` etc. are unaffected).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/lib/feeds/actions.ts src/lib/feeds/actions.test.ts
git commit -m "feat(feeds): group updateFeedsBulk's jobs into a trackable run"
```

---

### Task 2: `reloadArticles()` groups its jobs into a run

**Files:**
- Modify: `src/lib/articles/actions.ts:148-176` (the `reloadArticles`
  function), and its import block.
- Test: `src/lib/articles/actions.test.ts` (add a new nested
  `describe("reloadArticles", ...)` inside the existing outer
  `describe("articles actions", ...)`, using the harness already defined
  there — `currentUserId`, `switchToOtherUser`, `seedFeed`, `seedArticle`).

**Interfaces:**
- Consumes: `enqueueRun()` from `@/lib/jobs/queue` (unchanged).
- Produces: `reloadArticles(ids: number[]): Promise<{ ok: boolean; enqueued: number; runId: number }>`. Task 10 (articles-table.tsx) and Task 12 (article-form.tsx) call this and read `result.runId`.

- [ ] **Step 1: Write the failing test**

Add inside `describe("articles actions", ...)` in
`src/lib/articles/actions.test.ts`, as a sibling of `describe("updateArticle", ...)` /
`describe("deleteArticles", ...)`:

```ts
describe("reloadArticles", () => {
  it("groups the enqueued jobs into one run owned by the caller", async () => {
    const userId = await currentUserId();
    const feed = seedFeed("Feed");
    const a = seedArticle(feed);
    const b = seedArticle(feed);

    const result = await actions.reloadArticles([a.id, b.id]);
    expect(result.ok).toBe(true);
    expect(result.enqueued).toBe(2);

    const runRow = client
      .getDb()
      .select()
      .from(schema.runs)
      .all()
      .find((r) => r.id === result.runId)!;
    expect(runRow.userId).toBe(userId);
    expect(runRow.totalJobs).toBe(2);
    expect(runRow.status).toBe("running");

    const jobRows = client
      .getDb()
      .select()
      .from(schema.jobs)
      .all()
      .filter((j) => j.runId === result.runId);
    expect(jobRows).toHaveLength(2);
    expect(jobRows.every((j) => j.kind === "article.reload")).toBe(true);
    expect(jobRows.map((j) => j.payload)).toEqual([{ articleId: a.id }, { articleId: b.id }]);
  });

  it("filters out an article whose feed belongs to another user", async () => {
    const myId = await currentUserId();
    const myFeed = seedFeed("Mine", myId);
    const myArticle = seedArticle(myFeed);

    const otherId = await switchToOtherUser();
    const theirFeed = seedFeed("Theirs", otherId);
    const theirArticle = seedArticle(theirFeed);

    // Explicitly restore the original session rather than calling
    // currentUserId() again: switchToOtherUser() leaves actingUserId
    // pointing at the other user, so currentUserId()'s
    // `if (actingUserId) return actingUserId;` short-circuit would just
    // return the other user's id again instead of re-establishing "mine".
    const myCookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
    requestAs(myCookie);

    const result = await actions.reloadArticles([myArticle.id, theirArticle.id]);
    expect(result.enqueued).toBe(1);

    const jobRows = client
      .getDb()
      .select()
      .from(schema.jobs)
      .all()
      .filter((j) => j.runId === result.runId);
    expect(jobRows).toEqual([expect.objectContaining({ payload: { articleId: myArticle.id } })]);
  });

  it("returns an already-completed, zero-job run for an empty id list", async () => {
    await currentUserId();
    const result = await actions.reloadArticles([]);
    expect(result).toEqual({ ok: true, enqueued: 0, runId: expect.any(Number) });

    const runRow = client
      .getDb()
      .select()
      .from(schema.runs)
      .all()
      .find((r) => r.id === result.runId)!;
    expect(runRow.status).toBe("completed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/articles/actions.test.ts -t reloadArticles`
Expected: FAIL — `result.runId` is `undefined`.

- [ ] **Step 3: Implement**

In `src/lib/articles/actions.ts`, add the import:

```ts
import { currentUserId } from "@/lib/auth/session";
import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, feeds, jobs } from "@/lib/db/schema";
import { enqueueRun } from "@/lib/jobs/queue";
```

Replace the whole `reloadArticles` function (lines 148-176) with:

```ts
export async function reloadArticles(
  ids: number[],
): Promise<{ ok: boolean; enqueued: number; runId: number }> {
  const userId = await currentUserId();
  const db = getDb();

  const userFeedIds = db.select({ id: feeds.id }).from(feeds).where(eq(feeds.userId, userId));

  const validArticles = db
    .select({ id: articles.id })
    .from(articles)
    .where(and(inArray(articles.id, ids), inArray(articles.feedId, userFeedIds)))
    .all();

  const runId = enqueueRun(
    userId,
    "article.reload",
    validArticles.map((a) => ({ articleId: a.id })),
  );

  return { ok: true, enqueued: validArticles.length, runId };
}
```

Same note as Task 1: the empty-`ids` early return is dropped in favor of
letting `enqueueRun()` handle it, which is what makes the third test above
pass. `jobs` stays imported only if still referenced elsewhere in the file
(check with `grep -n "jobs\." src/lib/articles/actions.ts` after this edit —
if this was the only use, remove `jobs` from the import list so
`npm run lint` doesn't flag an unused import).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/articles/actions.test.ts`
Expected: PASS (every test in the file, not just the new ones).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/articles/actions.ts src/lib/articles/actions.test.ts
git commit -m "feat(articles): group reloadArticles's jobs into a trackable run"
```

---

### Task 3: `getRunStatus()` — the dashboard's session-authenticated poll target

**Files:**
- Create: `src/lib/jobs/actions.ts`
- Test: Create `src/lib/jobs/actions.test.ts`

**Interfaces:**
- Consumes: `currentUserId()` from `@/lib/auth/session`; `getDb()` from
  `@/lib/db/client`; `runs` from `@/lib/db/schema`; `enqueueRun()` from
  `./queue` (test-only, to create a fixture run).
- Produces: `export type RunStatus = { status: string; totalJobs: number; completedJobs: number; failedJobs: number }` and `export async function getRunStatus(runId: number): Promise<RunStatus | null>`. Task 4's `waitForRun()` calls this directly.

- [ ] **Step 1: Write the failing test**

Create `src/lib/jobs/actions.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { requestHeaders, cookieJar } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  cookieJar: new Map<string, string>(),
}));

vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders, cookieJar),
);

const PASSWORD = "correct horse battery staple";

describe("getRunStatus", () => {
  let dbPath: string;
  let jobsActions: typeof import("./actions");
  let queue: typeof import("./queue");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  async function seedUser(email: string): Promise<string> {
    const user = await createUserWithPassword({
      email,
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "user",
    });
    return user.id;
  }

  async function signInAs(email: string): Promise<void> {
    const cookie = await signInCookie(auth, { email, password: PASSWORD });
    requestAs(cookie);
    cookieJar.clear();
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-jobs-actions-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    jobsActions = await import("./actions");
    queue = await import("./queue");
    client = await import("@/lib/db/client");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("returns the run's status for its owner", async () => {
    const userId = await seedUser("owner@example.com");
    await signInAs("owner@example.com");
    const runId = queue.enqueueRun(userId, "feed.update", [{ feedId: 1 }, { feedId: 2 }]);

    const status = await jobsActions.getRunStatus(runId);
    expect(status).toEqual({
      status: "running",
      totalJobs: 2,
      completedJobs: 0,
      failedJobs: 0,
    });
  });

  it("returns null for a run owned by another user", async () => {
    const ownerId = await seedUser("owner@example.com");
    const runId = queue.enqueueRun(ownerId, "feed.update", [{ feedId: 1 }]);

    await seedUser("other@example.com");
    await signInAs("other@example.com");

    expect(await jobsActions.getRunStatus(runId)).toBeNull();
  });

  it("returns null for a nonexistent run id", async () => {
    await seedUser("owner@example.com");
    await signInAs("owner@example.com");

    expect(await jobsActions.getRunStatus(999_999)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/jobs/actions.test.ts`
Expected: FAIL — `./actions` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/lib/jobs/actions.ts`:

```ts
"use server";

import { eq } from "drizzle-orm";

import { currentUserId } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { runs } from "@/lib/db/schema";

export type RunStatus = {
  status: string;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
};

/**
 * The web dashboard's poll target for a run created by `updateFeedsBulk()`
 * or `reloadArticles()`. Mirrors `/api/v1/runs/[id]`'s ownership check, but
 * against the session instead of a Bearer token: a mismatch or a
 * nonexistent id both answer `null`, never a distinguishable error, so this
 * cannot be used to enumerate other users' run ids.
 */
export async function getRunStatus(runId: number): Promise<RunStatus | null> {
  const userId = await currentUserId();

  const run = getDb()
    .select({
      status: runs.status,
      totalJobs: runs.totalJobs,
      completedJobs: runs.completedJobs,
      failedJobs: runs.failedJobs,
      userId: runs.userId,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .get();

  if (!run || run.userId !== userId) return null;

  return {
    status: run.status,
    totalJobs: run.totalJobs,
    completedJobs: run.completedJobs,
    failedJobs: run.failedJobs,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/jobs/actions.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/jobs/actions.ts src/lib/jobs/actions.test.ts
git commit -m "feat(jobs): add session-authenticated getRunStatus for the dashboard"
```

---

### Task 4: `waitForRun()` — bounded poll-to-terminal helper

**Files:**
- Create: `src/lib/jobs/wait-for-run.ts`

**Interfaces:**
- Consumes: `getRunStatus()` and `RunStatus` from `./actions` (Task 3);
  `attemptCall` from `@/lib/attempt`.
- Produces: `export type RunOutcome = { ok: true; status: RunStatus } | { ok: false; reason: "not-found" | "timeout" | "request-failed" }` and `export async function waitForRun(runId: number): Promise<RunOutcome>`. Tasks 9, 10, 11, 12 call this from client components.

No test for this task — per the design spec, driving the real 2-second
polling loop end-to-end is out of scope; `reportRunOutcome()` (Task 5) is
tested directly against fabricated `RunOutcome` values instead, which is
where the branching logic that matters actually lives.

- [ ] **Step 1: Implement**

Create `src/lib/jobs/wait-for-run.ts`:

```ts
import { attemptCall } from "@/lib/attempt";

import { getRunStatus, type RunStatus } from "./actions";

export type RunOutcome =
  | { ok: true; status: RunStatus }
  | { ok: false; reason: "not-found" | "timeout" | "request-failed" };

const POLL_INTERVAL_MS = 2000;
// 300 * 2s = 10 minutes. A worker that claims one job at a time can take a
// while on a large bulk selection; this is generous enough for ordinary use
// and bounded enough that a genuinely stuck run does not poll forever.
const MAX_POLLS = 300;

/**
 * Poll a run's status until it reaches a terminal state ("completed" or
 * "failed"), or give up after ~10 minutes. Every poll goes through
 * `attemptCall` -- even a read -- per the "never a bare await from a client
 * component" rule (`@/lib/attempt`): on the happy path (the call keeps
 * returning normally) that costs nothing extra, since `attemptCall` only
 * probes the session on an actual rejection.
 */
export async function waitForRun(runId: number): Promise<RunOutcome> {
  for (let i = 0; i < MAX_POLLS; i++) {
    const attempted = await attemptCall(() => getRunStatus(runId), {
      label: "Polling a run's status rejected instead of resolving",
    });

    if (attempted.status !== "returned") return { ok: false, reason: "request-failed" };
    if (!attempted.result) return { ok: false, reason: "not-found" };
    if (attempted.result.status === "completed" || attempted.result.status === "failed") {
      return { ok: true, status: attempted.result };
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { ok: false, reason: "timeout" };
}
```

- [ ] **Step 2: Typecheck and commit**

Run: `npm run typecheck` (there is no runtime test to run for this file).

```bash
git add src/lib/jobs/wait-for-run.ts
git commit -m "feat(jobs): add waitForRun bounded poll-to-terminal helper"
```

---

### Task 5: `reportRunOutcome()` — shared completion-toast logic

**Files:**
- Create: `src/lib/jobs/report-run-outcome.ts`
- Test: Create `src/lib/jobs/report-run-outcome.test.ts`

**Interfaces:**
- Consumes: `RunOutcome` from `./wait-for-run` (Task 4); `toast` from
  `"sonner"`.
- Produces: `export function reportRunOutcome(outcome: RunOutcome, copy: { completed: (n: number) => string; partial: (ok: number, failed: number) => string; fallback: string }): void`. Tasks 9, 10, 11, 12 call this after `waitForRun()` resolves.

- [ ] **Step 1: Write the failing test**

Create `src/lib/jobs/report-run-outcome.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastSuccess, toastWarning, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, warning: toastWarning, error: toastError },
}));

import { reportRunOutcome } from "./report-run-outcome";
import type { RunOutcome } from "./wait-for-run";

const copy = {
  completed: (n: number) => `${n} done`,
  partial: (ok: number, failed: number) => `${ok} done, ${failed} failed`,
  fallback: "Something went wrong",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reportRunOutcome", () => {
  it("toasts success when every job in the run completed", () => {
    const outcome: RunOutcome = {
      ok: true,
      status: { status: "completed", totalJobs: 3, completedJobs: 3, failedJobs: 0 },
    };
    reportRunOutcome(outcome, copy);
    expect(toastSuccess).toHaveBeenCalledWith("3 done");
    expect(toastWarning).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("toasts a warning when some jobs in the run failed", () => {
    const outcome: RunOutcome = {
      ok: true,
      status: { status: "failed", totalJobs: 3, completedJobs: 2, failedJobs: 1 },
    };
    reportRunOutcome(outcome, copy);
    expect(toastWarning).toHaveBeenCalledWith("2 done, 1 failed");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("toasts the fallback error on a request failure or a run that vanished", () => {
    reportRunOutcome({ ok: false, reason: "request-failed" }, copy);
    reportRunOutcome({ ok: false, reason: "not-found" }, copy);
    expect(toastError).toHaveBeenCalledTimes(2);
    expect(toastError).toHaveBeenCalledWith("Something went wrong");
  });

  it("reports nothing on a timeout -- the run is still legitimately in progress", () => {
    reportRunOutcome({ ok: false, reason: "timeout" }, copy);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastWarning).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/jobs/report-run-outcome.test.ts`
Expected: FAIL — `./report-run-outcome` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/lib/jobs/report-run-outcome.ts`:

```ts
import { toast } from "sonner";

import type { RunOutcome } from "./wait-for-run";

export type RunOutcomeCopy = {
  completed: (n: number) => string;
  partial: (completed: number, failed: number) => string;
  fallback: string;
};

/**
 * The one toast a run-tracked action reports, once, at the end. `"timeout"`
 * is deliberately not an error: the run is still going server-side, just
 * slower than this tab was willing to wait -- nothing has failed.
 */
export function reportRunOutcome(outcome: RunOutcome, copy: RunOutcomeCopy): void {
  if (!outcome.ok) {
    if (outcome.reason === "timeout") return;
    toast.error(copy.fallback);
    return;
  }

  const { completedJobs, failedJobs } = outcome.status;
  if (failedJobs === 0) toast.success(copy.completed(completedJobs));
  else toast.warning(copy.partial(completedJobs, failedJobs));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/jobs/report-run-outcome.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/jobs/report-run-outcome.ts src/lib/jobs/report-run-outcome.test.ts
git commit -m "feat(jobs): add reportRunOutcome shared completion-toast helper"
```

---

### Task 6: `<Spinner>` — one shared visual

**Files:**
- Create: `src/components/ui/spinner.tsx`

**Interfaces:**
- Consumes: `Loader2Icon` from `"lucide-react"`; `cn()` from `@/lib/utils`.
- Produces: `export function Spinner({ className }: { className?: string }): JSX.Element`. Task 7 (BulkActionBar) and Tasks 11/12 (detail-page buttons) render this.

No dedicated test: this is a three-line presentational wrapper with no
branching logic, in the same category as this codebase's other untested UI
atoms (e.g. `Badge`). Its rendering is exercised indirectly by Task 7's
`bulk-action-bar.test.tsx` update.

- [ ] **Step 1: Implement**

Create `src/components/ui/spinner.tsx`:

```tsx
import { Loader2Icon } from "lucide-react";

import { cn } from "@/lib/utils";

/** Matches the icon Sonner's own loading toasts use (`src/components/ui/sonner.tsx`). */
export function Spinner({ className }: { className?: string }) {
  return <Loader2Icon className={cn("size-4 animate-spin", className)} />;
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck
git add src/components/ui/spinner.tsx
git commit -m "feat(ui): add shared Spinner component"
```

---

### Task 7: `BulkActionBar` shows a spinner on the running action only

**Files:**
- Modify: `src/components/crud/bulk-action-bar.tsx`
- Test: Modify `src/components/crud/bulk-action-bar.test.tsx`

**Interfaces:**
- Consumes: `Spinner` from `@/components/ui/spinner` (Task 6).
- Produces: No change to `BulkActionBar`'s public props (`count`, `actions`, `onClear`) or the `BulkAction` type — this is an internal rendering change only. Tasks 9/10 do not need to change how they build their `actions` arrays.

- [ ] **Step 1: Write the failing test**

Add to `src/components/crud/bulk-action-bar.test.tsx`, after the existing
`run` mock setup. This needs a second, slow-resolving action to prove the
spinner appears on the right button and not its sibling:

```ts
it("shows a spinner only on the button whose action is still running", async () => {
  let resolveRun: (value: boolean) => void = () => {};
  const slowRun = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        resolveRun = resolve;
      }),
  );
  const slowAction: BulkAction = {
    key: "slow",
    label: "Slow action",
    destructive: false,
    run: slowRun,
  };
  const fastAction: BulkAction = {
    key: "fast",
    label: "Fast action",
    destructive: false,
    run: vi.fn().mockResolvedValue(true),
  };

  renderWithProviders(
    <BulkActionBar count={2} actions={[slowAction, fastAction]} onClear={vi.fn()} />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Slow action" }));

  // The clicked button gets a spinner; its sibling stays plain-disabled.
  expect(
    screen.getByRole("button", { name: "Slow action" }).querySelector("svg.animate-spin"),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Fast action" }).querySelector("svg.animate-spin"),
  ).toBeNull();
  expect(screen.getByRole("button", { name: "Fast action" })).toBeDisabled();

  resolveRun(true);
  await vi.waitFor(() => {
    expect(
      screen.getByRole("button", { name: "Slow action" }).querySelector("svg.animate-spin"),
    ).toBeNull();
  });
});
```

This test needs `vi` imported for `vi.waitFor` (already imported at the top
of the file) — no new import required.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/crud/bulk-action-bar.test.tsx`
Expected: FAIL — no `svg.animate-spin` is rendered today.

- [ ] **Step 3: Implement**

In `src/components/crud/bulk-action-bar.tsx`, add the import:

```ts
import { Spinner } from "@/components/ui/spinner";
```

Keep the existing `pending` boolean from `useTransition()` exactly as it is
today -- it already correctly disables every button for the duration of
`run()`, including the async work inside it (this file's `useTransition`
already relies on React 19 keeping `isPending` true across an `await` inside
the function passed to `start()`, the same assumption `confirm-destructive.tsx`
makes). Add a second, independent piece of state that says *which* action is
running, used only to decide where the spinner renders:

```ts
const [pending, start] = useTransition();
const [pendingKey, setPendingKey] = useState<string | null>(null);

function run(action: BulkAction) {
  start(async () => {
    setPendingKey(action.key);
    try {
      await attemptCall(() => action.run(), {
        label: "A bulk action rejected instead of reporting",
      });
    } finally {
      setPendingKey(null);
    }
  });
}
```

Add `useState` to this file's existing `import { useTransition } from "react";`
line, making it `import { useState, useTransition } from "react";`.

Then render the spinner in the non-destructive button, in the
`actions.map(...)` block:

```tsx
<Button
  key={action.key}
  type="button"
  variant="outline"
  size="sm"
  disabled={pending}
  onClick={() => run(action)}
>
  {pendingKey === action.key && <Spinner className="mr-1" />}
  {action.label}
</Button>
```

`<ConfirmDestructive>`'s own button (the `action.destructive` branch) is
left exactly as it is today -- destructive actions keep their existing
disabled-only treatment, per the design's scope.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/crud/bulk-action-bar.test.tsx`
Expected: PASS (all tests in the file, including the three pre-existing
ones).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/components/crud/bulk-action-bar.tsx src/components/crud/bulk-action-bar.test.tsx
git commit -m "feat(crud): show a spinner on the bulk action currently running"
```

---

### Task 8: i18n keys for feeds & articles

**Files:**
- Modify: `messages/en.json` (feeds block around lines 262-280, articles
  block around lines 534-537)
- Modify: `messages/de.json` (same locations)

**Interfaces:**
- Produces: new catalog keys `feeds.form.updateNow`,
  `feeds.aggregationCompleted`, `feeds.aggregationCompletedWithFailures`,
  `articles.reloadNow`, `articles.reloadCompleted`,
  `articles.reloadCompletedWithFailures`. Removes `feeds.aggregationEnqueued`
  and `articles.reloadEnqueued` (both now unused once Tasks 9/10 land).
  Tasks 9-12 reference these keys via `useTranslations("feeds")` /
  `useTranslations("articles")`.

- [ ] **Step 1: Edit `messages/en.json`**

In the `feeds.form` object, add `updateNow` after `saved`:

```json
    "form": {
      "aggregator": "Aggregator",
      "aggregatorPlaceholder": "Select aggregator",
      "name": "Name",
      "tags": "Tags",
      "tagsPlaceholder": "Select tags",
      "enabled": "Enabled",
      "enabledDescription": "Turn off to pause fetching new articles.",
      "options": "Options",
      "create": "Create feed",
      "save": "Save feed",
      "created": "Feed created",
      "saved": "Feed saved",
      "updateNow": "Update now"
    },
```

Replace the `feeds` namespace's `"aggregationEnqueued"` line with two keys:

```json
    "bulkRunAggregation": "Run aggregation",
    "aggregationCompleted": "{count, plural, one {# feed updated} other {# feeds updated}}",
    "aggregationCompletedWithFailures": "{completed} updated, {failed} failed",
```

Replace the `articles` namespace's `"reloadEnqueued"` line with two keys, and
add `reloadNow` right after `bulkReload`:

```json
    "bulkReload": "Reload",
    "reloadNow": "Reload content",
    "reloadCompleted": "{count, plural, one {# article reloaded} other {# articles reloaded}}",
    "reloadCompletedWithFailures": "{completed} reloaded, {failed} failed",
```

- [ ] **Step 2: Edit `messages/de.json`** with the same key set, translated:

In `feeds.form`, add after `"saved": "Feed gespeichert"`:

```json
      "updateNow": "Jetzt aktualisieren"
```

Replace `feeds`' `"aggregationEnqueued"` line:

```json
    "bulkRunAggregation": "Aggregation ausführen",
    "aggregationCompleted": "{count, plural, one {# Feed aktualisiert} other {# Feeds aktualisiert}}",
    "aggregationCompletedWithFailures": "{completed} aktualisiert, {failed} fehlgeschlagen",
```

Replace `articles`' `"reloadEnqueued"` line and add `reloadNow`:

```json
    "bulkReload": "Neu laden",
    "reloadNow": "Inhalt neu laden",
    "reloadCompleted": "{count, plural, one {# Artikel neu geladen} other {# Artikel neu geladen}}",
    "reloadCompletedWithFailures": "{completed} neu geladen, {failed} fehlgeschlagen",
```

- [ ] **Step 3: Run the i18n parity test**

Run: `npx vitest run src/i18n/messages.test.ts`
Expected: PASS — `en.json` and `de.json` still define identical key sets.

- [ ] **Step 4: Validate both files are well-formed JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('messages/en.json')); JSON.parse(require('fs').readFileSync('messages/de.json')); console.log('valid')"`
Expected: prints `valid` with no error.

- [ ] **Step 5: Commit**

```bash
git add messages/en.json messages/de.json
git commit -m "feat(i18n): add catalog keys for run-tracked update/reload feedback"
```

---

### Task 9: Wire `feeds-table.tsx`'s "Run aggregation" to the real outcome

**Files:**
- Modify: `src/components/feeds/feeds-table.tsx:142-155` (`runAggregation`),
  and its import block (lines 1-18).

**Interfaces:**
- Consumes: `updateFeedsBulk()` (Task 1, now returns `runId`); `waitForRun()`
  (Task 4); `reportRunOutcome()` (Task 5).
- Produces: no change to `runAggregation`'s signature
  (`() => Promise<boolean>`) or to the `BulkAction` it's wired into --
  Task 7's spinner picks it up automatically because it is still the
  `action.run` for the `"run-aggregation"` key.

- [ ] **Step 1: Update imports**

In `src/components/feeds/feeds-table.tsx`, add:

```ts
import { reportRunOutcome } from "@/lib/jobs/report-run-outcome";
import { waitForRun } from "@/lib/jobs/wait-for-run";
```

- [ ] **Step 2: Replace `runAggregation()` (lines 142-155)**

```ts
async function runAggregation(): Promise<boolean> {
  if (selected.length === 0) return false;

  const result = await attempt(() => updateFeedsBulk(selected));
  if (!result.ok) {
    toast.error(t("saveFailed"));
    return false;
  }

  setSelected([]);

  const outcome = await waitForRun(result.runId);
  reportRunOutcome(outcome, {
    completed: (n) => t("aggregationCompleted", { count: n }),
    partial: (ok, failed) => t("aggregationCompletedWithFailures", { completed: ok, failed }),
    fallback: t("saveFailed"),
  });
  router.refresh();
  return true;
}
```

`router` is already destructured from `useRouter()` at the top of the
component (line 34) and is otherwise unused in this file today -- this is
its first use.

- [ ] **Step 3: Manual verification**

Run `npm run dev`, sign in, go to `/feeds`, select at least one feed, click
"Run aggregation". Confirm: the button shows a spinner (from Task 7) until
the run finishes, then exactly one toast appears reporting the outcome, and
the table refreshes.

- [ ] **Step 4: Run the existing test suite for this file**

Run: `npx vitest run src/components/feeds/feeds-table.test.tsx` if it
exists (`ls src/components/feeds/*.test.tsx` first) -- otherwise skip; this
component may not have a dedicated test file today, and this plan does not
add one (async server-action-driven flows in a `.tsx` test face the same
"async server components cannot be rendered by testing-library" limits
CLAUDE.md documents for other pages -- the coverage that matters here is
Task 1's real-database test on `updateFeedsBulk` and Task 5's direct test on
`reportRunOutcome`).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/components/feeds/feeds-table.tsx
git commit -m "feat(feeds): report Run aggregation's real outcome instead of just enqueuing"
```

---

### Task 10: Wire `articles-table.tsx`'s "Reload" to the real outcome

**Files:**
- Modify: `src/components/articles/articles-table.tsx:153-166`
  (`handleReload`), and its import block (lines 1-16).

**Interfaces:**
- Consumes: `reloadArticles()` (Task 2, now returns `runId`); `waitForRun()`
  (Task 4); `reportRunOutcome()` (Task 5).
- Produces: no change to `handleReload`'s signature or the `BulkAction` it's
  wired into (key `"reload"`).

- [ ] **Step 1: Update imports**

```ts
import { reportRunOutcome } from "@/lib/jobs/report-run-outcome";
import { waitForRun } from "@/lib/jobs/wait-for-run";
```

- [ ] **Step 2: Replace `handleReload()` (lines 153-166)**

```ts
async function handleReload(): Promise<boolean> {
  if (selected.length === 0) return false;

  const result = await attempt(() => reloadArticles(selected));
  if (!result.ok) {
    toast.error(t("saveFailed"));
    return false;
  }

  setSelected([]);

  const outcome = await waitForRun(result.runId);
  reportRunOutcome(outcome, {
    completed: (n) => t("reloadCompleted", { count: n }),
    partial: (ok, failed) => t("reloadCompletedWithFailures", { completed: ok, failed }),
    fallback: t("saveFailed"),
  });
  router.refresh();
  return true;
}
```

`router` is already used elsewhere in this file (`removeSelected`,
`handleSetRead`, `handleSetStarred` all call `router.refresh()`).

- [ ] **Step 3: Manual verification**

`npm run dev`, go to `/articles`, select one or more articles, click
"Reload". Confirm the spinner (Task 7) shows on that button until the run
finishes, then one toast with the real outcome, then the table refreshes.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add src/components/articles/articles-table.tsx
git commit -m "feat(articles): report Reload's real outcome instead of just enqueuing"
```

---

### Task 11: "Update now" button on the feed detail page

**Files:**
- Modify: `src/components/feeds/feed-form.tsx`

**Interfaces:**
- Consumes: `updateFeedsBulk()` (Task 1); `waitForRun()` (Task 4);
  `reportRunOutcome()` (Task 5); `Spinner` (Task 6).
- Produces: no change to `FeedForm`'s props.

- [ ] **Step 1: Update imports**

```ts
import { createFeed, updateFeed, updateFeedsBulk } from "@/lib/feeds/actions";
import { reportRunOutcome } from "@/lib/jobs/report-run-outcome";
import { waitForRun } from "@/lib/jobs/wait-for-run";
import { Spinner } from "@/components/ui/spinner";
```

- [ ] **Step 2: Add the update-now transition and handler**

Right after the existing `const [pending, start] = useTransition();` (around
line 52), add:

```ts
const [updating, startUpdate] = useTransition();

function runUpdate() {
  startUpdate(async () => {
    const result = await updateFeedsBulk([feed!.id]);
    const outcome = await waitForRun(result.runId);
    reportRunOutcome(outcome, {
      completed: () => t("aggregationCompleted", { count: 1 }),
      partial: (ok, failed) => t("aggregationCompletedWithFailures", { completed: ok, failed }),
      fallback: t("saveFailed"),
    });
    router.refresh();
  });
}
```

`updateFeedsBulk` is a plain server action returning `{ ok: true, ... }`
unconditionally (Task 1 dropped its only failure path), so there is no
`attempt()`/`toast.error` branch needed here for the enqueue step itself --
unlike the bulk table action, this one only ever runs on an id the page
itself just loaded, so "not found" is not a reachable outcome. This is
called directly (not through `attemptCall`) because it is invoked from
inside `startUpdate`'s `async` callback the same way the surrounding
`submit()` calls `updateFeed()` directly today -- matching this file's
existing convention rather than introducing a new one.

- [ ] **Step 3: Render the button**

In the button row near the end of the JSX (around where `<Button
type="submit">` and the Cancel `<Link>` are), add, only when editing an
existing feed:

```tsx
<div className="flex flex-wrap gap-2">
  <Button type="submit" disabled={pending}>
    {feed ? t("form.save") : t("form.create")}
  </Button>
  {feed && (
    <Button type="button" variant="outline" disabled={pending || updating} onClick={runUpdate}>
      {updating && <Spinner className="mr-1" />}
      {t("form.updateNow")}
    </Button>
  )}
  <Link href="/feeds" className={buttonVariants({ variant: "outline" })}>
    {c("cancel")}
  </Link>
</div>
```

- [ ] **Step 4: Manual verification**

`npm run dev`, open an existing feed at `/feeds/[id]`, click "Update now".
Confirm the spinner shows on that button (not on Save) until the run
finishes, then one toast, then the page refreshes. Confirm the button does
not appear on `/feeds/new`.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/components/feeds/feed-form.tsx
git commit -m "feat(feeds): add an Update now button to the feed detail page"
```

---

### Task 12: "Reload content" button on the article detail page

**Files:**
- Modify: `src/components/articles/article-form.tsx`

**Interfaces:**
- Consumes: `reloadArticles()` (Task 2); `waitForRun()` (Task 4);
  `reportRunOutcome()` (Task 5); `Spinner` (Task 6).
- Produces: no change to `ArticleForm`'s props.

- [ ] **Step 1: Update imports**

```ts
import { reloadArticles, updateArticle } from "@/lib/articles/actions";
import { reportRunOutcome } from "@/lib/jobs/report-run-outcome";
import { waitForRun } from "@/lib/jobs/wait-for-run";
import { Spinner } from "@/components/ui/spinner";
```

- [ ] **Step 2: Add the reload transition and handler**

Right after `const [isPending, startTransition] = useTransition();` (line
30), add:

```ts
const [reloading, startReload] = useTransition();

function runReload() {
  startReload(async () => {
    const result = await reloadArticles([article.id]);
    const outcome = await waitForRun(result.runId);
    reportRunOutcome(outcome, {
      completed: () => t("reloadCompleted", { count: 1 }),
      partial: (ok, failed) => t("reloadCompletedWithFailures", { completed: ok, failed }),
      fallback: t("saveFailed"),
    });
    router.refresh();
  });
}
```

- [ ] **Step 3: Render the button**

Replace the button row (lines 123-127):

```tsx
<div className="flex items-center space-x-2 pt-2">
  <Button type="submit" disabled={isPending}>
    {isPending ? t("save") + "..." : t("save")}
  </Button>
  <Button type="button" variant="outline" disabled={isPending || reloading} onClick={runReload}>
    {reloading && <Spinner className="mr-1" />}
    {t("reloadNow")}
  </Button>
</div>
```

Unlike the feed form, this button is unconditional: every article on this
page already exists (there is no "create article" flow), so there is no
`feed ?`-style guard needed here.

- [ ] **Step 4: Manual verification**

`npm run dev`, open an article at `/articles/[id]`, click "Reload content".
Confirm the spinner shows on that button until the run finishes, then one
toast, then the page refreshes.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/components/articles/article-form.tsx
git commit -m "feat(articles): add a Reload content button to the article detail page"
```

---

## Final verification (after all 12 tasks)

Run the full CI-equivalent check once everything above is committed:

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
```

All four must pass before considering this plan complete.
