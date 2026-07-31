import { describe, expect, it, vi } from "vitest";

import en from "../../../messages/en.json";

import { attempt } from "./result";

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
});
