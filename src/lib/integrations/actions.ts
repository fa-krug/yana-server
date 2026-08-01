"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentUserId } from "@/lib/auth/session";
import { getDb, writeTransaction } from "@/lib/db/client";
import { userSettings } from "@/lib/db/schema";
import { resolveSecret } from "@/lib/secrets";

import type { ProbeResult } from "./probe";
import { testRedditCredentials, type RedditCredentials } from "./reddit";
import type { IntegrationsKey, IntegrationsResult, SaveResult } from "./result";
import { testYoutubeKey } from "./youtube";

/**
 * Everything `/integrations` writes, plus the two credential tests.
 *
 * Five rules hold across every action here.
 *
 * 1. **The identity comes from the session.** No action takes a user id;
 *    `currentUserId()` -> `requireUser()` is the first thing each one does, so
 *    there is nothing to forge and the credentials are per-account.
 * 2. **An unchanged secret is never sent to the browser and never comes back.**
 *    A saved secret leaves the server only as `mask()`ed text (see
 *    `./queries`), so the form cannot round-trip the real value: it submits
 *    `KEEP_EXISTING` (or an empty field, which means the same) and
 *    `resolveSecret()` puts the stored value back before the probe runs.
 * 3. **`ProbeResult.detail` never reaches the caller.** It is English prose
 *    built for a log line, and a provider's body can echo back the very
 *    credential just submitted, so it is logged here and dropped. What crosses
 *    the wire is a catalog key under the `integrations` namespace, typed
 *    `IntegrationsKey` at its source (`./result`) so a key neither catalog
 *    defines fails `npm run typecheck`.
 * 4. **The `*Enabled` flag is derived from a probe, never from the request.**
 *    An enabled-but-broken integration produces empty feeds silently, which is
 *    far harder to diagnose than a save that refuses.
 * 5. **Every write goes through `writeTransaction()` with a synchronous
 *    callback** (CLAUDE.md), which is why the probe happens *before* the
 *    transaction rather than inside it: an `async` callback there would commit
 *    before the awaited HTTP call ever ran, and both `NotPromise<T>` and a
 *    runtime thenable check reject one.
 *
 * A sixth rule belongs to the callers: none of these may be awaited bare from a
 * client component. Every call site goes through `attempt()` in `./result`.
 */

/**
 * Long enough for any real API key or client secret (a YouTube key is 39
 * characters, a Reddit secret 27) and short enough that a bogus submission is
 * refused before it is sent to a provider.
 */
const MAX_SECRET_LENGTH = 512;
const MAX_USER_AGENT_LENGTH = 200;

/**
 * A secret, as submitted.
 *
 * **`.trim()` is load-bearing, not tidiness.** A key is acquired by copying it
 * out of the Google Cloud console or a password manager, and both hand out a
 * trailing newline routinely. Untrimmed, `key=AIza…%0A` comes back 403, which
 * classifies as `unauthorized` -- and an `unauthorized` save **stores what was
 * submitted** and switches the integration off (see `judge()` below and the
 * human ruling behind it). So one invisible character used to destroy a working
 * key that this UI can never show again, while telling the operator to go and
 * check a key that was correct all along.
 *
 * It is safe on the sentinel: `KEEP_EXISTING` starts with a NUL byte, which is
 * not JS whitespace, so `KEEP_EXISTING.trim() === KEEP_EXISTING` and an
 * untouched field still resolves to the stored value. `secrets.test.ts` asserts
 * that rather than leaving it to this comment -- and it has to be true *before*
 * `resolveSecret()` sees the value, which is why the trim lives in the schema.
 */
const secretField = z.string().trim().max(MAX_SECRET_LENGTH);

const youtubeInput = z.object({ apiKey: secretField });

