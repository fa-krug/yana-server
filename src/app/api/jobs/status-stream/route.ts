import { and, eq, inArray } from "drizzle-orm";

import { isAdminRole } from "@/lib/auth/roles";
import { requireUserFreshRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema";
import { subscribeJobTerminal } from "@/lib/jobs/log-bus";

/**
 * How often a ping comment frame is written so intermediaries don't treat a
 * quiet-but-live connection as dead. Same interval and framing as
 * `src/app/api/jobs/[id]/log-stream/route.ts`.
 */
const PING_INTERVAL_MS = 15_000;

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * The web dashboard's live replacement for polling `getJobsStatus()` while a
 * `deleteJobs()` call's `stopping` set finishes cancelling --
 * `@/lib/jobs/wait-for-jobs-terminal` opens one of these instead of
 * re-fetching every two seconds. `?ids=1,2,3`; every id not owned by the
 * caller (or that does not exist) is treated the same as one that already
 * went terminal -- `getJobsStatus()`'s own contract was "absent from the
 * result means done waiting on it", and an SSE `done` event per id is this
 * route's equivalent of that.
 *
 * User-scoped like `getJobsStatus()`: a non-admin only sees ids they own: an
 * id that belongs to someone else is silently treated as already resolved,
 * never reported as any other user's status.
 *
 * Rides on `subscribeJobTerminal()` (`@/lib/jobs/log-bus`), the same bus
 * `src/app/api/jobs/[id]/log-stream/route.ts` already subscribes to for a
 * single job's own log stream -- no new publishing wired up here.
 *
 * `requireUserFreshRole()` awaits `headers()` as its first action, which is
 * what opts this route out of static prerendering -- see the `connection()`
 * bullet in CLAUDE.md. The initial ownership-filtered row read happens once,
 * before the `ReadableStream` is constructed, and nothing awaits between that
 * read and the `subscribeJobTerminal()` calls inside `start()` (called
 * synchronously from the constructor) -- so "already terminal at connect
 * time" and "turns terminal after connect" stay mutually exclusive, the same
 * reasoning `log-stream/route.ts` documents for one job's status.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await requireUserFreshRole();
  const admin = isAdminRole(user.role);

  const url = new URL(request.url);
  const ids = [
    ...new Set(
      (url.searchParams.get("ids") ?? "")
        .split(",")
        .map((raw) => Number(raw))
        .filter((id) => Number.isInteger(id)),
    ),
  ];

  const ownership = admin ? undefined : eq(jobs.userId, user.id);
  const rows =
    ids.length === 0
      ? []
      : getDb()
          .select({ id: jobs.id, status: jobs.status })
          .from(jobs)
          .where(ownership ? and(inArray(jobs.id, ids), ownership) : inArray(jobs.id, ids))
          .all();
  const statusById = new Map(rows.map((row) => [row.id, row.status]));

  const encoder = new TextEncoder();
  const unsubscribes: Array<() => void> = [];
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(keepAlive);
    for (const unsubscribe of unsubscribes) unsubscribe();
  };

  const stream = new ReadableStream({
    start(controller) {
      const send = (id: number, status: string) => {
        controller.enqueue(
          encoder.encode(`event: done\ndata: ${JSON.stringify({ id, status })}\n\n`),
        );
      };

      const pending = new Set<number>();
      for (const id of ids) {
        const status = statusById.get(id);
        if (status !== undefined && !TERMINAL_STATUSES.has(status)) {
          pending.add(id);
        } else {
          // Not owned, deleted already, or already terminal -- nothing left to wait on.
          send(id, status ?? "gone");
        }
      }

      if (pending.size === 0) {
        controller.close();
        return;
      }

      for (const id of pending) {
        unsubscribes.push(
          subscribeJobTerminal(id, (status) => {
            send(id, status);
            pending.delete(id);
            if (pending.size === 0) {
              cleanup();
              try {
                controller.close();
              } catch {
                // Already closed -- e.g. `cancel()` ran first.
              }
            }
          }),
        );
      }

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
