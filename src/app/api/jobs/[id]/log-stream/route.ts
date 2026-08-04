import { requireUser } from "@/lib/auth/session";
import { getJob, listJobLogs } from "@/lib/jobs/queue";
import { subscribeJobLog } from "@/lib/jobs/log-bus";

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
 * (oldest first), then new lines stream live. Both `listJobLogs()` and
 * `subscribeJobLog()` below are synchronous, and nothing awaits between them,
 * so there is no gap in a single-threaded process for a line to be published
 * and missed by both paths.
 *
 * Not user-scoped: `/jobs` today is visible to any signed-in user
 * (`listJobs()`/`getJob()` apply no ownership filter), so this route applies
 * none either.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  await requireUser();

  const { id } = await params;
  const jobId = Number(id);
  const job = Number.isInteger(jobId) ? getJob(jobId) : null;
  if (!job) {
    return new Response(null, { status: 404 });
  }

  const url = new URL(request.url);
  const afterParam = Number(url.searchParams.get("after") ?? "0");
  const cursor = Number.isInteger(afterParam) && afterParam >= 0 ? afterParam : 0;

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
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      for (const line of listJobLogs(jobId, cursor)) {
        send("line", line);
      }

      const current = getJob(jobId);
      if (current?.status === "completed" || current?.status === "failed") {
        send("end", { status: current.status });
        controller.close();
        return;
      }

      unsubscribe = subscribeJobLog(jobId, (line) => send("line", line));

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