const redditInput = z.object({
  clientId: secretField,
  clientSecret: secretField,
  /**
   * Required, and checked here rather than left to the probe. Reddit throttles a
   * blank or generic User-Agent hard, so `testRedditCredentials()` refuses an
   * empty one before it makes any HTTP call -- but it reports that as
   * `cause: "unauthorized"`, which maps to "Reddit rejected those credentials"
   * and would send an operator hunting through a client id that was fine.
   * `.trim()` runs before `.min(1)`, so " " is empty.
   *
   * **The character class is what keeps a bad value from being reported as a
   * network failure.** This string becomes an HTTP header, and `.trim()` only
   * strips the *ends* -- so `"Yana\nX: 1"` passed zod, and then Node's own
   * header validation threw inside `fetch()`, which the probe's catch classifies
   * as `network`: "Yana could not reach the provider", about a request that was
   * never made. Node rejects any code point above U+00FF for the same reason, so
   * an emoji did it too. Printable ASCII is refused *with a message that says
   * so*; Latin-1 obs-text would technically be legal in a header, and is left
   * out because a User-Agent is an identifier this server sends to a third party
   * and "printable ASCII, one line" is a rule an operator can be told in one
   * sentence.
   */
  userAgent: z
    .string()
    .trim()
    .min(1)
    .max(MAX_USER_AGENT_LENGTH)
    .regex(/^[\x20-\x7E]+$/u),
});

/**
 * Which submitted field failed and how, as a catalog key; anything unlisted
 * falls through to the generic failure.
 *
 * Keyed on `field:code` rather than on the field alone, because one field now
 * fails two ways that want different advice: an empty User-Agent is
 * `too_small` ("a user agent is required") and one with a newline in it is
 * `invalid_format` ("printable ASCII only"). Telling an operator who pasted a
 * two-line string that the field is empty is worse than the generic message.
 * A blank field reports both issues, `too_small` first, so it still lands on
 * the required key.
 */
const REDDIT_FIELD_ERROR_KEYS: Record<string, IntegrationsKey> = {
  "userAgent:too_small": "reddit.userAgentRequired",
  "userAgent:invalid_format": "reddit.userAgentInvalid",
};

function errorKeyFor(
  issues: z.core.$ZodIssue[],
  table: Record<string, IntegrationsKey>,
): IntegrationsKey | undefined {
  const issue = issues[0];
  const field = issue?.path[0];
  return typeof field === "string" ? table[`${field}:${issue.code}`] : undefined;
}

/**
 * What differs per provider: two catalog keys, and one fact about the provider
 * itself. Everything else a probe can report means the same thing whoever
 * answered it.
 */
type ProviderKeys = {
  /** The provider refused the credential. */
  rejected: IntegrationsKey;
  /** The provider answered "too many requests", whichever arm that lands in. */
  quota: IntegrationsKey;
  /**
   * **Does a rate-limit answer prove the credential was accepted?**
   *
   * This is a per-provider fact and it is named here so that adding a provider
   * forces someone to decide it, rather than inheriting YouTube's answer by
   * copying a branch. The two providers already disagree:
   *
   * - **YouTube: `true`.** Google validates the API key *before* it accounts for
   *   quota, so a 403 carrying `quotaExceeded`/`dailyLimitExceeded` (or
   *   `RESOURCE_EXHAUSTED`) is only reachable *with* a key it accepted. The
   *   credential is verified and only today's budget is gone, so refusing the
   *   save would send an operator back to re-enter a key that was fine.
   * - **Reddit: `false`.** A 429 from `/api/v1/access_token` is IP/edge-level
   *   load shedding, returned *without* looking at the Basic auth header -- and
   *   datacentre ranges, which is where a self-hosted aggregator lives, get
   *   throttled routinely. Treating it as a pass meant a first-ever save of
   *   *wrong* credentials from a throttled host stored them, set
   *   `reddit_enabled = 1`, and said "the credentials are valid". They may not
   *   be. That breaks the rule the flag exists for (rule 4 above): phase 9 would
   *   then offer Reddit feeds that come back empty, with a badge saying Active.
   *
   * `false` sends the answer to the `unknown` arm, which is exactly right: an
   * answer that was produced without checking the credential is not a verdict
   * about it, so nothing is written and the operator is told to try again.
   */
  quotaMeansVerified: boolean;
};

const YOUTUBE_KEYS: ProviderKeys = {
  rejected: "youtube.rejected",
  quota: "youtube.quota",
  quotaMeansVerified: true,
};
const REDDIT_KEYS: ProviderKeys = {
  rejected: "reddit.rejected",
  quota: "reddit.rateLimited",
  quotaMeansVerified: false,
};

