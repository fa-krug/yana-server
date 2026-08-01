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
