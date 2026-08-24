"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentUserId } from "@/lib/auth/session";
import { writeTransaction } from "@/lib/db/client";
import { userSettings } from "@/lib/db/schema";
import { defineIntegrationIn, type IntegrationActions } from "@/lib/integrations/define";

import { AI_ADVANCED_BOUNDS, AI_ADVANCED_FIELDS, type AiAdvancedField } from "./bounds";
import { AI_COLUMNS } from "./columns";
import { AI_PROBES } from "./probes";
import {
  OPENAI_DEFAULT_API_URL,
  OPENROUTER_API_URL,
  providerByKey,
  type AiProvider,
  type AiProviderKey,
} from "./providers";
import type { AiKey, AiResult, AiSaveResult } from "./result";

/**
 * Everything `/ai` writes: seven provider credentials, which provider is
 * active, and the seven global tuning values.
 *
 * **The seven providers are a table, not seven sequences.** Parse, load the
 * row, resolve each secret, guard the empty case, probe, log, judge, write --
 * all of that lives once in `@/lib/integrations/define`, extracted in task R2
 * for exactly this moment. What a provider *is* lives here as a declaration.
 * Phase 6's two credential cards plus these seven is nine, and the risk in
 * nine near-twin sequences is not their length but the drift *between* them,
 * which no test of any one of them can see.
 *
 * Every rule the integrations actions live under applies here unchanged -- read
 * that file's header for them -- plus two this page adds:
 *
 * 1. **`quotaMeansVerified` is read from the registry, never typed in here.**
 *    The seven providers do not all give the same answer -- `false` for
 *    OpenAI and OpenRouter, `true` for the other five, each for its own
 *    reason -- and the reasoning lives beside the field in `./providers` and,
 *    duplicated on purpose for the three whose probes classify a 429
 *    themselves, at each probe's 429 branch. A literal in this file would be a
 *    copy able to drift from any of the seven, which is the precise failure
 *    the field was made required to prevent.
 * 2. **`active_ai_provider` is a preference; the `*Enabled` flag is the
 *    permission.** Nothing here erases the preference when a flag goes false --
 *    which provider is *actually* active is derived on the read side by
 *    `activeProvider()` in `./queries`. See {@link setActiveProvider}, where the
 *    reasoning is written out.
 */

/** Revalidated after every write here, and never after a Test. */
const AI_PATH = "/ai";

/**
 * What every log line this module writes is tagged with -- `[ai]`, not
 * `[integrations]`, which is why `defineIntegrationIn()` takes the prefix as
 * part of its binding rather than hard-coding one.
 */
const LOG_PREFIX = "[ai]";

/**
 * The `ai` binding of the descriptor: the four keys that belong to the page
 * rather than to any provider, checked against the real catalogs here, where the
 * namespace is a literal.
 *
 * Not exported, and it could not be: this module carries `"use server"`, so
 * every export has to be an async function Next can expose as an endpoint.
 */
const defineIntegration = defineIntegrationIn<AiKey>({
  path: AI_PATH,
  logPrefix: LOG_PREFIX,
  unverifiable: { network: "unreachable", timeout: "timedOut", unexpected: "unexpected" },
  removeFailed: "removeFailed",
});

/**
 * Long enough for any real provider key (an OpenAI `sk-proj-…` is around 164
 * characters, an Anthropic `sk-ant-…` about 108, a Google key 39) and short
 * enough that a bogus submission is refused before it is sent anywhere.
 */
const MAX_SECRET_LENGTH = 512;

/** Comfortably past any real gateway URL; a browser's own practical limit. */
const MAX_API_URL_LENGTH = 2000;

/**
 * A secret, as submitted.
 *
 * **`.trim()` is load-bearing, not tidiness**, and the reasoning is phase 6's
 * verbatim: a key is copied out of a provider console or a password manager, and
 * both hand out a trailing newline routinely. Untrimmed it goes to the provider
 * mangled, comes back 401, classifies as `unauthorized` -- and an `unauthorized`
 * save **stores what was submitted** (see `Judgement` in
 * `@/lib/integrations/define`), so one invisible character destroys a working
 * key that this UI can never show again.
 *
 * It is safe on the sentinel: `KEEP_EXISTING` starts with a NUL byte, which is
 * not JS whitespace, so an untouched field still resolves to the stored value.
 * `secrets.test.ts` pins that, and it has to hold *before* `resolveSecret()`
 * sees the value -- which is why the trim lives in the schema.
 */
