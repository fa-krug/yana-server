import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import en from "../../../messages/en.json";

import { attempt } from "./result";

/**
 * **A `.tsx` test for a module with no JSX in it, deliberately.** The file
 * extension is what picks the vitest project (see CLAUDE.md), and `attempt()`
 * is browser code: it reads `window.location` and probes the session with
 * `fetch`. In the `node` project neither exists, so this belongs in `jsdom` --
 * it was a `.ts` file only while the catch branch happened to touch neither.
 */
const { replaceLocation } = vi.hoisted(() => ({ replaceLocation: vi.fn() }));
vi.mock("@/lib/browser-location", () => ({ replaceLocation }));

/** Answer the `/api/auth/get-session` probe the way a browser would. */
function respondWithSession(session: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(JSON.stringify(session), { status: 200 }))),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // The default for every test that is not *about* the probe: the session is
  // fine, so the failure is an ordinary one.
  respondWithSession({ user: { id: "someone" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * `attempt()` is the guard between a Server Action that fails *without
 * returning* and the (app) group's error boundary. Reproduced live before it
 * existed: an over-sized upload rejected the action, React escalated, and the
 * whole `/account` page became "Something went wrong" with the user's typed
 * form gone. Every action call site goes through this.
 */
describe("attempt", () => {
  it("passes a real result straight through", async () => {
    expect(await attempt(async () => ({ ok: true }))).toEqual({ ok: true });
    expect(await attempt(async () => ({ ok: false, errorKey: "profile.emailTaken" }))).toEqual({
      ok: false,
      errorKey: "profile.emailTaken",
    });
    // And it does not go asking about the session on the happy path.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("turns a rejection into a failed result instead of letting it escape", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The shape Next produces when a body exceeds `serverActions.bodySizeLimit`.
      const result = await attempt(async () => {
        throw new Error("Body exceeded 2304kb limit");
      });

      expect(result).toEqual({ ok: false, errorKey: "requestFailed" });
    } finally {
      logged.mockRestore();
    }
  });

  it("does not put the thrown reason in the result", async () => {
    // A framework or platform error is untranslated English and nothing a user
    // can act on. It goes to the console; the catalog key goes to the toast.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await attempt(async () => {
        throw new Error("TypeError: fetch failed");
      });

      expect(JSON.stringify(result)).not.toContain("fetch failed");
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("reports a key the catalogs actually define, distinct from saveFailed", async () => {
    // "the server said no" and "the server never answered" want different
    // advice, and only the second is worth retrying unchanged.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { errorKey } = await attempt(async () => {
        throw new Error("gone");
      });

      expect(errorKey).toBe("requestFailed");
      expect(en.account.requestFailed).toBeTypeOf("string");
      expect(en.account.requestFailed).not.toBe(en.account.saveFailed);
    } finally {
      logged.mockRestore();
    }
  });

  /**
   * **Next rejects the action promise with its own control-flow errors on
   * purpose** (`server-action-reducer.js`), so a `redirect()` from inside an
   * action arrives here as a rejection. Caught and translated, it became a
   * stray "the server did not answer" toast riding out on a navigation that
   * was working perfectly. `unstable_rethrow` is the documented way to let
   * those through -- and it is the prerequisite for the signed-out redirect
   * below, which must not be swallowed by the handler that issues it.
   */
  it("lets Next's own redirect out rather than reporting it as a failure", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(attempt(async () => redirect("/somewhere"))).rejects.toThrow();
      // Not logged, not translated, not turned into a result.
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  /**
   * **The session-ended dead end.** The proxy answers a cookie-less action POST
   * with a 307 to /login, the browser follows it, the client gets HTML instead
   * of an RSC payload and throws. Translated as "the server did not answer",
   * that left the user on a signed-out /account with Save re-toasting forever
   * and no hint that reloading was the way out -- and a sign-out button puts
   * that path within one click of every window.
   */
  it("sends a signed-out caller to the login page instead of blaming the network", async () => {
    // What Better Auth answers when there is no session: 200, JSON `null`.
    respondWithSession(null);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await attempt(async () => {
        throw new Error("Failed to parse the response as an RSC payload");
      });

      expect(result).toEqual({ ok: false, errorKey: "sessionEnded" });
      // A full document navigation carrying where to come back to -- the same
      // treatment sign-in and sign-out get, for the same reason: identity
      // changed and the root layout owns the locale.
      expect(replaceLocation).toHaveBeenCalledWith(
        `/login?next=${encodeURIComponent(window.location.pathname)}`,
      );
      // A distinct message, not the network one.
      expect(en.account.sessionEnded).not.toBe(en.account.requestFailed);
    } finally {
      logged.mockRestore();
    }
  });

  it("still blames the network when the session probe cannot be answered", async () => {
    // The server really is unreachable: "you are signed out" would be a guess,
    // and the navigation to /login would fail the same way.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await attempt(async () => {
        throw new Error("dropped");
      });

      expect(result).toEqual({ ok: false, errorKey: "requestFailed" });
      expect(replaceLocation).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("does not navigate away when the session is still good", async () => {
    // The control. Without it, a probe that answered "signed out" for every
    // failure would satisfy the test above and throw every user out of the
    // application on any transient error.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await attempt(async () => {
        throw new Error("Body exceeded 2304kb limit");
      });

      expect(result).toEqual({ ok: false, errorKey: "requestFailed" });
      expect(replaceLocation).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