/** The causes that mean "the question was not answered", not "the answer is no". */
const UNVERIFIABLE: Record<"network" | "timeout" | "unexpected", IntegrationsKey> = {
  network: "unreachable",
  timeout: "timedOut",
  unexpected: "unexpected",
};

/**
 * What a probe's verdict means for the row.
 *
 * Three outcomes rather than two, and the third one is the interesting one:
 *
 * - **`good`** -- the credential works. Store it, switch the integration on. A
 *   quota answer lands here with a `noticeKey` **when the provider validates the
 *   credential before accounting for quota** (`quotaMeansVerified` above): the
 *   key is valid and only today's budget is gone, so refusing the save would be
 *   wrong (see `SaveResult` in `./result`). Where it does not -- Reddit -- the
 *   same `cause` lands in `unknown` instead.
 * - **`bad`** -- the provider refused it. **Store it anyway**, and switch the
 *   integration off, so the badge agrees with the toast and a typo is visible
 *   rather than silently producing empty feeds.
 * - **`unknown`** -- a network failure, a timeout, a status no probe recognises,
 *   or a rate limit from a provider that sheds load before it authenticates.
 *   **Nothing is written at all.** With no answer there is nothing
 *   to derive the flag from, and both alternatives are worse: a momentary outage
 *   would either disable a working integration, or leave `*Enabled = true` --
 *   earned by a *different* credential -- vouching for one that has never been
 *   tested. The operator is told nothing changed and can retry.
 *
 * **The asymmetry between those last two is deliberate, and it was argued.** A
 * `bad` verdict overwrites a stored credential that was working, and the field
 * only ever showed eight bullets -- so one bad paste destroys a key that cannot
 * be read back out of this UI. That cost was put to the human explicitly, next
 * to the option of refusing the write, and storing was chosen: Save's contract
 * is "what you typed is now what is stored", and the alternative leaves an
 * operator reasoning about which of two invisible values the server decided to
 * keep, with a badge that cannot tell them apart. **Test** is what makes that
 * safe -- it writes nothing, so a replacement can be proved before it replaces
 * anything -- and **Remove** is the deliberate path back to "not configured".
 *
 * So do not "fix" `bad` into a no-write arm for consistency with `unknown`: they
 * differ because a refusal **is** a verdict about the credential that was
 * submitted, while an unanswered probe is no verdict at all. Collapsing them
 * would make a save silently discard what an operator typed whenever a provider
 * happened to say no, which is the failure this whole page exists to make
 * visible.
 */
type Judgement =
  | { outcome: "good"; noticeKey?: IntegrationsKey }
  | { outcome: "bad"; errorKey: IntegrationsKey }
  | { outcome: "unknown"; errorKey: IntegrationsKey };

function judge(probe: ProbeResult, keys: ProviderKeys): Judgement {
  if (probe.ok) return { outcome: "good" };
  switch (probe.cause) {
    case "quota":
      return keys.quotaMeansVerified
        ? { outcome: "good", noticeKey: keys.quota }
        : { outcome: "unknown", errorKey: keys.quota };
    case "unauthorized":
      return { outcome: "bad", errorKey: keys.rejected };
    default:
      return { outcome: "unknown", errorKey: UNVERIFIABLE[probe.cause] };
  }
}

/**
 * The one place a `detail` is allowed to go.
 *
 * `console.warn` rather than `console.error`: a rejected key is an ordinary
 * operator mistake, not a fault in this server. The line is what an operator
 * reads when the translated toast is not specific enough -- which is the whole
 * reason `detail` exists.
 */
function logProbe(provider: string, probe: ProbeResult): void {
  if (probe.ok) return;
  console.warn(`[integrations] ${provider} probe failed (${probe.cause}): ${probe.detail}`);
}

/**
 * The one wording of "this account has no settings row".
 *
 * Written once because it is the same provisioning bug wherever it is noticed
 * (see `getSettings()`, which throws for it and must not self-heal), and five
 * copies of a log line are five chances for one of them to say something
 * different about the same state.
 */
function logMissingRow(userId: string): void {
  console.error(`[integrations] no user_settings row for user "${userId}"`);
}

/** The stored secrets an unchanged submission resolves against. */
function storedCredentials(userId: string) {
  return getDb()
    .select({
      youtubeApiKey: userSettings.youtubeApiKey,
      redditClientId: userSettings.redditClientId,
      redditClientSecret: userSettings.redditClientSecret,
    })
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .get();
}