const secretField = z.string().trim().max(MAX_SECRET_LENGTH);

/**
 * The model select's value, checked against the registry the select is built
 * from.
 *
 * **Refused here rather than left to the probe.** An unlisted id reaches the
 * provider as a real request and comes back 404, which every probe classifies as
 * `unexpected` -- "the provider answered in a way Yana did not expect" -- so an
 * operator would be told to read a server log about a value they picked from a
 * dropdown. It also keeps an id the registry has retired from being written back
 * into the row by a stale form.
 */
function modelField(provider: AiProvider) {
  return z
    .string()
    .trim()
    .refine((value) => provider.models.some((model) => model.value === value));
}

/**
 * OpenAI's base URL: empty, or a real http(s) URL.
 *
 * **The empty case becomes the default rather than an empty column.** `apiUrl`
 * is declared `secret: false`, so it is submitted in full every time and an
 * empty field would otherwise store `""` -- leaving every later reader (the
 * probe today, phase 12's summariser next) to remember its own fallback. One
 * normalisation at the write is one place to be wrong.
 *
 * **The check duplicates the probe's, and both are wanted.** `testOpenaiKey()`
 * refuses an unparseable base URL itself because its contract is to resolve to a
 * classified `ProbeResult` for *every* input -- that guarantee has to be
 * structural. But it can only report `unexpected`, whose message sends an
 * operator to the server log. This arm exists to give the far likelier mistake
 * (a missing scheme, `gateway.example.com/v1`) an answer that names it.
 */
const openaiApiUrlField = z
  .string()
  .trim()
  .max(MAX_API_URL_LENGTH)
  .refine((value) => value === "" || isStorableBaseUrl(value))
  .transform((value) => value || OPENAI_DEFAULT_API_URL);

/**
 * An http(s) URL with no credentials embedded in it.
 *
 * **The userinfo half is a human ruling, not a tidiness check** (see the SSRF
 * paragraph in CLAUDE.md). `https://user:pass@gateway.example.com/v1` is a
 * perfectly legal URL that both older checks accepted, and `apiUrl` is the one
 * field on this page projected to the browser **unmasked** -- it is not a
 * secret, so `getAiStatus()` does not run it through `mask()`. Stored, it puts a
 * plaintext gateway password into the RSC payload of `/ai`, which is plain text
 * in a browser's network tab. That is only ever the operator's own credential,
 * so it is not an escalation; it does contradict this page's stated contract
 * that a credential leaves the server masked or not at all, which is enough.
 *
 * Refused rather than stripped: silently dropping the userinfo would send the
 * probe to a gateway that then answers 401, and the operator would be told
 * their *API key* was rejected. The catalog message names the requirement and
 * says where the credential belongs instead.
 *
 * `testOpenaiKey()` checks the same thing again, for the reason it re-checks
 * the scheme: its contract is to classify *every* input structurally.
 */
function isStorableBaseUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.username === "" && url.password === "";
}

/**
 * OpenRouter's model field, deliberately **not** `modelField()`'s
 * enum-membership check. That helper validates against `provider.models`, a
 * static array -- correct for the other six providers, wrong here: a valid
 * OpenRouter model id comes from a live catalog (`listOpenrouterModels()`
 * below) the server does not re-fetch at submit time. An actually-invalid id
 * is still refused, by OpenRouter itself at probe time, surfacing through the
 * existing generic `unexpected` probe-failure path.
 */
const openrouterModelField = z.string().trim().min(1).max(200);

/**
 * The registry entry for a provider key that is already known to be one.
 *
 * Unreachable in practice -- `providers.test.ts` pins `AI_PROVIDERS` to exactly
 * these seven keys -- and it throws rather than substituting a default because
 * inventing a `quotaMeansVerified` here is precisely the inheritance the
 * required field exists to prevent.
 */
function registryEntry(key: AiProviderKey): AiProvider {
  const provider = providerByKey(key);
  if (!provider) throw new Error(`${LOG_PREFIX} no registry entry for provider "${key}"`);
  return provider;
}

