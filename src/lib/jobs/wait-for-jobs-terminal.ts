/**
 * Wait for every id in `ids` to reach a terminal status over
 * `/api/jobs/status-stream` (`src/app/api/jobs/status-stream/route.ts`)
 * instead of re-fetching `getJobsStatus()` on a timer. That route sends one
 * `done` event per id immediately for anything already terminal (or not this
 * user's, or already deleted -- same "absent means done" contract
 * `getJobsStatus()` used to answer with), then one more per id as it actually
 * finishes, so this resolves the moment the server knows rather than up to
 * two seconds late.
 *
 * **Deliberately unbounded**, same reasoning as `@/lib/jobs/wait-for-run`: a
 * job with no cooperative-cancellation checkpoint only stops once it finishes
 * on its own, and there is no good shorter timeout to guess at. The browser's
 * own `EventSource` reconnects on a transient drop, so a blip is not a reason
 * to resolve -- only `onerror` firing with `readyState === CLOSED` is, the
 * terminal state `EventSource` never retries from. Returns `false` only on a
 * real failure -- the connection closed for good before every id reported in;
 * if the caller navigates away, this promise chain is simply abandoned.
 */
export function waitForJobsTerminal(ids: number[]): Promise<boolean> {
  if (ids.length === 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    const source = new EventSource(`/api/jobs/status-stream?ids=${ids.join(",")}`);
    const remaining = new Set(ids);
    let settled = false;

    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      source.close();
      resolve(result);
    };

    source.addEventListener("done", (event) => {
      const { id } = JSON.parse((event as MessageEvent).data) as { id: number; status: string };
      remaining.delete(id);
      if (remaining.size === 0) settle(true);
    });

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) settle(false);
    };
  });
}
