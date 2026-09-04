/**
 * TEST-ONLY: the two response shapes every bounded-fetch test needs.
 *
 * Both are here rather than copied into each of the four call-site test files,
 * because the thing they express -- "headers arrived, the body then misbehaves"
 * -- is the single hazard `withDeadline()` and `readCapped()` exist to bound,
 * and four hand-written copies of it is the same defect at one remove.
 */

/**
 * A response whose headers arrive at once and whose body then never delivers
 * another byte -- the shape a stalling server produces. The stream errors when
 * `signal` aborts, exactly as undici wires a fetch's signal to its body, so a
 * deadline that covers the body settles the call and one that was already
 * disarmed leaves it pending forever.
 *
 * `signal` is deliberately optional: a call site that passed **no** signal at
 * all had nothing that could ever interrupt the drain, and a helper that
 * errored the stream anyway would report such a call as bounded.
 */
export function stallingBodyResponse(
  signal: AbortSignal | null | undefined,
  headers: Record<string, string> = { "content-type": "text/html" },
): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("<html>"));
      if (!signal) return;
      const abort = () => controller.error(new DOMException("aborted", "AbortError"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    },
  });
  return new Response(stream, { status: 200, headers });
}

/**
 * A stream that yields `chunkCount` one-megabyte chunks lazily, counting how
 * many were pulled and whether the consumer cancelled. A capped read stops
 * pulling; a `res.text()`/`res.json()` read takes every chunk on offer.
 */
export function countingStream(chunkCount: number) {
  const state = { pulls: 0, cancelled: false };
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream({
    pull(controller) {
      if (state.pulls >= chunkCount) {
        controller.close();
        return;
      }
      state.pulls += 1;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

/**
 * Drive `promise` past `ms` of *fake* time and report whether it settled.
 *
 * Fake timers are what make a 30s production deadline testable in
 * milliseconds; without the fix under test the call has no live timer left, so
 * advancing the clock changes nothing and this answers "HUNG".
 *
 * The caller owns `vi.useFakeTimers()`/`vi.useRealTimers()`, since the mocked
 * `fetch` usually has to be installed first.
 */
export async function settledAfterFakeTime(
  promise: Promise<unknown>,
  ms: number,
  advance: (ms: number) => Promise<unknown>,
): Promise<"settled" | "HUNG"> {
  let settled = false;
  const observe = promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await advance(ms + 1000);
  await Promise.race([observe, Promise.resolve()]);
  return settled ? "settled" : "HUNG";
}