/**
 * The two per-provider catalog keys `judge()` reaches for, plus the one for an
 * empty credential and the one for an unlisted model.
 *
 * **`quota` is named per its arm, not per its cause**, which is why the wording
 * splits in two rather than seven ways. For Anthropic, Gemini, Mistral, Qwen
 * and DeepSeek -- every `quotaMeansVerified: true` provider -- a rate limit is
 * a *notice on a success* -- the key was accepted, only the budget is gone --
 * so the key reads "the key is valid, and…". For OpenAI and OpenRouter, the
 * two `false` providers, the same cause lands in the arm that writes nothing,
 * for their own separate reasons (OpenAI's base URL is an operator setting and
 * a gateway can shed load before reading the `Authorization` header;
 * OpenRouter's own edge is itself that gateway), so the key reads "could not
 * be verified" for both. Which arm each one lands in is `quotaMeansVerified`
 * below, read from the registry.
 *
 * **`rejected` is worded broadly on purpose.** Three quite different answers
 * reach it: a key the provider does not know, OpenAI's `insufficient_quota` and
 * Anthropic's 403 `billing_error` (both deliberately classified `unauthorized`
 * so the credential is stored with the integration off -- see the comments in
 * `./openai` and `./anthropic`), and a bare 403. "That API key was rejected"
 * would be wrong advice for an operator whose only fault is an unpaid bill, so
 * the wording is "would not accept these credentials", with the three things to
 * check named after it.
 */
const PROVIDER_KEYS = {
  openai: {
    required: "openai.required",
    rejected: "openai.rejected",
    quota: "openai.rateLimited",
    modelUnknown: "openai.modelUnknown",
  },
  anthropic: {
    required: "anthropic.required",
    rejected: "anthropic.rejected",
    quota: "anthropic.quota",
    modelUnknown: "anthropic.modelUnknown",
  },
  gemini: {
    required: "gemini.required",
    rejected: "gemini.rejected",
    quota: "gemini.quota",
    modelUnknown: "gemini.modelUnknown",
  },
  mistral: {
    required: "mistral.required",
    rejected: "mistral.rejected",
    quota: "mistral.quota",
    modelUnknown: "mistral.modelUnknown",
  },
  qwen: {
    required: "qwen.required",
    rejected: "qwen.rejected",
    quota: "qwen.quota",
    modelUnknown: "qwen.modelUnknown",
  },
  deepseek: {
    required: "deepseek.required",
    rejected: "deepseek.rejected",
    quota: "deepseek.quota",
    modelUnknown: "deepseek.modelUnknown",
  },
  openrouter: {
    required: "openrouter.required",
    rejected: "openrouter.rejected",
    quota: "openrouter.rateLimited",
    // Declared for shape-consistency with the other six providers'
    // `Record<AiProviderKey, ...>` entry, but never wired into a provider's
    // `fieldErrorKeys` below: there is no static model list to validate
    // against before the probe runs, so an unknown OpenRouter model id is
    // reported through the generic `unexpected` probe-failure path instead.
    modelUnknown: "openrouter.modelUnknown",
  },
} satisfies Record<
  AiProviderKey,
  Record<"required" | "rejected" | "quota" | "modelUnknown", AiKey>
>;

const openai = defineIntegration({
  provider: "openai",
  schema: z.object({
    apiKey: secretField,
    model: modelField(registryEntry("openai")),
    apiUrl: openaiApiUrlField,
  }),
  fields: {
    apiKey: { column: AI_COLUMNS.openai.apiKey, secret: true },
    // Not credentials: submitted in full, never resolved against the row, and
    // deliberately not wiped by Remove. See `IntegrationField` in
    // `@/lib/integrations/define` -- these are Reddit's `userAgent` again.
    model: { column: AI_COLUMNS.openai.model, secret: false },
    apiUrl: { column: AI_COLUMNS.openai.apiUrl, secret: false },
  },
  flagColumn: AI_COLUMNS.openai.enabled,
  requiredKey: PROVIDER_KEYS.openai.required,
  /**
   * Keyed on `field:code`; a `.refine()` failure is zod's `custom`.
   *
   * **`too_big` shares the URL's key with `custom`** rather than falling through
   * to the page's generic failure: both mean "that is not a base URL this will
   * accept", and the key's message names the field and shows the shape one
   * should have -- which is advice, where "could not save these credentials" is
   * not. It is a separate entry because `.max()` reports before `.refine()` gets
   * to run, so a 3000-character string never reaches the `custom` arm at all.
   * The message it shares says nothing about length, which was considered and
   * left as is: the toast takes no ICU values, so `MAX_API_URL_LENGTH` cannot be
   * named without threading a parameter through the shared reporter, and a
   * numberless "not too long" is a longer toast rather than advice. See the
   * SSRF bullet in CLAUDE.md.
   *
   * **`apiKey:too_big` is deliberately left unmapped**, following YouTube's
   * precedent in `@/lib/integrations/actions`: a key can only be too long, and
   * "the key is too long" is not advice worth a catalog key of its own.
   */
  fieldErrorKeys: {
    "model:custom": PROVIDER_KEYS.openai.modelUnknown,
    "apiUrl:custom": "openai.apiUrlInvalid",
    "apiUrl:too_big": "openai.apiUrlInvalid",
  },
  probe: AI_PROBES.openai,
  keys: {
    rejected: PROVIDER_KEYS.openai.rejected,
    quota: PROVIDER_KEYS.openai.quota,
    quotaMeansVerified: registryEntry("openai").quotaMeansVerified,
  },
});

