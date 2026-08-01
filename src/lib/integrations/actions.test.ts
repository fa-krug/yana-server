import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";
import { KEEP_EXISTING } from "@/lib/secrets";

import en from "../../../messages/en.json";

import type { SaveResult } from "./result";

/**
 * Real-database tests for the integrations actions, in the style of
 * `src/lib/settings/settings.test.ts` and `src/lib/account/account.test.ts`: a
 * temp SQLite file per test, migrated through the same `applyMigrations()` the
 * container runs at startup, with the caller signed in for real. **No driver
 * mocks** -- every assertion about what was stored reads the row back over a
 * separate connection.
 *
 * Three things are stubbed, and none of them is data:
 *
 * - `next/cache`'s `revalidatePath()`, which throws outside a request scope.
 * - `next/headers`, the request scope the session read needs. Built from
 *   `nextHeadersStub()`, which exports `cookies` as well as `headers` --
 *   mandatory, see CLAUDE.md's `nextCookies()` rule.
 * - **`fetch`**, so no test reaches the real YouTube or Reddit API. That is the
 *   one seam these tests cannot leave real: the probes are deliberately live
 *   calls, and a suite that made them would be slow, flaky, and would need
 *   credentials nobody has in CI. `src/lib/integrations/youtube.test.ts` and
 *   `reddit.test.ts` (task 2) cover the classification of each provider's real
 *   response shapes; what is proved here is what the *actions* do with a
 *   verdict.
 */
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));
vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders),
);

/** A request a probe made, as the fake `fetch` saw it. */
type Recorded = { url: string; init: RequestInit | undefined };

const YOUTUBE_KEY = "AIzaSyREALLOOKINGYOUTUBEKEY0001";
const REDDIT_ID = "redditClientId0001";
const REDDIT_SECRET = "redditClientSecret00000001";

