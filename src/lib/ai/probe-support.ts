import { logUnreachable, type ProbeResult } from "@/lib/integrations/probe";

/**
 * The two things every AI probe does identically, written once.
 *
 * **Why here and not in `@/lib/integrations/probe`.** That module is phase 6's
 * shared *shape* -- `ProbeResult`, `PROBE_TIMEOUT_MS`, `logUnreachable()` -- and
 * this task does not reshape it. Moving these two helpers there would only be
 * worth it alongside converting `youtube.ts` and `reddit.ts` to use them, which
 * is a phase-6 refactor rather than part of adding three providers. Three
 * copies of a five-line catch block is exactly the drift `define.ts` exists to
 * prevent, so they are shared across the three *new* probes at least.
 */

/**
 * The tail of every probe's `catch`: a timeout, or nothing came back at all.
 *
 * `unreachableDetail` **must be a string literal at the call site.** It is a
 * parameter only so the sentence can name the provider; nothing derived from a
 * response, an error or a credential may ever be passed here. `detail` is a
 * log line and the no-echo rule (see `ProbeResult`) is what keeps a provider
 * from replaying a submitted key back into it.
 *
 * The timeout arm is checked by `error.name`, which is what
 * `AbortSignal.timeout()` really rejects with (`DOMException("TimeoutError")`);
 * everything else is a transport failure, and the platform's error *code* --
 * the one thing that separates "the provider is down" from "this server's
 * egress is broken" -- goes to the log through `logUnreachable()` rather than
 * into the result.
 */
export function transportFailure(
  provider: string,
  error: unknown,
  unreachableDetail: string,
): ProbeResult {
  if (error instanceof Error && error.name === "TimeoutError") {
    return { ok: false, cause: "timeout", detail: "The request timed out." };
  }
  logUnreachable(provider, error);
  return { ok: false, cause: "network", detail: unreachableDetail };
}

/**
 * A response body, or `null` when it was not JSON.
 *
 * Typed `unknown` on purpose: every read of it has to narrow, which is what
 * stops a probe from reaching into a shape a hostile or merely broken
 * intermediary never sent. A rejected `.json()` (an HTML block page, an empty
 * body, a truncated stream) is data, not a failure -- swallowing it here is
 * what lets the classification below stay inside the caller's `try` without a
 * parse error being reported as a network fault.
 */
export async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}