const anthropic = defineIntegration({
  provider: "anthropic",
  schema: z.object({ apiKey: secretField, model: modelField(registryEntry("anthropic")) }),
  fields: {
    apiKey: { column: AI_COLUMNS.anthropic.apiKey, secret: true },
    model: { column: AI_COLUMNS.anthropic.model, secret: false },
  },
  flagColumn: AI_COLUMNS.anthropic.enabled,
  requiredKey: PROVIDER_KEYS.anthropic.required,
  fieldErrorKeys: { "model:custom": PROVIDER_KEYS.anthropic.modelUnknown },
  probe: AI_PROBES.anthropic,
  keys: {
    rejected: PROVIDER_KEYS.anthropic.rejected,
    quota: PROVIDER_KEYS.anthropic.quota,
    quotaMeansVerified: registryEntry("anthropic").quotaMeansVerified,
  },
});

const gemini = defineIntegration({
  provider: "gemini",
  schema: z.object({ apiKey: secretField, model: modelField(registryEntry("gemini")) }),
  fields: {
    apiKey: { column: AI_COLUMNS.gemini.apiKey, secret: true },
    model: { column: AI_COLUMNS.gemini.model, secret: false },
  },
  flagColumn: AI_COLUMNS.gemini.enabled,
  requiredKey: PROVIDER_KEYS.gemini.required,
  fieldErrorKeys: { "model:custom": PROVIDER_KEYS.gemini.modelUnknown },
  probe: AI_PROBES.gemini,
  keys: {
    rejected: PROVIDER_KEYS.gemini.rejected,
    quota: PROVIDER_KEYS.gemini.quota,
    quotaMeansVerified: registryEntry("gemini").quotaMeansVerified,
  },
});

const mistral = defineIntegration({
  provider: "mistral",
  schema: z.object({ apiKey: secretField, model: modelField(registryEntry("mistral")) }),
  fields: {
    apiKey: { column: AI_COLUMNS.mistral.apiKey, secret: true },
    model: { column: AI_COLUMNS.mistral.model, secret: false },
  },
  flagColumn: AI_COLUMNS.mistral.enabled,
  requiredKey: PROVIDER_KEYS.mistral.required,
  fieldErrorKeys: { "model:custom": PROVIDER_KEYS.mistral.modelUnknown },
  probe: AI_PROBES.mistral,
  keys: {
    rejected: PROVIDER_KEYS.mistral.rejected,
    quota: PROVIDER_KEYS.mistral.quota,
    quotaMeansVerified: registryEntry("mistral").quotaMeansVerified,
  },
});

const qwen = defineIntegration({
  provider: "qwen",
  schema: z.object({ apiKey: secretField, model: modelField(registryEntry("qwen")) }),
  fields: {
    apiKey: { column: AI_COLUMNS.qwen.apiKey, secret: true },
    model: { column: AI_COLUMNS.qwen.model, secret: false },
  },
  flagColumn: AI_COLUMNS.qwen.enabled,
  requiredKey: PROVIDER_KEYS.qwen.required,
  fieldErrorKeys: { "model:custom": PROVIDER_KEYS.qwen.modelUnknown },
  probe: AI_PROBES.qwen,
  keys: {
    rejected: PROVIDER_KEYS.qwen.rejected,
    quota: PROVIDER_KEYS.qwen.quota,
    quotaMeansVerified: registryEntry("qwen").quotaMeansVerified,
  },
});

