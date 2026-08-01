import { afterEach, describe, expect, it, vi } from "vitest";

import { testYoutubeKey } from "./youtube";

afterEach(() => vi.restoreAllMocks());

describe("testYoutubeKey", () => {
  it("classifies a 403 as unauthorized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "API key not valid" } }), {
          status: 403,
        }),
      ),
    );
    const result = await testYoutubeKey("bad");
    expect(result).toMatchObject({ ok: false, cause: "unauthorized" });
  });

  it("classifies quota exhaustion separately from a bad key", async () => {
    // Same 403 status, different reason -- and the operator's next action differs.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }), {
          status: 403,
        }),
      ),
    );
    expect(await testYoutubeKey("ok")).toMatchObject({ ok: false, cause: "quota" });
  });

  it("never echoes the submitted key back in the detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Key SECRET123 invalid" } }), {
          status: 400,
        }),
      ),
    );
    const result = await testYoutubeKey("SECRET123");
    expect(JSON.stringify(result)).not.toContain("SECRET123");
  });

  it("reports success on 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 })),
    );
    expect((await testYoutubeKey("good")).ok).toBe(true);
  });

  it("classifies a timeout as timeout", async () => {
    // The same shape AbortSignal.timeout() actually rejects with, so this
    // genuinely exercises the `error.name === "TimeoutError"` branch rather
    // than a name property attached to an unrelated error.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError")),
    );
    const result = await testYoutubeKey("good");
    expect(result).toMatchObject({ ok: false, cause: "timeout" });
  });

  it("classifies any other rejection as network", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
    const result = await testYoutubeKey("good");
    expect(result).toMatchObject({ ok: false, cause: "network" });
  });
});