/**
 * Write the given columns, and report whether anything actually persisted.
 *
 * `changes === 0` means `WHERE user_id = ?` matched nothing, so the row is
 * missing -- a provisioning bug (see `getSettings()`, which throws for the same
 * state and must not self-heal). Reporting `ok: true` there would show "saved"
 * over a change a reload silently reverts.
 *
 * `updatedAt` is deliberately not set: the schema's `$onUpdate(() => new Date())`
 * stamps it on every Drizzle write, and a second place to set it is a second
 * place for it to drift.
 */
function persist(userId: string, values: Partial<typeof userSettings.$inferInsert>): boolean {
  try {
    const changes = writeTransaction(
      (tx) =>
        tx.update(userSettings).set(values).where(eq(userSettings.userId, userId)).run().changes,
    );
    if (changes === 0) {
      logMissingRow(userId);
      return false;
    }
    return true;
  } catch (error) {
    // Logged, not returned: a driver message is not a catalog key either.
    console.error("[integrations] failed to write credentials", error);
    return false;
  }
}

/** A judgement, turned into what the section renders. */
function report(judgement: Judgement): SaveResult {
  if (judgement.outcome === "good") {
    return judgement.noticeKey ? { ok: true, noticeKey: judgement.noticeKey } : { ok: true };
  }
  return { ok: false, errorKey: judgement.errorKey };
}

/**
 * What a submission resolved to, once the provider has answered about it.
 *
 * `refused` carries the finished `SaveResult` rather than a reason, because
 * every refusal before the probe (a malformed body, a missing settings row, a
 * field that is empty on both sides) is already the caller's whole answer --
 * there is nothing left for a save to add to it.
 */
type Verified<Credential> =
  | { status: "refused"; result: SaveResult }
  | { status: "verified"; credential: Credential; judgement: Judgement };

/**
 * Resolve a submission against the stored row, probe the result, and judge it.
 *
 * **Save and Test share this, and the sharing is the feature.** The Test button
 * is worth nothing unless it validates *exactly* what a Save would store, and
 * that agreement used to be nine byte-identical lines in each of two functions:
 * a change to the resolve rules or to the empty-credential guard applied to one
 * copy and not the other yields a Test that passes against one credential while
 * a Save stores a different one, with a green toast over both. Nothing about
 * that failure is visible in a review of either function alone, so the two paths
 * are made to be the same code instead of being kept in agreement by hand.
 * `actions.test.ts` pins the property directly as well -- it runs both entry
 * points on one submission and compares the requests they made.
 *
 * `logProbe()` lives here for the same reason: which `detail` is logged is part
 * of what the two paths must agree on.
 */
async function verifyYoutube(
  userId: string,
  input: unknown,
): Promise<Verified<{ apiKey: string }>> {
  const parsed = youtubeInput.safeParse(input);
  if (!parsed.success) return { status: "refused", result: { ok: false } };

  const stored = storedCredentials(userId);
  if (!stored) {
    logMissingRow(userId);
    return { status: "refused", result: { ok: false } };
  }

  const apiKey = resolveSecret(parsed.data.apiKey, stored.youtubeApiKey);
  // Nothing submitted and nothing stored: probing "" would come back
  // "unauthorized" and blame a key that was never entered.
  if (apiKey === "") {
    return { status: "refused", result: { ok: false, errorKey: "youtube.required" } };
  }

  const probe = await testYoutubeKey(apiKey);
  logProbe("youtube", probe);
  return { status: "verified", credential: { apiKey }, judgement: judge(probe, YOUTUBE_KEYS) };
}