describe("the integrations actions", () => {
  let dbPath: string;
  let userId: string;
  let actions: typeof import("./actions");
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let requests: Recorded[];

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  /** Read the row back over a connection of its own -- never through the code under test. */
  function row(): Record<string, unknown> {
    const connection = new Database(dbPath);
    try {
      return connection
        .prepare("SELECT * FROM user_settings WHERE user_id = ?")
        .get(userId) as Record<string, unknown>;
    } finally {
      connection.close();
    }
  }

  function seed(values: Partial<typeof schema.userSettings.$inferInsert>): void {
    client.writeTransaction((tx) =>
      tx
        .update(schema.userSettings)
        .set(values)
        .where(eq(schema.userSettings.userId, userId))
        .run(),
    );
  }

  /**
   * Answer every probe request with `handler`, recording what it was asked.
   *
   * A handler may throw, which is how a network failure and a timeout are
   * simulated -- `AbortSignal.timeout()` rejects with an error named
   * `TimeoutError`, and that name is what the probes classify on.
   */
  function stubFetch(handler: (recorded: Recorded) => Response): void {
    vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
      const recorded = { url: String(input), init };
      requests.push(recorded);
      return Promise.resolve(handler(recorded));
    });
  }

  /** The API key a recorded YouTube request actually carried. */
  function youtubeKeyOf(recorded: Recorded): string | null {
    return new URL(recorded.url).searchParams.get("key");
  }

  /** The `clientId:clientSecret` pair a recorded Reddit request actually carried. */
  function basicAuthOf(recorded: Recorded): string {
    const header = new Headers(recorded.init?.headers).get("authorization") ?? "";
    return Buffer.from(header.replace(/^Basic /, ""), "base64").toString("utf8");
  }

  const youtubeOk = () => new Response(JSON.stringify({ items: [] }), { status: 200 });
  const youtubeRejected = () =>
    new Response(JSON.stringify({ error: { errors: [{ reason: "badRequest" }] } }), {
      status: 400,
    });
  const youtubeQuota = () =>
    new Response(JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }), {
      status: 403,
    });
  const redditOk = () => new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
  const redditRejected = () => new Response("{}", { status: 401 });
  const redditRateLimited = () => new Response("{}", { status: 429 });

  function networkFailure(): never {
    throw new TypeError("fetch failed");
  }

  function timeout(): never {
    const error = new Error("The operation timed out");
    error.name = "TimeoutError";
    throw error;
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.unstubAllGlobals();
    requests = [];
    // Silenced, not removed: `logProbe()` writes every probe failure here on
    // purpose (it is the only place a `detail` is allowed to go), and one test
    // below asserts on it.
    //
    // `console.error` is deliberately **not** silenced here. It used to be, for
    // the whole file, which meant a `persist()` that started failing or a
    // `logMissingRow()` that stopped firing would have produced no signal at all
    // -- the two things this module logs as errors are exactly the two nobody
    // would notice. A test that expects one silences it itself, as
    // `youtube-section.test.tsx` does.
    vi.spyOn(console, "warn").mockImplementation(() => {});

    dbPath = path.join(
      os.tmpdir(),
      `yana-integrations-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    // Set before the auth module is imported: Better Auth reads it while
    // building its context.
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    const bootstrap = await import("@/lib/auth/bootstrap");
    await bootstrap.ensureAdminExists();

    const { auth } = await import("@/lib/auth/server");
    requestHeaders.current = new Headers({
      cookie: await signInCookie(auth, { email: "admin@admin.com", password: "admin" }),
    });

    actions = await import("./actions");
    client = await import("@/lib/db/client");
    // Same module epoch as `client` (no resetModules() in between), so this is
    // the table object the singleton connection actually knows.
    schema = await import("@/lib/db/schema");

    const connection = new Database(dbPath);
    try {
      userId = (
        connection.prepare("SELECT id FROM users WHERE email = ?").get("admin@admin.com") as {
          id: string;
        }
      ).id;
    } finally {
      connection.close();
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  /**
   * Resolve a key an action emitted against the real `en.json`.
   *
   * `src/i18n/messages.test.ts` only compares the two catalogs to each other; it
   * cannot know that an action emits a key neither defines, which would render
   * the raw dotted path into a toast. Same guard `settings.test.ts` and
   * `account.test.ts` use.
   */
  function integrationsMessage(key: string | undefined): unknown {
    if (!key) return undefined;
    return key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        en.integrations,
      );
  }

  /**
   * The English message a *failed* result points at.
   *
   * Reads the key off the result rather than taking it as a literal, so the
   * assertion covers whatever the action actually emitted -- and returns
   * `undefined` for a successful one, which makes a `toBeTypeOf("string")` also
   * prove that the action failed. `SaveResult` is a discriminated union, so the
   * narrowing is the type system's, not this helper's opinion.
   */
  function failureMessage(result: SaveResult): unknown {
    return result.ok ? undefined : integrationsMessage(result.errorKey);
  }

  /** {@link failureMessage}'s twin for the succeeded-with-a-caveat arm. */
  function noticeMessage(result: SaveResult): unknown {
    return result.ok ? integrationsMessage(result.noticeKey) : undefined;
  }

  describe("saveYoutube", () => {
    it("stores the key and switches the integration on when the probe passes", async () => {
      stubFetch(youtubeOk);

      const result = await actions.saveYoutube({ apiKey: YOUTUBE_KEY });

      expect(result).toEqual({ ok: true });
      expect(row()).toMatchObject({ youtube_api_key: YOUTUBE_KEY, youtube_enabled: 1 });
      // The probe really was given the submitted key, not a placeholder.
      expect(requests[0].url).toContain(YOUTUBE_KEY);
    });

    it("keeps the stored key when the field was left untouched", async () => {
      // The property this whole task turns on: a saved secret never reaches the
      // browser, so an unchanged field cannot round-trip it -- it submits the
      // sentinel instead, and the stored value has to come back out of the
      // database. Asserted against the row, not the UI.
      //
      // It is also the end-to-end proof that the sentinel survives the schema's
      // `.trim()`: a NUL byte is not JS whitespace, so an untouched field still
      // means keep-existing rather than "wipe it" (`secrets.test.ts` pins the
      // property itself).
      stubFetch(youtubeOk);
      seed({ youtubeApiKey: YOUTUBE_KEY, youtubeEnabled: true });

      const result = await actions.saveYoutube({ apiKey: KEEP_EXISTING });

      expect(result).toEqual({ ok: true });
      expect(row()).toMatchObject({ youtube_api_key: YOUTUBE_KEY, youtube_enabled: 1 });
      // And the probe was run against the *stored* key, so "keep existing" is
      // still verified rather than assumed.
      expect(requests[0].url).toContain(YOUTUBE_KEY);
    });

    it("treats an empty field as keep-existing too", async () => {
      // A browser that sends "" (an untouched field, if a caller ever stops
      // spelling the sentinel) must not wipe the stored key.
      stubFetch(youtubeOk);
      seed({ youtubeApiKey: YOUTUBE_KEY, youtubeEnabled: true });

      expect(await actions.saveYoutube({ apiKey: "" })).toEqual({ ok: true });
      expect(row()).toMatchObject({ youtube_api_key: YOUTUBE_KEY });
    });

    /**
     * **The paste artifact that used to destroy a working key.**
     *
     * A key copied out of the Google Cloud console arrives with a trailing
     * newline. Untrimmed it went out as `key=AIza…%0A`, came back 403, classified
     * `unauthorized` -- and an `unauthorized` save *stores what was submitted*
     * (the human ruling behind `judge()`), so the mangled value replaced the good
     * one in a column this UI can never read back, over a toast telling the
     * operator to go and check a key that was correct.
     *
     * The two halves are asserted together on purpose: the probe has to receive
     * the trimmed key *and* the row has to end up holding it. Trimming after the
     * probe would fix the toast and still store rubbish.
     */
    it("trims the submitted key before probing and before storing it", async () => {
      stubFetch(youtubeOk);
      seed({ youtubeApiKey: YOUTUBE_KEY, youtubeEnabled: true });

      const result = await actions.saveYoutube({ apiKey: `  ${YOUTUBE_KEY}\n` });

      expect(result).toEqual({ ok: true });
      expect(youtubeKeyOf(requests[0])).toBe(YOUTUBE_KEY);
      expect(row()).toMatchObject({ youtube_api_key: YOUTUBE_KEY, youtube_enabled: 1 });
    });

    it("leaves the integration off and reports a catalog key when the key is rejected", async () => {
      stubFetch(youtubeRejected);

      const result = await actions.saveYoutube({ apiKey: "not-a-key" });

      expect(result).toEqual({ ok: false, errorKey: "youtube.rejected" });
      expect(failureMessage(result)).toBeTypeOf("string");
      // Stored, but off: the badge then disagrees with nothing, and an
      // enabled-but-broken integration cannot happen.
      expect(row()).toMatchObject({ youtube_api_key: "not-a-key", youtube_enabled: 0 });
    });

    it("counts a quota answer as working, and reports it as a notice rather than a failure", async () => {
      // A quota answer means the key is valid and only today's budget is gone.
      // Reporting `ok: false` over a row that was written *and enabled* would
      // send an operator back to re-save something that already worked.
      stubFetch(youtubeQuota);

      const result = await actions.saveYoutube({ apiKey: YOUTUBE_KEY });

      expect(result).toEqual({ ok: true, noticeKey: "youtube.quota" });
      expect(noticeMessage(result)).toBeTypeOf("string");
      expect(row()).toMatchObject({ youtube_api_key: YOUTUBE_KEY, youtube_enabled: 1 });
    });

    it("changes nothing when the provider could not be reached", async () => {
      // "The answer is no" and "there was no answer" are different. With no
      // answer there is nothing to derive the flag from, so a momentary outage
      // must not disable a working integration -- nor store an untested key
      // under a flag that still says the old one worked.
      seed({ youtubeApiKey: YOUTUBE_KEY, youtubeEnabled: true });
      stubFetch(networkFailure);

      const result = await actions.saveYoutube({ apiKey: "a-different-key" });

      expect(result).toEqual({ ok: false, errorKey: "unreachable" });
      expect(failureMessage(result)).toBeTypeOf("string");
      expect(row()).toMatchObject({ youtube_api_key: YOUTUBE_KEY, youtube_enabled: 1 });
    });

    it("changes nothing when the provider timed out", async () => {
      seed({ youtubeApiKey: YOUTUBE_KEY, youtubeEnabled: true });
      stubFetch(timeout);

      expect(await actions.saveYoutube({ apiKey: "a-different-key" })).toEqual({
        ok: false,
        errorKey: "timedOut",
      });
      expect(row()).toMatchObject({ youtube_api_key: YOUTUBE_KEY, youtube_enabled: 1 });
    });

    it("refuses when nothing is submitted and nothing is stored", async () => {
      stubFetch(youtubeOk);

      const result = await actions.saveYoutube({ apiKey: KEEP_EXISTING });

      expect(result).toEqual({ ok: false, errorKey: "youtube.required" });
      expect(failureMessage(result)).toBeTypeOf("string");
      // Probing "" would come back "rejected" and blame a key nobody entered.
      expect(requests).toEqual([]);
    });

    it("logs the provider's detail and never returns it", async () => {
      // `ProbeResult.detail` is English prose for a log line, and a provider
      // body can echo back the credential just submitted. It must not be in the
      // result at all.
      stubFetch(youtubeRejected);

      const result = await actions.saveYoutube({ apiKey: YOUTUBE_KEY });

      expect(JSON.stringify(result)).not.toContain("rejected.");
      expect(Object.keys(result).sort()).toEqual(["errorKey", "ok"]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining("The API key was rejected"),
      );
    });
  });

  describe("saveReddit", () => {
    it("stores both secrets and the user agent, and switches the integration on", async () => {
      stubFetch(redditOk);

      const result = await actions.saveReddit({
        clientId: REDDIT_ID,
        clientSecret: REDDIT_SECRET,
        userAgent: "Yana/1.0 (by u/tester)",
      });

      expect(result).toEqual({ ok: true });
      expect(row()).toMatchObject({
        reddit_client_id: REDDIT_ID,
        reddit_client_secret: REDDIT_SECRET,
        reddit_user_agent: "Yana/1.0 (by u/tester)",
        reddit_enabled: 1,
      });
    });

    it("keeps each stored secret independently of the other", async () => {
      // Rotating only the secret must not require re-typing the client id, and
      // the probe has to run against the pair that will be stored.
      stubFetch(redditOk);
      seed({ redditClientId: REDDIT_ID, redditClientSecret: REDDIT_SECRET, redditEnabled: true });

      const result = await actions.saveReddit({
        clientId: KEEP_EXISTING,
        clientSecret: "a-rotated-secret",
        userAgent: "Yana/1.0 (by u/tester)",
      });

      expect(result).toEqual({ ok: true });
      expect(row()).toMatchObject({
        reddit_client_id: REDDIT_ID,
        reddit_client_secret: "a-rotated-secret",
        reddit_enabled: 1,
      });
      expect(basicAuthOf(requests[0])).toBe(`${REDDIT_ID}:a-rotated-secret`);
    });

    it("requires a user agent, and does not ask Reddit about a blank one", async () => {
      // The probe refuses a blank User-Agent as `unauthorized`, which would read
      // as "Reddit rejected those credentials" and send an operator hunting
      // through a client id that was fine.
      stubFetch(redditOk);

      const result = await actions.saveReddit({
        clientId: REDDIT_ID,
        clientSecret: REDDIT_SECRET,
        userAgent: "   ",
      });

      expect(result).toEqual({ ok: false, errorKey: "reddit.userAgentRequired" });
      expect(failureMessage(result)).toBeTypeOf("string");
      expect(requests).toEqual([]);
      expect(row()).toMatchObject({ reddit_client_id: "", reddit_enabled: 0 });
    });

    it("refuses when a secret is neither submitted nor stored", async () => {
      stubFetch(redditOk);

      const result = await actions.saveReddit({
        clientId: REDDIT_ID,
        clientSecret: KEEP_EXISTING,
        userAgent: "Yana/1.0",
      });

      expect(result).toEqual({ ok: false, errorKey: "reddit.required" });
      expect(requests).toEqual([]);
    });

    it("reports a rejection as a Reddit-specific catalog key", async () => {
      stubFetch(redditRejected);

      const result = await actions.saveReddit({
        clientId: REDDIT_ID,
        clientSecret: "wrong",
        userAgent: "Yana/1.0",
      });

      expect(result).toEqual({ ok: false, errorKey: "reddit.rejected" });
      expect(failureMessage(result)).toBeTypeOf("string");
      expect(row()).toMatchObject({ reddit_enabled: 0 });
    });

    /**
     * **Reddit's 429 is not a pass, and this is the assertion that says so.**
     *
     * It used to be: the row was written and `reddit_enabled` set to 1 on the
     * strength of a rate-limit answer, with a toast reading "the credentials are
     * valid". They need not be -- a 429 from `/api/v1/access_token` is IP-level
     * load shedding returned *before* the Basic auth header is looked at, and a
     * self-hosted server on a datacentre range collects them routinely. So a
     * first-ever save of *wrong* credentials from a throttled host enabled them,
     * which is the one thing the probe-derived flag exists to prevent.
     *
     * YouTube's quota answer stays a pass (the test above) because Google
     * validates the key before it accounts for quota. The difference is named
     * once, as `quotaMeansVerified` on each provider's keys, so phase 7 has to
     * answer it per AI provider instead of inheriting YouTube's answer.
     */
    it("treats Reddit's rate limit as no answer at all, and writes nothing", async () => {
      stubFetch(redditRateLimited);

      const result = await actions.saveReddit({
        clientId: REDDIT_ID,
        clientSecret: REDDIT_SECRET,
        userAgent: "Yana/1.0",
      });

      expect(result).toEqual({ ok: false, errorKey: "reddit.rateLimited" });
      expect(failureMessage(result)).toBeTypeOf("string");
      expect(row()).toMatchObject({
        reddit_client_id: "",
        reddit_client_secret: "",
        reddit_enabled: 0,
      });
    });

    it("does not disable a working Reddit integration over a rate limit either", async () => {
      // The other half of "nothing is written": an integration that was on stays
      // on, because a 429 is no more a verdict against the stored credential than
      // it is for the submitted one.
      seed({ redditClientId: REDDIT_ID, redditClientSecret: REDDIT_SECRET, redditEnabled: true });
      stubFetch(redditRateLimited);

      expect(
        await actions.saveReddit({
          clientId: "a-different-id",
          clientSecret: "a-different-secret",
          userAgent: "Yana/1.0",
        }),
      ).toEqual({ ok: false, errorKey: "reddit.rateLimited" });
      expect(row()).toMatchObject({
        reddit_client_id: REDDIT_ID,
        reddit_client_secret: REDDIT_SECRET,
        reddit_enabled: 1,
      });
    });

    it("refuses a user agent that is not a single printable ASCII line", async () => {
      // `.trim()` strips the ends only, so this passed zod and then threw inside
      // fetch's own header validation -- reported as "could not reach the
      // provider", about a request that was never made.
      stubFetch(redditOk);

      const result = await actions.saveReddit({
        clientId: REDDIT_ID,
        clientSecret: REDDIT_SECRET,
        userAgent: "Yana/1.0\nX-Injected: 1",
      });

      expect(result).toEqual({ ok: false, errorKey: "reddit.userAgentInvalid" });
      expect(failureMessage(result)).toBeTypeOf("string");
      expect(requests).toEqual([]);
    });

    it("trims both secrets before probing and before storing them", async () => {
      // Copying a client id or secret out of a browser or a password manager
      // brings a trailing newline with it, and an untrimmed one is a *destroyed*
      // credential: Reddit rejects it, and a rejection stores what was submitted.
      stubFetch(redditOk);

      const result = await actions.saveReddit({
        clientId: `  ${REDDIT_ID}\n`,
        clientSecret: `${REDDIT_SECRET}\r\n`,
        userAgent: "Yana/1.0",
      });

      expect(result).toEqual({ ok: true });
      expect(basicAuthOf(requests[0])).toBe(`${REDDIT_ID}:${REDDIT_SECRET}`);
      expect(row()).toMatchObject({
        reddit_client_id: REDDIT_ID,
        reddit_client_secret: REDDIT_SECRET,
      });
    });
  });

  describe("testYoutube and testReddit", () => {
    it("write nothing at all, which is what makes the button safe to press", async () => {
      stubFetch(youtubeOk);
      seed({ youtubeApiKey: YOUTUBE_KEY, youtubeEnabled: false });

      const result = await actions.testYoutube({ apiKey: "a-candidate-key" });

      expect(result).toEqual({ ok: true });
      expect(requests[0].url).toContain("a-candidate-key");
      // Neither the key nor the flag moved: a test must not replace credentials
      // that currently work.
      expect(row()).toMatchObject({ youtube_api_key: YOUTUBE_KEY, youtube_enabled: 0 });
    });

    it("test the stored credentials when the fields are untouched", async () => {
      stubFetch(redditOk);
      seed({ redditClientId: REDDIT_ID, redditClientSecret: REDDIT_SECRET });

      const result = await actions.testReddit({
        clientId: KEEP_EXISTING,
        clientSecret: KEEP_EXISTING,
        userAgent: "Yana/1.0",
      });

      expect(result).toEqual({ ok: true });
      // What the title claims: the *stored* pair is what Reddit was asked about.
      // Without this the test passes just as happily against two empty strings
      // sent to a stub that answers 200 to anything.
      expect(basicAuthOf(requests[0])).toBe(`${REDDIT_ID}:${REDDIT_SECRET}`);
      expect(row()).toMatchObject({ reddit_enabled: 0 });
    });

    it("report a rejection with the same key a save would", async () => {
      stubFetch(youtubeRejected);

      expect(await actions.testYoutube({ apiKey: "nope" })).toEqual({
        ok: false,
        errorKey: "youtube.rejected",
      });
    });
  });

  describe("a Test and a Save agree on what they probe", () => {
    /**
     * The property the shared `verify*` helpers exist to hold, pinned directly
     * rather than trusted to the extraction.
     *
     * **A Test button that validates something other than what a Save would
     * store is worse than no button**: it reports a green result for a credential
     * the save then replaces with a different one. Every other test here checks
     * one path at a time and would stay green through exactly that divergence --
     * two copies of the resolve rules, one of them updated. These run both entry
     * points on one submission and compare the requests they made.
     */
    it.each([
      ["the keep-existing sentinel", KEEP_EXISTING],
      ["an empty field", ""],
      ["a freshly typed key", "AIza-a-typed-key"],
    ])("resolve the same YouTube key for %s", async (_label, submitted) => {
      stubFetch(youtubeOk);
      seed({ youtubeApiKey: YOUTUBE_KEY });

      await actions.testYoutube({ apiKey: submitted });
      await actions.saveYoutube({ apiKey: submitted });

      expect(requests).toHaveLength(2);
      expect(youtubeKeyOf(requests[0])).toBe(youtubeKeyOf(requests[1]));
      // And the row now holds precisely what the *test* validated -- which is the
      // promise the button makes to an operator about to overwrite a working key.
      expect(row().youtube_api_key).toBe(youtubeKeyOf(requests[0]));
    });

    it("resolve the same Reddit pair whichever field was left alone", async () => {
      stubFetch(redditOk);
      seed({ redditClientId: REDDIT_ID, redditClientSecret: REDDIT_SECRET });
      const submission = {
        clientId: KEEP_EXISTING,
        clientSecret: "a-rotated-secret",
        userAgent: "Yana/1.0 (by u/tester)",
      };

      await actions.testReddit(submission);
      await actions.saveReddit(submission);

      expect(requests).toHaveLength(2);
      expect(basicAuthOf(requests[0])).toBe(basicAuthOf(requests[1]));
      const stored = row();
      expect(basicAuthOf(requests[0])).toBe(
        `${stored.reddit_client_id}:${stored.reddit_client_secret}`,
      );
    });

    it("refuse the same submission for the same reason", async () => {
      // The guards have to agree too, not just the resolution: a Test that
      // accepts what a Save refuses (or the reverse) sends an operator looking
      // for a fault in the credential rather than in the empty field.
      stubFetch(youtubeOk);

      const tested = await actions.testYoutube({ apiKey: KEEP_EXISTING });
      const saved = await actions.saveYoutube({ apiKey: KEEP_EXISTING });

      expect(tested).toEqual({ ok: false, errorKey: "youtube.required" });
      expect(saved).toEqual(tested);
      expect(requests).toEqual([]);
    });
  });

  describe("removeYoutube and removeReddit", () => {
    it("wipe the YouTube key and switch the integration off", async () => {
      seed({ youtubeApiKey: YOUTUBE_KEY, youtubeEnabled: true });

      expect(await actions.removeYoutube()).toEqual({ ok: true });
      expect(row()).toMatchObject({ youtube_api_key: "", youtube_enabled: 0 });
    });

    it("wipe both Reddit secrets but keep the user agent", async () => {
      // The user agent is not a credential, and throwing away a correctly
      // written one is a small cruelty on the way to re-entering the client id.
      seed({
        redditClientId: REDDIT_ID,
        redditClientSecret: REDDIT_SECRET,
        redditUserAgent: "Yana/1.0 (by u/tester)",
        redditEnabled: true,
      });

      expect(await actions.removeReddit()).toEqual({ ok: true });
      expect(row()).toMatchObject({
        reddit_client_id: "",
        reddit_client_secret: "",
        reddit_enabled: 0,
        reddit_user_agent: "Yana/1.0 (by u/tester)",
      });
    });

    it("succeed when there is nothing to remove", async () => {
      expect(await actions.removeYoutube()).toEqual({ ok: true });
      expect(await actions.removeReddit()).toEqual({ ok: true });
    });

    it("touch only the caller's own row", async () => {
      // Credentials are per user. A remove that dropped a WHERE clause would be
      // invisible here without a second account to prove it.
      const { createUserWithPassword } = await import("@/lib/auth/server");
      const other = await createUserWithPassword({
        email: "other@example.com",
        password: "correct horse battery staple",
      });
      // Inserted rather than updated: `createUserWithPassword()` does not
      // provision a settings row -- the admin bootstrap and phase 5's user
      // creation do that themselves.
      client.writeTransaction((tx) =>
        tx
          .insert(schema.userSettings)
          .values({
            userId: other.id,
            youtubeApiKey: "someone-elses-key",
            youtubeEnabled: true,
          })
          .run(),
      );
      seed({ youtubeApiKey: YOUTUBE_KEY, youtubeEnabled: true });

      expect(await actions.removeYoutube()).toEqual({ ok: true });

      const connection = new Database(dbPath);
      try {
        expect(
          connection
            .prepare("SELECT youtube_api_key FROM user_settings WHERE user_id = ?")
            .get(other.id),
        ).toEqual({ youtube_api_key: "someone-elses-key" });
      } finally {
        connection.close();
      }
    });
  });
});