const deepseek = defineIntegration({
  provider: "deepseek",
  schema: z.object({ apiKey: secretField, model: modelField(registryEntry("deepseek")) }),
  fields: {
    apiKey: { column: AI_COLUMNS.deepseek.apiKey, secret: true },
    model: { column: AI_COLUMNS.deepseek.model, secret: false },
  },
  flagColumn: AI_COLUMNS.deepseek.enabled,
  requiredKey: PROVIDER_KEYS.deepseek.required,
  fieldErrorKeys: { "model:custom": PROVIDER_KEYS.deepseek.modelUnknown },
  probe: AI_PROBES.deepseek,
  keys: {
    rejected: PROVIDER_KEYS.deepseek.rejected,
    quota: PROVIDER_KEYS.deepseek.quota,
    quotaMeansVerified: registryEntry("deepseek").quotaMeansVerified,
  },
});

const openrouter = defineIntegration({
  provider: "openrouter",
  schema: z.object({ apiKey: secretField, model: openrouterModelField }),
  fields: {
    apiKey: { column: AI_COLUMNS.openrouter.apiKey, secret: true },
    model: { column: AI_COLUMNS.openrouter.model, secret: false },
  },
  flagColumn: AI_COLUMNS.openrouter.enabled,
  requiredKey: PROVIDER_KEYS.openrouter.required,
  // No `fieldErrorKeys` entry: `openrouterModelField` has no `.refine()`, so
  // it never produces a `custom` zod issue to map, unlike the other six
  // providers' `"model:custom"` -> `modelUnknown` mapping.
  probe: AI_PROBES.openrouter,
  keys: {
    rejected: PROVIDER_KEYS.openrouter.rejected,
    quota: PROVIDER_KEYS.openrouter.quota,
    quotaMeansVerified: registryEntry("openrouter").quotaMeansVerified,
  },
});

const PROVIDER_ACTIONS: Record<AiProviderKey, IntegrationActions<AiKey>> = {
  openai,
  anthropic,
  gemini,
  mistral,
  qwen,
  deepseek,
  openrouter,
};

/**
 * A provider named by an untrusted string, narrowed -- or nothing.
 *
 * Every entry point below takes a `string`, because that is what arrives over
 * the wire; `providerByKey()` is the narrowing, and its own `key` is what indexes
 * the record, so nothing here is cast.
 */
function lookup(key: string): { provider: AiProvider; actions: IntegrationActions<AiKey> } | null {
  const provider = providerByKey(key);
  return provider ? { provider, actions: PROVIDER_ACTIONS[provider.key] } : null;
}

function logMissingRow(userId: string): void {
  console.error(`${LOG_PREFIX} no user_settings row for user "${userId}"`);
}

/**
 * Save one provider's credentials: probe first, then write what the verdict
 * allows.
 *
 * The whole sequence is `@/lib/integrations/define`'s. The only thing this adds
 * is refusing a provider key Yana does not support before any of it runs.
 *
 * **It deliberately does not touch `active_ai_provider`, even when the probe's
 * verdict switches this provider off.** See {@link setActiveProvider}: the
 * column is a preference and the read path derives what is *actually* active
 * from it, so a save that disables a provider does not need to erase the
 * operator's choice -- and erasing it would be worse. OpenAI's
 * `insufficient_quota` is classified `unauthorized` on purpose (see `./openai`),
 * so an unpaid bill on the active provider would wipe the selection permanently:
 * the operator pays, re-saves, the flag comes back true, and they still have to
 * re-pick a provider they never deselected. Leaving the preference alone means
 * the selection returns by itself.
 */
export async function saveProvider(key: string, input: unknown): Promise<AiSaveResult> {
  const found = lookup(key);
  return found ? found.actions.save(input) : { ok: false, errorKey: "unknownProvider" };
}