/** {@link verifyYoutube}'s twin -- see the note there on why both paths share it. */
async function verifyReddit(userId: string, input: unknown): Promise<Verified<RedditCredentials>> {
  const parsed = redditInput.safeParse(input);
  if (!parsed.success) {
    return {
      status: "refused",
      result: { ok: false, errorKey: errorKeyFor(parsed.error.issues, REDDIT_FIELD_ERROR_KEYS) },
    };
  }

  const stored = storedCredentials(userId);
  if (!stored) {
    logMissingRow(userId);
    return { status: "refused", result: { ok: false } };
  }

  const credential: RedditCredentials = {
    clientId: resolveSecret(parsed.data.clientId, stored.redditClientId),
    clientSecret: resolveSecret(parsed.data.clientSecret, stored.redditClientSecret),
    // Not a secret, so it is submitted in full and never resolved against the row.
    userAgent: parsed.data.userAgent,
  };
  if (credential.clientId === "" || credential.clientSecret === "") {
    return { status: "refused", result: { ok: false, errorKey: "reddit.required" } };
  }

  const probe = await testRedditCredentials(credential);
  logProbe("reddit", probe);
  return { status: "verified", credential, judgement: judge(probe, REDDIT_KEYS) };
}

export async function saveYoutube(input: unknown): Promise<SaveResult> {
  const userId = await currentUserId();
  const verified = await verifyYoutube(userId, input);
  if (verified.status === "refused") return verified.result;
  const { credential, judgement } = verified;

  // No verdict, so nothing to derive a flag from -- see judge().
  if (judgement.outcome === "unknown") return report(judgement);

  const persisted = persist(userId, {
    youtubeApiKey: credential.apiKey,
    youtubeEnabled: judgement.outcome === "good",
  });
  if (!persisted) return { ok: false };
  revalidatePath("/integrations");
  return report(judgement);
}

export async function saveReddit(input: unknown): Promise<SaveResult> {
  const userId = await currentUserId();
  const verified = await verifyReddit(userId, input);
  if (verified.status === "refused") return verified.result;
  const { credential, judgement } = verified;

  if (judgement.outcome === "unknown") return report(judgement);

  const persisted = persist(userId, {
    redditClientId: credential.clientId,
    redditClientSecret: credential.clientSecret,
    redditUserAgent: credential.userAgent,
    redditEnabled: judgement.outcome === "good",
  });
  if (!persisted) return { ok: false };
  revalidatePath("/integrations");
  return report(judgement);
}

/**
 * Try the submitted credentials without persisting anything.
 *
 * The point of the button: an operator validates a key *before* it replaces one
 * that works -- which is also what makes an `unauthorized` save's overwrite an
 * accepted cost rather than a trap (see `judge()`). So this writes nothing, not
 * even the `*Enabled` flag, and does not revalidate.
 *
 * It differs from `saveYoutube()` in exactly that: the resolution and the probe
 * are the same call.
 */
export async function testYoutube(input: unknown): Promise<SaveResult> {
  const userId = await currentUserId();
  const verified = await verifyYoutube(userId, input);
  return verified.status === "refused" ? verified.result : report(verified.judgement);
}

/** {@link testYoutube}'s twin -- see the note there on why nothing is written. */
export async function testReddit(input: unknown): Promise<SaveResult> {
  const userId = await currentUserId();
  const verified = await verifyReddit(userId, input);
  return verified.status === "refused" ? verified.result : report(verified.judgement);
}

/**
 * The way back to "not configured", and the reason it needs an action of its own.
 *
 * An empty submission means *keep* the stored secret (rule 2 above) and the
 * enabled flag is probe-derived (rule 4), so without this there is no path from
 * a configured integration to an unconfigured one -- an operator who revoked a
 * key at the provider could not remove it here. Wiping the column to `""` rather
 * than NULL keeps the `notNull()` contract the schema declares.
 *
 * `redditUserAgent` is deliberately **not** reset: it is not a credential, and
 * throwing away a correctly-written one is a small cruelty on the path to
 * re-entering the client id.
 */
export async function removeYoutube(): Promise<IntegrationsResult> {
  const userId = await currentUserId();
  if (!persist(userId, { youtubeApiKey: "", youtubeEnabled: false })) {
    return { ok: false, errorKey: "removeFailed" };
  }
  revalidatePath("/integrations");
  return { ok: true };
}

/** {@link removeYoutube}'s twin. */
export async function removeReddit(): Promise<IntegrationsResult> {
  const userId = await currentUserId();
  const wiped = persist(userId, {
    redditClientId: "",
    redditClientSecret: "",
    redditEnabled: false,
  });
  if (!wiped) return { ok: false, errorKey: "removeFailed" };
  revalidatePath("/integrations");
  return { ok: true };
}
