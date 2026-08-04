import { connection } from "next/server";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { subscribeUserEvents } from "@/lib/api/events";

/**
 * How often a ping comment frame is written so intermediaries (proxies, load
 * balancers) don't treat a quiet-but-live connection as dead and close it.
 * Comment lines (`: ...`) per the SSE spec are ignored by `EventSource`/any
 * conforming client, so this is invisible to whatever consumes real events.
 */
const PING_INTERVAL_MS = 15_000;

/**
 * The native client's live notification feed for job/run progress -- one
 * long-lived connection instead of polling `GET /api/v1/runs/[id]` (Task 19).
 * Rides on top of `src/lib/api/events.ts`'s in-process pub/sub, which that
 * module documents as best-effort: a dropped connection here loses nothing
 * but low-latency notification, since the `jobs`/`runs` tables remain the
 * source of truth a client can always fall back to polling.
 *
 * `await connection()` must be the literal first statement, ahead of
 * `requireApiUser()` -- see the `connection()` bullet in the root CLAUDE.md.
 * This route has no other Dynamic API call in its path (a Bearer-token
 * caller never touches `next/headers`), so nothing else would opt it out of
 * prerendering.
 *
 * Auth failure returns the same `apiErrorResponse()` every other `/api/v1/**`
 * route does -- a normal JSON 401, not a stream -- because it is resolved
 * *before* the `ReadableStream` (and its `Response`) is ever constructed.
 */
export async function GET(request: Request): Promise<Response> {
  await connection();

  let userId: string;
  try {
    const user = await requireApiUser(request);
    userId = user.id;
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }

  const encoder = new TextEncoder();

  // Populated by `start()`, which the stream spec guarantees runs
  // synchronously before either teardown path below can fire -- `cancel()`
  // cannot run before a reader exists, and no reader exists until this
  // `ReadableStream` constructor (which calls `start()` inline) returns.
  let unsubscribe: (() => void) | undefined;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let cleaned = false;

  // Guarded so it runs exactly once however the connection ends: the client
  // disconnecting fires `abort` on `request.signal` (handled in `start()`
  // below), and a consumer canceling the stream's reader directly -- some
  // client libraries, and this route's own tests -- invokes the `cancel()`
  // hook instead. Without the guard, whichever fires second would clear an
  // already-cleared interval, unsubscribe an already-removed listener, and
  // (in the `abort` path) call `close()` on a controller `cancel()` already
  // tore down. All three are individually harmless, but the guard is what
  // makes that "harmless" rather than "happens to not throw today."
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

      unsubscribe = subscribeUserEvents(userId, (event) => send(event.type, event.payload));

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
    },
  });
}
