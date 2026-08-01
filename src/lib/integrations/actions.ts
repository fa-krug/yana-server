"use server";

import { z } from "zod";

import { defineIntegrationIn } from "./define";
import { testRedditCredentials } from "./reddit";
import type { IntegrationsKey, IntegrationsResult, SaveResult } from "./result";
import { testYoutubeKey } from "./youtube";

/**
 * Everything `/integrations` writes, plus the two credential tests.
 *
 * **This file is a table of providers, not a sequence.** The sequence -- parse,
 * load the row, resolve each secret, guard the empty case, probe, log, judge,
 * write -- lives once in `./define`, and what a provider *is* lives here as a
 * declaration. Two reasons it is that way round: phase 7 adds three more
 * providers, and the risk in five near-twin sequences is not their length but
 * the drift *between* them, which no test of any one of them can see.
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
 *    credential just submitted, so it is logged in `./define` and dropped. What
 *    crosses the wire is a catalog key under the `integrations` namespace, typed
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
 * The `integrations` binding of the descriptor -- the page's own four keys,
 * checked against the real catalogs here, where the namespace is a literal.
 * Phase 7's AI page writes its twin against its own namespace.
 *
 * Not exported, and it could not be: this module carries `"use server"`, so
 * every export has to be an async function Next can expose as an endpoint.
 */
const defineIntegration = defineIntegrationIn<IntegrationsKey>({
  path: "/integrations",
  unverifiable: { network: "unreachable", timeout: "timedOut", unexpected: "unexpected" },
  removeFailed: "removeFailed",
});

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
 * submitted** and switches the integration off (see `Judgement` in `./define`
 * and the human ruling behind it). So one invisible character used to destroy a
 * working key that this UI can never show again, while telling the operator to
 * go and check a key that was correct all along.
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
 * Reddit's per-field failures. YouTube declares none: its one field can only be
 * too long, and "the key is too long" is not advice worth a key of its own.
 *
 * See `fieldErrorKeys` in `./define` for why the table is keyed on `field:code`
 * rather than on the field alone.
 */
const REDDIT_FIELD_ERROR_KEYS: Record<string, IntegrationsKey> = {
  "userAgent:too_small": "reddit.userAgentRequired",
  "userAgent:invalid_format": "reddit.userAgentInvalid",
};

const youtube = defineIntegration({
  provider: "youtube",
  schema: youtubeInput,
  fields: { apiKey: { column: "youtubeApiKey", secret: true } },
  flagColumn: "youtubeEnabled",
  requiredKey: "youtube.required",
  probe: ({ apiKey }) => testYoutubeKey(apiKey),
  keys: { rejected: "youtube.rejected", quota: "youtube.quota", quotaMeansVerified: true },
});

const reddit = defineIntegration({
  provider: "reddit",
  schema: redditInput,
  fields: {
    clientId: { column: "redditClientId", secret: true },
    clientSecret: { column: "redditClientSecret", secret: true },
    // Not a credential: submitted in full, never resolved against the row, and
    // deliberately not wiped by Remove. See `IntegrationField` in `./define`.
    userAgent: { column: "redditUserAgent", secret: false },
  },
  flagColumn: "redditEnabled",
  requiredKey: "reddit.required",
  fieldErrorKeys: REDDIT_FIELD_ERROR_KEYS,
  probe: testRedditCredentials,
  // `quotaMeansVerified: false` where YouTube says `true`, and the difference is
  // the whole reason the field is required rather than defaulted -- a 429 from
  // Reddit's token endpoint is edge-level load shedding returned before the
  // Basic auth header is looked at. See `ProviderKeys` in `./define`.
  keys: { rejected: "reddit.rejected", quota: "reddit.rateLimited", quotaMeansVerified: false },
});

export async function saveYoutube(input: unknown): Promise<SaveResult> {
  return youtube.save(input);
}

export async function saveReddit(input: unknown): Promise<SaveResult> {
  return reddit.save(input);
}

export async function testYoutube(input: unknown): Promise<SaveResult> {
  return youtube.test(input);
}

export async function testReddit(input: unknown): Promise<SaveResult> {
  return reddit.test(input);
}

export async function removeYoutube(): Promise<IntegrationsResult> {
  return youtube.remove();
}

export async function removeReddit(): Promise<IntegrationsResult> {
  return reddit.remove();
}