/**
 * Try a provider's credentials without persisting anything -- not even the
 * `*Enabled` flag, and no revalidation.
 *
 * The point of the button: an operator validates a key *before* it replaces one
 * that works, which is also what makes an `unauthorized` save's overwrite an
 * accepted cost rather than a trap. It shares `verify()` with `saveProvider`, so
 * what it validates is exactly what a save would store.
 *
 * **It answers an `AiSaveResult`, not the `ProbeResult` the phase-7 plan's
 * interface listed.** A `ProbeResult` carries `detail`, which is English prose
 * built for a server log and can be built from a provider's own answer; sending
 * it to the browser is the one thing this whole result convention exists to
 * prevent.
 */
export async function testProvider(key: string, input: unknown): Promise<AiSaveResult> {
  const found = lookup(key);
  return found ? found.actions.test(input) : { ok: false, errorKey: "unknownProvider" };
}

/**
 * The way back to "not configured".
 *
 * An empty submission means *keep* the stored secret and the enabled flag is
 * probe-derived, so without this there is no path from a configured provider to
 * an unconfigured one. Only the API key is wiped -- the model and the base URL
 * are not credentials, and throwing away a carefully-typed gateway URL on the
 * way to re-entering a key would be a small cruelty.
 *
 * **`active_ai_provider` is left alone here too**, for the same reason
 * `saveProvider` leaves it alone: it is a preference, the read path derives what
 * is actually active, and an operator who removes a key to rotate it should not
 * have to re-pick the provider afterwards.
 */
export async function removeProvider(key: string): Promise<AiResult> {
  const found = lookup(key);
  return found ? found.actions.remove() : { ok: false, errorKey: "unknownProvider" };
}

/**
 * Choose which provider AI runs on, or `""` to switch AI off entirely.
 *
 * **A provider must have passed a probe.** `*Enabled` is derived from a live
 * probe and never from a request, and selecting a provider that has not passed
 * one is how AI features fail silently -- summaries that simply never appear,
 * with a page that says everything is configured. A refused save is far easier
 * to diagnose, so the check is here rather than deferred to the first
 * summarisation.
 *
 * **The read and the write are one transaction.** `writeTransaction()` opens
 * `BEGIN IMMEDIATE`, so "is this provider enabled?" and "make it the active one"
 * cannot be separated by a concurrent save that disables it -- which is exactly
 * the ordering hazard this action exists inside. Reading first and updating
 * afterwards would leave a window in which a provider is activated on the
 * strength of a flag that no longer holds.
 *
 * `""` needs no check: switching AI off is always allowed, and it is the state a
 * fresh row starts in.
 *
 * ## What happens when an active provider *stops* working
 *
 * A provider can be made active and then have its credentials refused by a
 * re-probe, or removed outright. **The column is left holding its name, and
 * that is deliberate.** It records what the operator chose; `activeProvider()`
 * in `./queries` is what decides which provider is *reported* active, and it
 * answers `""` whenever the named provider's flag disagrees -- so a page never
 * shows a selection that cannot work, and phase 12's summariser asking the same
 * question gets the same answer.
 *
 * Clearing the column instead was written first and then removed, because the
 * derivation is strictly more forgiving and the cost of clearing is real.
 * OpenAI's `insufficient_quota` is classified `unauthorized` on purpose (see
 * `./openai`: routing it to `quota` would send it to the arm that writes
 * nothing, so an operator with an unpaid bill could never save a perfectly valid
 * key). That drives `judge()` into `bad`, which switches the flag off -- so an
 * unpaid bill on the active provider would have *permanently* erased the
 * selection. Pay the bill, re-save, the flag comes back true, and with the
 * derivation the provider is active again on its own; with a clear, the operator
 * has to re-pick something they never deselected, with nothing to tell them why.
 *
 * The other half of the argument is that clearing bought nothing: the state it
 * removed was already unobservable, because the read path derives either way.
 */
export async function setActiveProvider(key: string): Promise<AiResult> {
  const userId = await currentUserId();

  const provider = key === "" ? null : providerByKey(key);
  if (key !== "" && !provider) return { ok: false, errorKey: "unknownProvider" };

  let outcome: "written" | "disabled" | "missing";
  try {
    outcome = writeTransaction((tx) => {
      const row = tx.select().from(userSettings).where(eq(userSettings.userId, userId)).get();
      if (!row) return "missing" as const;
      if (provider && !row[AI_COLUMNS[provider.key].enabled]) return "disabled" as const;

      tx.update(userSettings)
        .set({ activeAiProvider: provider ? provider.key : "" })
        .where(eq(userSettings.userId, userId))
        .run();
      return "written" as const;
    });
  } catch (error) {
    // Logged, not returned: a driver message is not a catalog key either.
    console.error(`${LOG_PREFIX} failed to set the active provider`, error);
    return { ok: false, errorKey: "saveFailed" };
  }

  if (outcome === "missing") {
    // A provisioning bug, the same one `getSettings()` throws for. Reporting
    // success here would show a selection that a reload silently reverts.
    logMissingRow(userId);
    return { ok: false, errorKey: "saveFailed" };
  }
  if (outcome === "disabled") return { ok: false, errorKey: "activeNotVerified" };

  revalidatePath(AI_PATH);
  return { ok: true };
}

