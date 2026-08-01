/**
 * The shared shape a credential probe reports, and the timeout every probe
 * uses.
 *
 * Defined once here rather than in `youtube.ts` -- the Reddit probe importing
 * it from a sibling provider's module would be an arbitrary dependency, and
 * phase 7 adds three more providers that report the same way.
 *
 * `detail` is a server-side log line, never a user-facing string: this
 * project routes every result a UI renders through a catalog `errorKey`, and
 * a provider response body can carry back exactly the secret a caller just
 * submitted. `detail` must therefore be built from string constants only --
 * never interpolate a response body, an error message, or a credential into
 * it. Interpolating a status *number* is fine.
 */
export type ProbeResult =
  | { ok: true; detail: string }
  | {
      ok: false;
      cause: "unauthorized" | "quota" | "network" | "timeout" | "unexpected";
      detail: string;
    };

/** Every probe aborts after this long rather than hanging on a slow provider. */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * The platform's own name for why a `fetch` never got an answer.
 *
 * `undici` wraps a transport failure as `TypeError: fetch failed` with the real
 * cause attached, and only that cause carries the code an operator needs:
 * `ENOTFOUND` (DNS), `ECONNREFUSED` (a proxy that is not listening),
 * `CERT_HAS_EXPIRED` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (a TLS-inspecting
 * middlebox), `ETIMEDOUT`. Without it, every one of those is the same
 * "Could not reach the API." line and there is nothing to act on.
 *
 * **Only `.code` is read, never the message.** A code is a Node constant; a
 * message can carry a hostname or, on some paths, the request URL -- which for
 * the YouTube probe has the API key in its query string.
 */
function transportCode(error: unknown): string | undefined {
  const cause =
    error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

/**
 * Log why a probe could not reach a provider at all.
 *
 * **This is a log line and it stays one.** `ProbeResult.detail` is built from
 * constants (see above) and nothing may be added to the result for a caller to
 * render, so the one diagnostic that distinguishes "the provider is down" from
 * "this server's egress is broken" is written here instead. A platform error
 * code is not provider-controlled content, so logging it does not reopen the
 * no-echo rule -- but it must not travel any further than this call.
 */
export function logUnreachable(provider: string, error: unknown): void {
  const code = transportCode(error);
  console.warn(
    `[integrations] ${provider} probe could not reach the provider` +
      (code ? ` (${code})` : " (no platform error code)"),
  );
}
