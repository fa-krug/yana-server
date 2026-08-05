"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Spinner } from "@/components/ui/spinner";
import { reportRunOutcome, type RunOutcomeCopy } from "@/lib/jobs/report-run-outcome";
import { waitForRun } from "@/lib/jobs/wait-for-run";

type ActiveRunsContextValue = {
  trackRun: (runId: number, copy: RunOutcomeCopy) => void;
  /**
   * Registers an already-started, already-self-reporting background promise
   * so the indicator's spinner counts it too -- for work that isn't a `runs`
   * row and so has no `RunOutcome` to report (e.g.
   * `@/components/jobs/jobs-table.tsx`'s wait-for-cancellation-then-delete
   * follow-up). Bookkeeping only: the promise is already running by the time
   * it's passed in, so a caller with no provider mounted (a test rendering
   * the component in isolation) still gets its real behaviour, just with no
   * visible spinner.
   */
  trackBackgroundTask: (task: Promise<unknown>) => void;
  activeCount: number;
};

const noop = () => {};

/**
 * The default (no provider mounted) is a stable, inert value -- same reason
 * `breadcrumb-title.tsx` uses one -- so a component calling `useTrackRun()`,
 * `useTrackBackgroundTask()` or rendering `<ActiveRunsIndicator>` in isolation
 * (a future test with no provider wrapped around it) gets a no-op/empty state
 * rather than a throw.
 */
const DEFAULT_VALUE: ActiveRunsContextValue = {
  trackRun: noop,
  trackBackgroundTask: noop,
  activeCount: 0,
};

const ActiveRunsContext = React.createContext<ActiveRunsContextValue>(DEFAULT_VALUE);

/**
 * Tracks background runs app-wide, mounted once in `(app)/layout.tsx` so it
 * survives client-side navigation between routes -- a run started from
 * /feeds keeps polling and reporting its outcome even after the user has
 * moved on to /articles. Each caller hands its `runId` off via
 * `useTrackRun()` right after enqueuing, instead of awaiting `waitForRun()`
 * itself the way the pre-existing per-page callers (`feed-form.tsx`,
 * `articles-table.tsx`) still do; this component owns that wait instead, once
 * per tracked run, and outlives the component that started it.
 * `useTrackBackgroundTask()` is the same idea for work that has no run id --
 * see the type's own doc comment.
 *
 * Renders nothing itself -- `<ActiveRunsIndicator>` is the visible half, kept
 * separate so it can be placed inside the header's own flex row rather than
 * floating over page content. A `position: fixed` badge in a page corner
 * collided with exactly the control a fixed corner is most likely to hold: the
 * "New feed"/"New user"/etc. button every CRUD list page already puts at its
 * own top-right, clipping it under the badge's `z-50`. The header has no such
 * control on its right side on any route, so docking it there instead cannot
 * collide with anything a page renders.
 */
export function ActiveRunsProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [runIds, setRunIds] = React.useState<number[]>([]);
  const [taskCount, setTaskCount] = React.useState(0);

  const trackRun = React.useCallback(
    (runId: number, copy: RunOutcomeCopy) => {
      setRunIds((prev) => (prev.includes(runId) ? prev : [...prev, runId]));

      void (async () => {
        const outcome = await waitForRun(runId);
        reportRunOutcome(outcome, copy);
        setRunIds((prev) => prev.filter((id) => id !== runId));
        router.refresh();
      })();
    },
    [router],
  );

  const trackBackgroundTask = React.useCallback((task: Promise<unknown>) => {
    setTaskCount((prev) => prev + 1);
    void task.finally(() => setTaskCount((prev) => prev - 1));
  }, []);

  const value = React.useMemo(
    () => ({ trackRun, trackBackgroundTask, activeCount: runIds.length + taskCount }),
    [trackRun, trackBackgroundTask, runIds.length, taskCount],
  );

  return <ActiveRunsContext.Provider value={value}>{children}</ActiveRunsContext.Provider>;
}

/** Registers a background run to be polled to completion and reported, from anywhere in the app. */
export function useTrackRun(): (runId: number, copy: RunOutcomeCopy) => void {
  return React.useContext(ActiveRunsContext).trackRun;
}

/** Registers an already-running background task so the spinner counts it -- see the type's doc comment. */
export function useTrackBackgroundTask(): (task: Promise<unknown>) => void {
  return React.useContext(ActiveRunsContext).trackBackgroundTask;
}

/** The pill shown in the header's own right-aligned slot while any run is active. Nothing while idle. */
export function ActiveRunsIndicator() {
  const t = useTranslations("jobs");
  const { activeCount } = React.useContext(ActiveRunsContext);

  if (activeCount === 0) return null;

  return (
    <Link
      href="/jobs"
      className="ml-auto flex items-center gap-2 rounded-full border bg-background/95 px-3.5 py-1.5 text-sm font-medium shadow-lg ring-1 ring-foreground/10 backdrop-blur-sm animate-in fade-in-0 zoom-in-95 hover:bg-muted"
    >
      <Spinner className="text-primary" />
      {t("activeRuns", { count: activeCount })}
    </Link>
  );
}