/**
 * The six global tuning values, **built from `AI_ADVANCED_BOUNDS` rather than
 * typed out here.**
 *
 * Every bound has a reason rather than a round number, and those reasons are in
 * `./bounds` beside the numbers themselves. They live there because the `/ai`
 * form puts the same bounds on its inputs as `min`/`max`: written twice, an edit
 * to one shipped a browser hint that disagreed with the server and no test could
 * see it. `integer` drives `.int()` here and `step` there -- the columns are
 * `integer`, and SQLite would store `2.5` in one without complaint.
 *
 * The pair rule below is the one thing that cannot live in that table, because
 * it is not a property of a single field.
 */
const advancedShape = Object.fromEntries(
  AI_ADVANCED_FIELDS.map((name) => {
    const { min, max, integer } = AI_ADVANCED_BOUNDS[name];
    const base = integer ? z.number().int() : z.number();
    return [name, base.min(min).max(max)];
  }),
  // `Object.fromEntries` widens to `{ [k: string]: … }` whatever the input tuple
  // was; the assertion is that loss undone, and `AI_ADVANCED_BOUNDS` being a
  // `Record<AiAdvancedField, …>` is what makes it true.
) as Record<AiAdvancedField, z.ZodNumber>;

const advancedInput = z.object(advancedShape);

/**
 * Which field failed, as a catalog key.
 *
 * Still two lookups rather than one, though only the fallback has a user
 * today: `field:code` is tried first so a future rule that lands two different
 * failures on one field can tell them apart, and the bare field name covers
 * `too_small`, `too_big` and a non-integer alike -- all three mean "that number
 * is not one this field accepts", and the message states the range. The one
 * `field:code` entry there used to be (`monthlyLimit:custom`) went with the
 * request caps.
 */
const ADVANCED_ERROR_KEYS: Record<string, AiKey> = {
  temperature: "advanced.temperatureRange",
  maxPromptLength: "advanced.maxPromptLengthRange",
  requestTimeout: "advanced.requestTimeoutRange",
  maxRetries: "advanced.maxRetriesRange",
  retryDelay: "advanced.retryDelayRange",
  requestDelay: "advanced.requestDelayRange",
};

function advancedErrorKey(issues: z.core.$ZodIssue[]): AiKey | undefined {
  const issue = issues[0];
  const field = issue?.path[0];
  if (typeof field !== "string") return undefined;
  return ADVANCED_ERROR_KEYS[`${field}:${issue.code}`] ?? ADVANCED_ERROR_KEYS[field];
}

/**
 * Save the six global tuning values.
 *
 * **The `ai` prefix the columns carry is dropped on the way in and out**
 * (`aiTemperature` -> `temperature`), and the two halves of that mapping are the
 * only two places it happens: here and `getAiStatus()` in `./queries`.
 */
