import { requireUser } from "@/lib/auth/session";
import { subscribeUserEvents } from "@/lib/api/events";
import { getRun } from "@/lib/jobs/queue";
import type { RunStatus } from "@/lib/jobs/actions";

/**
 * How often a ping comment frame is written so intermediaries don't treat a
 * quiet-but-live connection as dead. Same interval and framing as
 * `src/app/api/jobs/[id]/log-stream/route.ts` and `src/app/api/v1/jobs/events/route.ts`.
 */
const PING_INTERVAL_MS = 15_000;

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

function toRunStatus(run: {
  status: string;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
}): RunStatus {
  return {
    status: run.status,
    totalJobs: run.totalJobs,
    completedJobs: run.completedJobs,
    failedJobs: run.failedJobs,
  };
}

/**
 * The web dashboard's live replacement for polling `getRunStatus()`
 * (`@/lib/jobs/actions`) -- `@/lib/jobs/wait-for-run` opens one of these per
 * tracked run instead of re-fetching every two seconds. Session-authenticated
 * (`requireUser()`), matching `getRunStatus()`'s own ownership check exactly:
 * a run belongs to the user who started it, with no admin override, so
 * mismatched or nonexistent ids both answer the same 404 rather than a
 * distinguishable error -- this cannot be used to enumerate other users' run
 * ids.
 *
 * Rides on the same in-process pub/sub `/api/v1/jobs/events` already uses
 * (`@/lib/api/events`), which `src/lib/jobs/queue.ts` publishes a `run` event
 * to every time a child job's completion updates this run's counters. No new
 * publishing wired up here -- only a second, session-authenticated subscriber
 * to an event that was already being emitted.
 *
 * `requireUser()` awaits `headers()` as its first action, which is what opts
 * this route out of static prerendering -- see the `connection()` bullet in
 * CLAUDE.md.
 *
 * `run` is read once, before the `ReadableStream` is constructed, and nothing
 * awaits between that read and the `subscribeUserEvents()` call inside
 * `start()` (which the stream spec calls synchronously from the constructor)
 * -- so "already terminal at connect time" and "turns terminal after connect"
 * stay mutually exclusive, the same reasoning `log-stream/route.ts` documents
 * for a job's status.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await requireUser();

  const { id } = await params;
  const runId = Number(id);
  const run = Number.isInteger(runId) ? getRun(runId) : null;
  if (!run || run.userId !== user.id) {
    return new Response(null, { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(keepAlive);
    unsubscribe?.();
  };

  const stream = new ReadableStream({
    start(controller) {
      const send = (status: RunStatus) => {
        controller.enqueue(encoder.encode(`event: status\ndata: ${JSON.stringify(status)}\n\n`));
      };

      if (TERMINAL_STATUSES.has(run.status)) {
        send(toRunStatus(run));
        controller.close();
        return;
      }

      unsubscribe = subscribeUserEvents(user.id, (event) => {
        if (event.type !== "run" || event.payload.runId !== runId) return;

        send(toRunStatus(event.payload));

        if (TERMINAL_STATUSES.has(event.payload.status)) {
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed -- e.g. `cancel()` ran first.
          }
        }
      });

      keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, PING_INTERVAL_MS);

      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed -- e.g. `cancel()` ran first.
        }
      });
    },
    cancel: cleanup,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
