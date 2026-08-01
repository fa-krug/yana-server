"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentUserId } from "@/lib/auth/session";
import { getDb, writeTransaction } from "@/lib/db/client";
import { userSettings } from "@/lib/db/schema";
import { resolveSecret } from "@/lib/secrets";

import type { ProbeResult } from "./probe";
import { testRedditCredentials } from "./reddit";
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

const youtubeInput = z.object({ apiKey: z.string().max(MAX_SECRET_LENGTH) });

const redditInput = z.object({
  clientId: z.string().max(MAX_SECRET_LENGTH),
  clientSecret: z.string().max(MAX_SECRET_LENGTH),
  /**
   * Required, and checked here rather than left to the probe. Reddit throttles a
   * blank or generic User-Agent hard, so `testRedditCredentials()` refuses an
   * empty one before it makes any HTTP call -- but it reports that as
   * `cause: "unauthorized"`, which maps to "Reddit rejected those credentials"
   * and would send an operator hunting through a client id that was fine.
   * `.trim()` runs before `.min(1)`, so " " is empty.
   */
  userAgent: z.string().trim().min(1).max(MAX_USER_AGENT_LENGTH),
});

/** Which field failed, as a catalog key; anything unlisted falls through. */
const REDDIT_FIELD_ERROR_KEYS: Record<string, IntegrationsKey> = {
  userAgent: "reddit.userAgentRequired",
};

function errorKeyFor(
  issues: z.core.$ZodIssue[],
  table: Record<string, IntegrationsKey>,
): IntegrationsKey | undefined {
  const field = issues[0]?.path[0];
  return typeof field === "string" ? table[field] : undefined;
}

/**
 * The two keys that differ per provider. Everything else a probe can report
 * means the same thing whoever answered it.
 */
type ProviderKeys = {
  /** The provider refused the credential. */
  rejected: IntegrationsKey;
  /** The credential is good; only the provider's budget for it is spent. */
  quota: IntegrationsKey;
};

const YOUTUBE_KEYS: ProviderKeys = { rejected: "youtube.rejected", quota: "youtube.quota" };
const REDDIT_KEYS: ProviderKeys = { rejected: "reddit.rejected", quota: "reddit.rateLimited" };

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
 *   quota answer lands here with a `noticeKey`: the key is valid and only
 *   today's budget is gone, so refusing the save would be wrong (see
 *   `SaveResult` in `./result`).
 * - **`bad`** -- the provider refused it. Store it and switch the integration
 *   *off*, so the badge agrees with the toast and a typo is visible rather than
 *   silently producing empty feeds.
 * - **`unknown`** -- a network failure, a timeout, or a status no probe
 *   recognises. **Nothing is written at all.** With no answer there is nothing
 *   to derive the flag from, and the alternative is worse in both directions: a
 *   momentary outage would either disable a working integration, or leave
 *   `*Enabled = true` claiming that a key which has never been tested works.
 *   The operator is told nothing changed and can retry.
 */
type Judgement =
  | { outcome: "good"; noticeKey?: IntegrationsKey }
  | { outcome: "bad"; errorKey: IntegrationsKey }
  | { outcome: "unknown"; errorKey: IntegrationsKey };

function judge(probe: ProbeResult, keys: ProviderKeys): Judgement {
  if (probe.ok) return { outcome: "good" };
  switch (probe.cause) {
    case "quota":
      return { outcome: "good", noticeKey: keys.quota };
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
      console.error(`[integrations] no user_settings row for user "${userId}"`);
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

export async function saveYoutube(input: unknown): Promise<SaveResult> {
  const userId = await currentUserId();
  const parsed = youtubeInput.safeParse(input);
  if (!parsed.success) return { ok: false };

  const stored = storedCredentials(userId);
  if (!stored) {
    console.error(`[integrations] no user_settings row for user "${userId}"`);
    return { ok: false };
  }

  const apiKey = resolveSecret(parsed.data.apiKey, stored.youtubeApiKey);
  // Nothing submitted and nothing stored: probing "" would come back
  // "unauthorized" and blame a key that was never entered.
  if (apiKey === "") return { ok: false, errorKey: "youtube.required" };

  const probe = await testYoutubeKey(apiKey);
  logProbe("youtube", probe);
  const judgement = judge(probe, YOUTUBE_KEYS);
  if (judgement.outcome === "unknown") return { ok: false, errorKey: judgement.errorKey };

  if (!persist(userId, { youtubeApiKey: apiKey, youtubeEnabled: judgement.outcome === "good" })) {
    return { ok: false };
  }
  revalidatePath("/integrations");
  return report(judgement);
}

export async function saveReddit(input: unknown): Promise<SaveResult> {
  const userId = await currentUserId();
  const parsed = redditInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errorKey: errorKeyFor(parsed.error.issues, REDDIT_FIELD_ERROR_KEYS) };
  }

  const stored = storedCredentials(userId);
  if (!stored) {
    console.error(`[integrations] no user_settings row for user "${userId}"`);
    return { ok: false };
  }

  const clientId = resolveSecret(parsed.data.clientId, stored.redditClientId);
  const clientSecret = resolveSecret(parsed.data.clientSecret, stored.redditClientSecret);
  const userAgent = parsed.data.userAgent;
  if (clientId === "" || clientSecret === "") {
    return { ok: false, errorKey: "reddit.required" };
  }

  const probe = await testRedditCredentials({ clientId, clientSecret, userAgent });
  logProbe("reddit", probe);
  const judgement = judge(probe, REDDIT_KEYS);
  if (judgement.outcome === "unknown") return { ok: false, errorKey: judgement.errorKey };

  const persisted = persist(userId, {
    redditClientId: clientId,
    redditClientSecret: clientSecret,
    redditUserAgent: userAgent,
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
 * that works. So this writes nothing -- not even the `*Enabled` flag -- and does
 * not revalidate.
 */
export async function testYoutube(input: unknown): Promise<SaveResult> {
  const userId = await currentUserId();
  const parsed = youtubeInput.safeParse(input);
  if (!parsed.success) return { ok: false };

  const stored = storedCredentials(userId);
  if (!stored) {
    console.error(`[integrations] no user_settings row for user "${userId}"`);
    return { ok: false };
  }

  const apiKey = resolveSecret(parsed.data.apiKey, stored.youtubeApiKey);
  if (apiKey === "") return { ok: false, errorKey: "youtube.required" };

  const probe = await testYoutubeKey(apiKey);
  logProbe("youtube", probe);
  return report(judge(probe, YOUTUBE_KEYS));
}

/** {@link testYoutube}'s twin -- see the note there on why nothing is written. */
export async function testReddit(input: unknown): Promise<SaveResult> {
  const userId = await currentUserId();
  const parsed = redditInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errorKey: errorKeyFor(parsed.error.issues, REDDIT_FIELD_ERROR_KEYS) };
  }

  const stored = storedCredentials(userId);
  if (!stored) {
    console.error(`[integrations] no user_settings row for user "${userId}"`);
    return { ok: false };
  }

  const clientId = resolveSecret(parsed.data.clientId, stored.redditClientId);
  const clientSecret = resolveSecret(parsed.data.clientSecret, stored.redditClientSecret);
  if (clientId === "" || clientSecret === "") {
    return { ok: false, errorKey: "reddit.required" };
  }

  const probe = await testRedditCredentials({
    clientId,
    clientSecret,
    userAgent: parsed.data.userAgent,
  });
  logProbe("reddit", probe);
  return report(judge(probe, REDDIT_KEYS));
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
