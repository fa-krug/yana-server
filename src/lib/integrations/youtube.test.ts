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

  it("also reads quota off the newer google.rpc status, not only the legacy reason", async () => {
    // The envelope a live 403 carries today has both (`errors[0].reason` and
    // `error.status`), and only the first is documented. If a future response
    // drops `reason`, reading the status alone is what keeps a spent daily budget
    // from being classified as a rejected key -- which `actions.ts` would then
    // store with the integration switched off, telling an operator to check a key
    // that was never the problem.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 403, status: "RESOURCE_EXHAUSTED" } }), {
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

  it("reports success on 200, even with no items in the body", async () => {
    // **The asymmetry with the Reddit probe, pinned.** `forHandle=@youtube`
    // answers 200 with an empty `items` array whenever the handle does not
    // resolve, so a *working* key legitimately produces this body -- which is why
    // this probe judges the status and Reddit's (whose token endpoint has no
    // empty-but-valid answer) requires a field. Requiring one here would report
    // every good key as broken.
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
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await testYoutubeKey("good");
    expect(result).toMatchObject({ ok: false, cause: "network" });
    expect(warned).toHaveBeenCalled();
  });

  /**
   * The one diagnostic that separates "the provider is down" from "this server's
   * egress is broken", and where it is allowed to go.
   *
   * `detail` is a constant by rule, so `ENOTFOUND`/`ECONNREFUSED`/
   * `CERT_HAS_EXPIRED` -- the only thing an operator behind a broken proxy has to
   * work with -- is logged instead of returned. A platform error code is not
   * provider-controlled content, so this is not the no-echo rule reopening; the
   * *message* is never read, because on some paths it carries the request URL,
   * which for this probe has the API key in its query string.
   */
  it("logs the platform's error code, and keeps it out of the result", async () => {
    const failure = new TypeError("fetch failed");
    failure.cause = Object.assign(new Error("getaddrinfo ENOTFOUND www.googleapis.com"), {
      code: "ENOTFOUND",
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await testYoutubeKey("SECRET123");

    expect(warned).toHaveBeenCalledWith(expect.stringContaining("ENOTFOUND"));
    expect(JSON.stringify(result)).not.toContain("ENOTFOUND");
    expect(JSON.stringify(result)).not.toContain("SECRET123");
    // The message is never logged either -- only `.code`.
    expect(warned).not.toHaveBeenCalledWith(expect.stringContaining("getaddrinfo"));
  });
});
