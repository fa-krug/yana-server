# Run-tracked spinner + completion toast for feed update & article reload

Date: 2026-08-05

## Problem

Every action button in the app already disables itself and swaps its label
(e.g. "Save" -> "Saving...") while its server action is in flight, and most
report a toast via the `attempt()` / `reportOutcomeIn()` convention. That is
enough for actions that complete synchronously.

"Run aggregation" (feeds) and "Reload" (articles) are different: the button's
own request only *enqueues* rows in the `jobs` table, which an in-process
worker drains one at a time (`src/lib/jobs/worker.ts`, `claim()` in
`src/lib/jobs/queue.ts`). The actual work -- fetching and parsing a feed,
re-extracting an article's content -- can take anywhere from a couple of
seconds to several minutes for a large bulk selection, and today's UI reports
"N enqueued" the instant the insert commits, before any of that work has
happened. There is no visible indication that anything is still running, and
no notification of whether it actually succeeded.

## Scope

Exactly four buttons get real run-tracking:

1. Feeds list -> bulk action bar -> **Run aggregation**
   (`src/components/feeds/feeds-table.tsx`, existing)
2. Feed detail page (`/feeds/[id]`) -> new **Update now** button
   (`src/components/feeds/feed-form.tsx`)
3. Articles list -> bulk action bar -> **Reload**
   (`src/components/articles/articles-table.tsx`, existing)
4. Article detail page (`/articles/[id]`) -> new **Reload content** button
   (`src/components/articles/article-form.tsx`)

Every other action button in the app (Save, Delete, mark read/unread,
star/unstar, credential Save/Test/Remove, user CRUD, etc.) is unchanged. The
mechanism added here (a run-id-returning enqueue + a bounded poll-to-terminal
helper + a shared spinner) is generic and reusable by a future long-running
action, but this project wires it up to only these four call sites.

## Existing infrastructure this reuses

The `runs` table and the grouped-enqueue helper already exist and are already
proven, via the external Bearer-token API:

- `runs` / `jobs` schema: `src/lib/db/schema/jobs.ts`
- `enqueueRun(userId, kind, payloads)`: creates one `runs` row plus N `jobs`
  rows referencing it, returns the run id. An empty `payloads` array is legal
  and creates an already-`"completed"` run with `totalJobs: 0` (see the
  function's own doc comment in `src/lib/jobs/queue.ts`) -- so `runId` is
  always a real, non-null id, never a sentinel for "nothing to do".
- `complete()` / `fail()` in the same file already bump a run's
  `completedJobs` / `failedJobs` counters and flip its `status` to
  `"completed"` / `"failed"` once every child job has reported in
  (`bumpRunCounters()`). No change needed there.
- Precedent for the exact request/response shape this design's new
  `getRunStatus()` mirrors: `src/app/api/v1/runs/[id]/route.ts` (ownership
  check via `runs.userId`, 404-shaped-as-absent on mismatch).

This design does **not** touch the SSE job/run event stream
(`src/app/api/v1/jobs/events/route.ts`, `src/lib/api/events.ts`) -- that
stream is Bearer-token-only, for the external native client. The web
dashboard is session-cookie-authenticated, so it gets its own polling path
instead of trying to reuse Bearer-only infrastructure.

## Backend changes

### `updateFeedsBulk()` and `reloadArticles()` return a `runId`

`src/lib/feeds/actions.ts`:

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

Same shape change for `reloadArticles()` in `src/lib/articles/actions.ts`
(kind `"article.reload"`, payload `{ articleId }`).

Both drop their own hand-rolled `writeTransaction` + bare `jobs` insert in
favor of `enqueueRun()`, which already opens its own transaction --
matching how `POST /api/v1/aggregate` (`src/app/api/v1/aggregate/route.ts`)
already does the same select-then-`enqueueRun()` sequence with no outer
transaction wrapping it. `refreshLogos()` and `restoreFeedsBulk()` in the same
file are **not** touched -- they stay on bare `jobs` inserts, since they are
out of scope and their return shape must not change.

The one other caller that enqueues `"article.reload"` jobs --
`src/app/api/v1/articles/[id]/reload/route.ts`, the Bearer-token single-article
endpoint -- has its own independent insert and does not call `reloadArticles()`
at all, so it is unaffected by this change.

### `getRunStatus()` -- the dashboard's poll target

New file `src/lib/jobs/actions.ts` (`"use server"`):

```ts
export type RunStatus = {
  status: string;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
};

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
  const { userId: _owner, ...status } = run;
  return status;
}
```

`null` covers both "no such run" and "not yours" identically, the same
enumeration-safe convention `requireAdmin()` and the avatar route already
follow elsewhere in this codebase.

## Frontend changes

### `waitForRun()` -- bounded poll-to-terminal helper

New file `src/lib/jobs/wait-for-run.ts` (plain function, no `"use client"`
needed, but only ever called from client components):

```ts
export type RunOutcome =
  | { ok: true; status: RunStatus }
  | { ok: false; reason: "not-found" | "timeout" | "request-failed" };

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 300; // 10 minutes

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

Every server-action call goes through `attemptCall` per the
"never a bare await" rule (`src/lib/attempt.ts`) -- including a polling read,
not just a mutation. On the happy path (the call returns normally every time)
`attemptCall` never touches the session probe; that only fires on an actual
rejection, so polling every 2s costs nothing extra in the common case.

10 minutes is a deliberately generous, bounded ceiling for a worker that
processes one job at a time -- large enough that a normal bulk selection
finishes well inside it, small enough that a genuinely stuck run does not
spin the tab forever. On timeout the caller reports "still running" rather
than a failure (see Error handling below).

### `<Spinner>` -- one shared visual

New `src/components/ui/spinner.tsx`:

```tsx
export function Spinner({ className }: { className?: string }) {
  return <Loader2Icon className={cn("size-4 animate-spin", className)} />;
}
```

Matches the icon already used for Sonner's own loading toasts
(`src/components/ui/sonner.tsx`). No new prop on the shared `<Button>` --
composition (`{pending && <Spinner />}` beside the label) is enough for four
call sites and keeps every other `<Button>` consumer in the codebase
unaffected.

### `BulkActionBar` -- spinner on the running action only

`src/components/crud/bulk-action-bar.tsx` currently tracks one shared
`pending` boolean from a single `useTransition`, which disables every button
in the bar but cannot say *which* action is running. Add a `pendingKey`
(the `action.key` currently in flight) alongside it:

- `run(action)` sets `pendingKey` before calling `attemptCall`, clears it in
  a `finally`.
- Each non-destructive action's button renders `<Spinner className="mr-1" />`
  before its label when `pendingKey === action.key`; the rest still just
  render disabled, as today.
- `<ConfirmDestructive>`'s own internal `pending` (its own `useTransition`)
  is untouched -- destructive actions are out of scope for this change.

This is the "generic, reusable everywhere" half: any bulk action's `run()`
that takes a while automatically gets a visible spinner on its own button.
Today only "Run aggregation" and "Reload" have a `run()` that stays pending
long enough for it to matter.

### Wiring the two bulk actions to the real outcome

`src/components/feeds/feeds-table.tsx`, `runAggregation()`:

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

(`reportRunOutcome` is a tiny shared helper -- see below -- so the
completed/partial-failure/timeout branching is not duplicated between the two
tables.) The old immediate `toast.success(t("aggregationEnqueued", ...))` is
removed: there is now exactly one toast, reporting the real result, at the
end -- matching the request this whole feature is answering.

`src/components/articles/articles-table.tsx`, `handleReload()`: identical
shape, against `reloadArticles()` / `reloadCompleted` /
`reloadCompletedWithFailures`.

### `reportRunOutcome()` -- shared completion-toast logic

New helper, `src/lib/jobs/report-run-outcome.ts` (plain function, imports
`sonner`'s `toast` directly like the table components already do -- this is
UI-adjacent glue, not a namespaced catalog binding, so it does not need the
`reportOutcomeIn()` factory treatment):

```ts
export function reportRunOutcome(
  outcome: RunOutcome,
  copy: { completed: (n: number) => string; partial: (ok: number, failed: number) => string; fallback: string },
): void {
  if (!outcome.ok) {
    // "timeout" is deliberately not an error: the run is still going, just
    // slower than this tab was willing to wait. Nothing failed.
    if (outcome.reason === "timeout") return;
    toast.error(copy.fallback);
    return;
  }
  const { completedJobs, failedJobs } = outcome.status;
  if (failedJobs === 0) toast.success(copy.completed(completedJobs));
  else toast.warning(copy.partial(completedJobs, failedJobs));
}
```

### Single-item buttons on the detail pages

`src/components/feeds/feed-form.tsx`: a second `useTransition`
(`[updating, startUpdate]`), a `type="button"` next to Save, rendered only
when `feed` is defined (the create-a-new-feed flow has nothing to update
yet):

```tsx
{feed && (
  <Button type="button" variant="outline" disabled={pending || updating} onClick={runUpdate}>
    {updating && <Spinner className="mr-1" />}
    {t("form.updateNow")}
  </Button>
)}
```

where `runUpdate()` calls `updateFeedsBulk([feed.id])` -> `waitForRun()` ->
`reportRunOutcome()` -> `router.refresh()`, same shape as the table's
`runAggregation()`.

`src/components/articles/article-form.tsx`: same pattern, a **Reload
content** button calling `reloadArticles([article.id])`. Since every article
already belongs to an existing row (there is no "create article" flow), this
button is unconditional rather than gated on an optional prop.

## i18n

New keys, added to both `messages/en.json` and `messages/de.json` (parity is
compiler- and test-enforced, `src/i18n/messages.test.ts`):

`feeds` namespace:
- `form.updateNow`: "Update now"
- `aggregationCompleted`: `"{count, plural, one {# feed updated} other {# feeds updated}}"`
- `aggregationCompletedWithFailures`: `"{completed} updated, {failed} failed"`

`articles` namespace:
- `form.reloadNow`: "Reload content"
- `reloadCompleted`: `"{count, plural, one {# article reloaded} other {# articles reloaded}}"`
- `reloadCompletedWithFailures`: `"{completed} reloaded, {failed} failed"`

The existing `aggregationEnqueued` / `reloadEnqueued` keys become dead once
the tables stop using them; they are removed rather than left as unused
catalog entries (a stale key is exactly the kind of drift the i18n rules in
CLAUDE.md exist to prevent). `saveFailed` (both namespaces, already present)
is reused for the request-failure/not-found branches -- no new key needed.

## Error handling / edge cases

- **Empty selection**: unchanged -- both bulk functions already return early
  (`enqueued: 0`, and now `runId` pointing at an already-`"completed"`,
  zero-job run) before anything is enqueued. `waitForRun()` sees a run that
  is immediately terminal and resolves on its first poll.
- **Enqueue itself fails** (network/session): reported exactly as today,
  via `attempt()` + `toast.error(t("saveFailed"))`, before `waitForRun()` is
  ever called.
- **Poll request fails or the run vanishes**: `reportRunOutcome` shows the
  generic `saveFailed` toast. This should not happen in practice (a run this
  request just created, under this same user, disappearing mid-poll implies
  something else deleted it), but it is handled rather than left to throw.
- **Poll times out (10 minutes)**: no error toast -- the run is still
  legitimately in progress server-side and will finish; the tab just stops
  watching. `router.refresh()` is still called so the list reflects whatever
  has completed so far.
- **User navigates away mid-poll**: the polling `Promise` chain is abandoned
  with the unmounting component; no cleanup is required because
  `waitForRun()` holds no subscription or timer past a component's lifetime
  other than its own in-flight `setTimeout`, which simply finishes and its
  result is discarded. The enqueued run itself is unaffected -- it keeps
  processing server-side regardless of whether any tab is watching.
- **Concurrent runs** (user fires "Run aggregation" again while one is still
  polling): unchanged from today's bulk-action-bar behavior -- the bar's
  shared transition keeps every action button disabled until the current
  `run()` promise resolves, so a second run cannot be started from the same
  bar while the first is still being awaited. The two detail-page buttons
  have their own independent `useTransition`, so a feed-detail "Update now"
  and an unrelated article-detail "Reload content" can run concurrently in
  two different tabs -- that is fine, they enqueue unrelated runs.

## Testing

- `src/lib/feeds/actions.test.ts`: `updateFeedsBulk()` returns a real
  `runId`; the created `runs` row has `totalJobs` equal to the valid feed
  count and `status: "running"` (or `"completed"` for an empty selection).
- `src/lib/articles/actions.test.ts`: same shape of assertions for
  `reloadArticles()`.
- New `src/lib/jobs/actions.test.ts`: `getRunStatus()` returns the row for
  its owner, `null` for another user's run id, `null` for a nonexistent id.
- `src/components/crud/bulk-action-bar.test.tsx` (new or extended): the
  spinner renders on the button matching `pendingKey` while a `run()` promise
  is unresolved, and not on sibling buttons.
- Driving `waitForRun()`'s real 2-second polling loop end-to-end is out of
  scope for this pass -- injecting a fake `getRunStatus` and asserting
  `reportRunOutcome()`'s three branches (completed / partial failure /
  timeout -> no toast) directly is enough coverage without coupling a test
  to real wall-clock delays.