export async function saveAdvanced(input: unknown): Promise<AiResult> {
  const parsed = advancedInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errorKey: advancedErrorKey(parsed.error.issues) ?? "saveFailed" };
  }
  const values = parsed.data;
  const userId = await currentUserId();

  let changes: number;
  try {
    changes = writeTransaction(
      (tx) =>
        tx
          .update(userSettings)
          .set({
            aiTemperature: values.temperature,
            aiMaxPromptLength: values.maxPromptLength,
            aiRequestTimeout: values.requestTimeout,
            aiMaxRetries: values.maxRetries,
            aiRetryDelay: values.retryDelay,
            aiRequestDelay: values.requestDelay,
            // `updatedAt` is deliberately not set: the schema's
            // `$onUpdate(() => new Date())` stamps it on every Drizzle write.
          })
          .where(eq(userSettings.userId, userId))
          .run().changes,
    );
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to write the AI settings`, error);
    return { ok: false, errorKey: "saveFailed" };
  }

  if (changes === 0) {
    logMissingRow(userId);
    return { ok: false, errorKey: "saveFailed" };
  }

  revalidatePath(AI_PATH);
  return { ok: true };
}

/** One entry OpenRouter's `/models` endpoint reports, normalized for the select. */
export type OpenrouterModelOption = { value: string; label: string };

export type OpenrouterModelsResult =
  { ok: true; models: OpenrouterModelOption[] } | { ok: false; errorKey: AiKey };

/** Every field this reads off one entry of OpenRouter's public `/models` response. */
type OpenrouterModelEntry = {
  id?: unknown;
  name?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
};

/**
 * The live OpenRouter model catalog, fetched on demand -- never cached, since
 * the refresh is button-triggered (see the design spec). The upstream endpoint
 * itself is public and unauthenticated -- no credential is sent to OpenRouter
 * and this is safe to call before any OpenRouter key has been saved -- but the
 * caller still has to be a signed-in Yana user, like every other export in
 * this file: without the `currentUserId()` gate below, an unauthenticated POST
 * to this server action would make the instance issue outbound requests to
 * `openrouter.ai` on a stranger's behalf.
 *
 * Every failure -- no session, network, timeout, a non-200, an unparseable
 * body -- collapses to one outcome. Unlike the credential probes' `unreachable`/
 * `timedOut`/`unexpected` catalog keys, this does **not** reuse them: those
 * are worded "...these credentials could not be verified," which is wrong
 * here -- no credential is involved in listing models.
 */
export async function listOpenrouterModels(): Promise<OpenrouterModelsResult> {
  try {
    // Same gate every other export here sits behind, just not via
    // `defineIntegrationIn()` (there is no credential and nothing to save).
    // `currentUserId()` throws -- including Next's own `redirect()` control
    // flow for "no session" -- rather than returning a falsy value, so it is
    // enough to call it and let this function's existing catch-all handle the
    // failure the same way it handles a network error.
    await currentUserId();

    const response = await fetch(`${OPENROUTER_API_URL}/models`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { ok: false, errorKey: "openrouter.modelsFetchFailed" };
    }
    const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
    if (!body || !Array.isArray(body.data)) {
      return { ok: false, errorKey: "openrouter.modelsFetchFailed" };
    }

    const entries: { value: string; label: string; isFree: boolean }[] = [];
    for (const entry of body.data as OpenrouterModelEntry[]) {
      if (typeof entry.id !== "string" || typeof entry.name !== "string") continue;
      const isFree = entry.pricing?.prompt === "0" && entry.pricing?.completion === "0";
      // OpenRouter's own vendor-supplied `name` sometimes already ends in
      // "(free)" (confirmed live, e.g. "NVIDIA: Nemotron 3 Ultra (free)") --
      // appending another suffix unconditionally produced a visible
      // double-labeled "... (free) (Free)". Checked case-insensitively because
      // the casing of OpenRouter's own suffix is not guaranteed either.
      const alreadyLabeledFree = /\(free\)$/i.test(entry.name);
      const label = isFree && !alreadyLabeledFree ? `${entry.name} (Free)` : entry.name;
      entries.push({ value: entry.id, label, isFree });
    }
    // Free entries first: a user hunting for a $0 model should not have to
    // scroll past hundreds of paid ones to find one. Sorted on the computed
    // boolean rather than re-derived from the label's text, so a name that
    // happens to end in "(Free)" without actually being free-priced (or one
    // that skipped the suffix above because it already carried its own) is
    // never misread as the other thing.
    entries.sort((a, b) => Number(b.isFree) - Number(a.isFree));

    if (entries.length === 0) {
      // An empty-but-well-formed catalog response is treated the same as a
      // fetch failure: "no models to show" and "couldn't load models" want the
      // same operator-facing message, and there is no separate catalog key for
      // "OpenRouter returned nothing."
      return { ok: false, errorKey: "openrouter.modelsFetchFailed" };
    }
    const models: OpenrouterModelOption[] = entries.map(({ value, label }) => ({ value, label }));
    return { ok: true, models };
  } catch {
    return { ok: false, errorKey: "openrouter.modelsFetchFailed" };
  }
}
