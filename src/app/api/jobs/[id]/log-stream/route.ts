import { isAdminRole } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";
import { getJob, listJobLogs } from "@/lib/jobs/queue";
import { subscribeJobLog, subscribeJobTerminal } from "@/lib/jobs/log-bus";

/**
 * How often a ping comment frame is written so intermediaries don't treat a
 * quiet-but-live connection as dead. Same interval and framing as
 * `src/app/api/v1/jobs/events/route.ts`.
 */
const PING_INTERVAL_MS = 15_000;

/**
 * The web UI's live tail for one job's log (`src/components/jobs/job-log-viewer.tsx`).
 * Session-authenticated (`requireUser()`), unlike the Bearer-auth
 * `/api/v1/jobs/events` -- `requireUser()` awaits `headers()` as its first
 * action, which is what opts this route out of static prerendering; see the
 * `connection()` bullet in CLAUDE.md and `src/app/media/avatars/[userId]/route.ts`
 * for the same shape.
 *
 * `?after=<id>` is the cursor: everything persisted after it is sent first
 * (oldest first), then new lines stream live. Both `listJobLogs()` and the
 * terminal-status check below read synchronously off the same `job` row
 * fetched once at the top of `GET()` (for the 404 check), and nothing awaits
 * between that read and the subscribe calls in `start()`, so there is no gap
 * in a single-threaded process for a line -- or a terminal transition -- to
 * be published and missed. A second `getJob()` call inside `start()` would
 * actually be wrong here, not just redundant: it could observe a job that
 * turned terminal *after* the row above was read but before `start()` ran,
 * in which case both the fresh read *and* `subscribeJobTerminal()` would
 * report the transition -- once as an immediate close, once as a duplicate
 * live notification. Reusing the one closure-captured `job` keeps "terminal
 * already, at connect time" and "terminal notification arrives later"
 * mutually exclusive.
 *
 * If the job is still running when the client connects, this subscribes to
 * both `subscribeJobLog()` (new lines) and `subscribeJobTerminal()`
 * (`src/lib/jobs/log-bus.ts`) -- the latter is what lets this route send
 * `end` and close the stream when the job finishes *while* the client is
 * still watching, rather than only when it was already finished at connect
 * time. Without it, a still-open connection for a job that completes mid-tail
 * would sit forever answering nothing but pings: `logEnded` in
 * `job-log-viewer.tsx` would never fire, and the listener/interval pair here
 * would leak for as long as the browser tab stayed open.
 *
 * User-scoped: a non-admin may only stream a job's log if they own it
 * (`job.userId === user.id`); an admin (`isAdminRole()`) may stream any job's
 * log, ownerless jobs included. Same check as `/jobs/[id]`
 * (`src/app/(app)/jobs/[id]/page.tsx`), adapted to answer 404 instead of
 * calling `notFound()`.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await requireUser();
  const admin = isAdminRole(user.role);

  const { id } = await params;
  const jobId = Number(id);
  const job = Number.isInteger(jobId) ? getJob(jobId) : null;
  if (!job || (!admin && job.userId !== user.id)) {
    return new Response(null, { status: 404 });
  }

  const url = new URL(request.url);
  const afterParam = Number(url.searchParams.get("after") ?? "0");
  const cursor = Number.isInteger(afterParam) && afterParam >= 0 ? afterParam : 0;

  const encoder = new TextEncoder();
  let unsubscribeLog: (() => void) | undefined;
  let unsubscribeTerminal: (() => void) | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(keepAlive);
    unsubscribeLog?.();
    unsubscribeTerminal?.();
  };

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      for (const line of listJobLogs(jobId, cursor)) {
        send("line", line);
      }

      if (job.status === "completed" || job.status === "failed") {
        send("end", { status: job.status });
        controller.close();
        return;
      }

      unsubscribeLog = subscribeJobLog(jobId, (line) => send("line", line));
      unsubscribeTerminal = subscribeJobTerminal(jobId, (status) => {
        send("end", { status });
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed -- e.g. `cancel()` ran first.
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
