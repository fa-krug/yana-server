import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import en from "../../messages/en.json";

import { attempt as usersAttempt } from "./users/result";

import { attemptCall } from "./attempt";

/**
 * **A `.tsx` test for a module with no JSX in it, deliberately.** The file
 * extension is what picks the vitest project (see CLAUDE.md), and this is
 * browser code: it reads `window.location` and probes the session with `fetch`.
 * In the `node` project neither exists, so it belongs in `jsdom`.
 *
 * `next/navigation` is *not* mocked here: `unstable_rethrow` is a predicate
 * over Next's own control-flow errors, and the one test that depends on it
 * would prove the opposite of what it claims against a stub.
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
  // The default for every test that is not *about* the probe.
  respondWithSession({ user: { id: "someone" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * `attemptCall()` is the core every client component in this repository puts in
 * front of a server action: the account and users bindings are built on it, and
 * the CRUD kit's two backstops call it directly. `src/lib/account/result.test.tsx`
 * covers the account binding end to end; this file covers the core's own
 * branches, including the two the account tests cannot reach -- a caller that
 * declines the session probe, and a probe answered with an HTTP error.
 */
describe("attemptCall", () => {
  it("hands back what the call returned, without asking about the session", async () => {
    const attempted = await attemptCall(async () => ({ ok: true, id: "u1" }), { label: "x" });

    expect(attempted).toEqual({ status: "returned", result: { ok: true, id: "u1" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("turns a rejection into a value instead of letting it escape", async () => {
    // Unhandled inside a `useTransition` scope this escalates to the nearest
    // error boundary -- on /account, the whole page and the half-typed form.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const attempted = await attemptCall(
        async () => {
          throw new Error("Body exceeded 2304kb limit");
        },
        { label: "the label the caller chose" },
      );

      expect(attempted).toEqual({ status: "rejected", sessionEnded: false });
      expect(logged).toHaveBeenCalledWith("the label the caller chose", expect.any(Error));
      expect(replaceLocation).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  /**
   * **Next rejects the action promise with its own control-flow errors on
   * purpose** (`server-action-reducer.js`), so a `redirect()` from inside an
   * action arrives here as a rejection. Caught and translated, it became a
   * stray "the server did not answer" toast riding out on a navigation that was
   * working perfectly.
   */
  it("lets Next's own redirect out rather than reporting it as a failure", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        attemptCall(async () => redirect("/somewhere"), { label: "x" }),
      ).rejects.toThrow();
      // Not logged, not probed, not turned into a value.
      expect(logged).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  /**
   * **The session-ended dead end.** The proxy answers a cookie-less action POST
   * with a 307 to /login, the browser follows it, the client gets HTML instead
   * of an RSC payload and throws -- indistinguishable from a dropped
   * connection, which is what the user used to be told while sitting on a
   * signed-out page.
   */
  it("reports a session that ended, and sends the browser to /login", async () => {
    // What Better Auth answers when there is no session: 200, JSON `null`.
    respondWithSession(null);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const attempted = await attemptCall(
        async () => {
          throw new Error("Failed to parse the response as an RSC payload");
        },
        { label: "x" },
      );

      expect(attempted).toEqual({ status: "rejected", sessionEnded: true });
      // A full document navigation carrying where to come back to: identity
      // changed, and the root layout owns the locale and the theme.
      expect(replaceLocation).toHaveBeenCalledWith(
        `/login?next=${encodeURIComponent(window.location.pathname)}`,
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("blames the network when the probe itself cannot be answered", async () => {
    // The server really is unreachable: "you are signed out" would be a guess,
    // and the navigation to /login would fail the same way.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const attempted = await attemptCall(
        async () => {
          throw new Error("dropped");
        },
        { label: "x" },
      );

      expect(attempted).toEqual({ status: "rejected", sessionEnded: false });
      expect(replaceLocation).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("blames the network when the probe answers with an error status", async () => {
    // A 502 from a reverse proxy in front of a restarting container is not an
    // answer to "are you signed out?", and reading it as one would throw a
    // signed-in user out of the application mid-restart. The body is a valid
    // JSON `null` on purpose: that is exactly what "no session" looks like, so
    // deleting the status check would make this navigate away.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(null), { status: 502 }))),
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const attempted = await attemptCall(
        async () => {
          throw new Error("dropped");
        },
        { label: "x" },
      );

      expect(attempted).toEqual({ status: "rejected", sessionEnded: false });
      expect(replaceLocation).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("does not probe at all when the caller declines", async () => {
    // `/login`'s case: a caller with no session is supposed to be there, so
    // asking would point the sign-in page at itself.
    respondWithSession(null);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const attempted = await attemptCall(
        async () => {
          throw new TypeError("fetch failed");
        },
        { label: "x", sessionProbe: "skip" },
      );

      expect(attempted).toEqual({ status: "rejected", sessionEnded: false });
      expect(fetch).not.toHaveBeenCalled();
      expect(replaceLocation).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});

/**
 * The namespace binding. `src/lib/account/result.test.tsx` proves the account
 * one; this proves the *parameterization* -- a second namespace reporting its
 * own catalog's keys through the same core.
 */
describe("attemptIn", () => {
  it("keeps the caller's own result type and fields when the action returns", async () => {
    const result = await usersAttempt(async () => ({ ok: true, deleted: 3 }));

    // `result.deleted` only compiles because the failure arm's `ok` is the
    // literal `false`, so `result.ok` narrows the union back to what the action
    // returned. An action reporting an id or a count must not lose it by being
    // wrapped.
    expect(result.ok ? result.deleted : -1).toBe(3);
  });

  it("reports the users catalog's own keys, not the account catalog's", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = await usersAttempt(async () => {
        throw new Error("dropped");
      });
      expect(failed).toEqual({ ok: false, errorKey: "requestFailed" });

      respondWithSession(null);
      const signedOut = await usersAttempt(async () => {
        throw new Error("Failed to parse the response as an RSC payload");
      });
      expect(signedOut).toEqual({ ok: false, errorKey: "sessionEnded" });

      // Keys the catalog really defines, and distinct from "the server said no".
      expect(en.users.requestFailed).toBeTypeOf("string");
      expect(en.users.sessionEnded).not.toBe(en.users.requestFailed);
      expect(en.users.requestFailed).not.toBe(en.users.saveFailed);
    } finally {
      logged.mockRestore();
    }
  });
});
