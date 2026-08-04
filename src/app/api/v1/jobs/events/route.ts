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

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      const unsubscribe = subscribeUserEvents(userId, (event) => send(event.type, event.payload));

      const keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode(": ping\n\n"));
      }, PING_INTERVAL_MS);

      // Runs exactly once, however the connection ends: the client
      // disconnecting (fires `abort` on `request.signal`) or the reader on
      // our own `Response.body` being canceled locally, since Next/undici
      // propagate a canceled body read back to this stream's `cancel()`.
      const cleanup = () => {
        clearInterval(keepAlive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed -- e.g. `cancel()` ran first and this is the
          // `abort` listener firing right after.
        }
      };

      request.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      // No-op body: cleanup is idempotent and already wired to `abort`
      // above, which Next fires when the underlying request is done. This
      // hook exists so a direct `reader.cancel()` (as in tests, or a client
      // that closes the stream without the request itself aborting) is also
      // a defined, non-throwing outcome.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
    },
  });
}
