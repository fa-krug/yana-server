"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentUserId } from "@/lib/auth/session";
import { writeTransaction } from "@/lib/db/client";
import { userSettings } from "@/lib/db/schema";
import { defineIntegrationIn, type IntegrationActions } from "@/lib/integrations/define";

import { AI_COLUMNS } from "./columns";
import { AI_PROBES } from "./probes";
import {
  OPENAI_DEFAULT_API_URL,
  providerByKey,
  type AiProvider,
  type AiProviderKey,
} from "./providers";
import type { AiKey, AiResult, AiSaveResult } from "./result";

/**
 * Everything `/ai` writes: three provider credentials, which provider is
 * active, and the nine global tuning values.
 *
 * **The three providers are a table, not three sequences.** Parse, load the row,
 * resolve each secret, guard the empty case, probe, log, judge, write -- all of
 * that lives once in `@/lib/integrations/define`, extracted in task R2 for
 * exactly this moment. What a provider *is* lives here as a declaration. Phase
 * 6's two credential cards plus these three is five, and the risk in five
 * near-twin sequences is not their length but the drift *between* them, which no
 * test of any one of them can see.
 *
 * Every rule the integrations actions live under applies here unchanged -- read
 * that file's header for them -- plus two this page adds:
 *
 * 1. **`quotaMeansVerified` is read from the registry, never typed in here.**
 *    The three providers genuinely disagree (`false`, `true`, `true`) and the
 *    reasoning lives beside the field in `./providers` and, duplicated on
 *    purpose, at each probe's 429 branch. A literal in this file would be a
 *    fourth copy able to drift from all three, which is the precise failure the
 *    field was made required to prevent.
 * 2. **`active_ai_provider` may never name a provider that is switched off.**
 *    It is a preference, and the flag is the permission; see
 *    {@link setActiveProvider} and {@link clearActiveIfDisabled} below.
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
  .refine((value) => value === "" || isHttpUrl(value))
  .transform((value) => value || OPENAI_DEFAULT_API_URL);

function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
}

/**
 * The registry entry for a provider key that is already known to be one.
 *
 * Unreachable in practice -- `providers.test.ts` pins `AI_PROVIDERS` to exactly
 * these three keys -- and it throws rather than substituting a default because
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
 * **`quota` is named per its arm, not per its cause**, which is why the three
 * spellings differ. For Anthropic and Gemini a rate limit is a *notice on a
 * success* -- the key was accepted, only the budget is gone -- so the key reads
 * "the key is valid, and…". For OpenAI the same cause lands in the arm that
 * writes nothing, because its base URL is an operator setting and a gateway can
 * shed load before reading the `Authorization` header, so the key reads "could
 * not be verified". Which arm each one lands in is `quotaMeansVerified` below,
 * read from the registry.
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
  // Keyed on `field:code`; a `.refine()` failure is zod's `custom`.
  fieldErrorKeys: {
    "model:custom": PROVIDER_KEYS.openai.modelUnknown,
    "apiUrl:custom": "openai.apiUrlInvalid",
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

const PROVIDER_ACTIONS: Record<AiProviderKey, IntegrationActions<AiKey>> = {
  openai,
  anthropic,
  gemini,
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
 * **Never let `active_ai_provider` name a provider that is switched off.**
 *
 * A provider can be made active and *then* stop working: a re-probe comes back
 * `unauthorized` and `judge()` writes the flag false, or the operator removes
 * the credentials outright. Left alone, the row would say "OpenAI is the active
 * provider" while also saying "OpenAI is not verified" -- and phase 12's
 * summariser would either run against a rejected key or, more likely, do nothing
 * at all while the page still showed a provider selected. That silent nothing is
 * the failure this page exists to make visible, so the state is not allowed to
 * exist.
 *
 * Called after **every** save and every removal, unconditionally: the `WHERE`
 * clause is the whole condition, so it is a no-op unless the row really does
 * name a provider whose flag is false. That also makes it self-healing for a row
 * that arrived dangling by some other route.
 *
 * **It is a second transaction, not part of the flag write, and that is a
 * deliberate limit.** The flag is written inside `@/lib/integrations/define`,
 * which knows nothing about an active provider and should not -- expressing this
 * atomically would mean a new field on the descriptor, which is a change to a
 * module `/integrations` shares (raised in this task's report rather than made).
 * What makes the gap harmless is that the read path derives too: `activeProvider()`
 * in `./queries` reports "none" for a row whose flag disagrees, so the
 * intermediate state is never *observable* even though it is briefly writable.
 * A failure here is logged and swallowed for the same reason -- the derivation
 * already covers it, and turning a successful credential save into a reported
 * failure would be the worse answer.
 */
function clearActiveIfDisabled(userId: string, key: AiProviderKey): void {
  try {
    writeTransaction((tx) =>
      tx
        .update(userSettings)
        .set({ activeAiProvider: "" })
        .where(
          and(
            eq(userSettings.userId, userId),
            eq(userSettings.activeAiProvider, key),
            eq(userSettings[AI_COLUMNS[key].enabled], false),
          ),
        )
        .run(),
    );
  } catch (error) {
    console.error(`${LOG_PREFIX} could not clear the active provider`, error);
  }
}

/**
 * Save one provider's credentials: probe first, then write what the verdict
 * allows.
 *
 * The whole sequence is `@/lib/integrations/define`'s; the only thing added here
 * is the active-provider repair, which runs after the write for the reason
 * above. It is safe after a `revalidatePath()` -- that marks the path dirty, and
 * the re-render happens after this action returns.
 */
export async function saveProvider(key: string, input: unknown): Promise<AiSaveResult> {
  const found = lookup(key);
  if (!found) return { ok: false, errorKey: "unknownProvider" };

  const result = await found.actions.save(input);
  clearActiveIfDisabled(await currentUserId(), found.provider.key);
  return result;
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
 */
export async function removeProvider(key: string): Promise<AiResult> {
  const found = lookup(key);
  if (!found) return { ok: false, errorKey: "unknownProvider" };

  const result = await found.actions.remove();
  clearActiveIfDisabled(await currentUserId(), found.provider.key);
  return result;
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
 * The nine global tuning values, and **every bound here has a reason rather than
 * a round number.**
 *
 * Unbounded, each of these surfaces to a user as an opaque aggregation failure
 * hours later -- a provider 400 inside a background job, with the summary simply
 * missing -- which is far harder to diagnose than a refused save. That is the
 * whole argument for validating them at the one place they are written.
 *
 * - **`temperature` 0-2.** Every supported provider refuses a higher value:
 *   OpenAI and Gemini document the range as 0-2, Anthropic as 0-1 (so 2 is
 *   already permissive). Below 0 is not a value any of them defines.
 * - **`maxTokens` 1-200000.** Zero is a *guaranteed* empty completion -- the
 *   call is made, billed for its input, and returns nothing. The ceiling is
 *   above every current model's output limit and is there so a typo cannot
 *   request a summary that costs more than the article.
 * - **`dailyLimit` 1-100000** and **`monthlyLimit` 1-100000.** A limit of zero
 *   disables AI while leaving the page saying it is on; `setActiveProvider()`
 *   is the honest way to switch it off.
 * - **`monthlyLimit` >= `dailyLimit`.** Below it the monthly cap is unreachable
 *   through the daily one and the daily limit never applies -- one of the two
 *   numbers is then decoration, and which one depends on an ordering nobody
 *   wrote down.
 * - **`maxPromptLength` 1-100000 characters.** Zero sends an empty article.
 * - **`requestTimeout` 5-600 s.** Below five seconds no provider ever answers,
 *   so every request would abort and every summary fail -- a setting that can
 *   only be wrong. Ten minutes is past any real completion.
 * - **`maxRetries` 0-10.** Zero is meaningful (do not retry); ten retries
 *   against a rate-limited provider is already an hour of `retryDelay`.
 * - **`retryDelay` 0-60 s** and **`requestDelay` 0-60 s.** Zero is meaningful
 *   for both -- no spacing at all -- and a minute between calls is as slow as a
 *   spacing setting can usefully be.
 *
 * `.int()` on everything except `temperature`: the columns are `integer`, and
 * SQLite would store `2.5` in one without complaint.
 */
const advancedInput = z
  .object({
    temperature: z.number().min(0).max(2),
    maxTokens: z.number().int().min(1).max(200_000),
    dailyLimit: z.number().int().min(1).max(100_000),
    monthlyLimit: z.number().int().min(1).max(100_000),
    maxPromptLength: z.number().int().min(1).max(100_000),
    requestTimeout: z.number().int().min(5).max(600),
    maxRetries: z.number().int().min(0).max(10),
    retryDelay: z.number().int().min(0).max(60),
    requestDelay: z.number().int().min(0).max(60),
  })
  .superRefine((values, ctx) => {
    if (values.monthlyLimit < values.dailyLimit) {
      ctx.addIssue({
        code: "custom",
        path: ["monthlyLimit"],
        // Never rendered: the catalog key below is what the caller is told. It
        // is here because zod requires a message, and an English one leaking to
        // a German UI is what `errorKey` exists to prevent.
        message: "monthlyLimit is below dailyLimit",
      });
    }
  });

/**
 * Which field failed, as a catalog key.
 *
 * Two lookups rather than one: the cross-field rule above and an ordinary range
 * failure both land on `monthlyLimit`, and they want different advice -- "at
 * least as large as the daily one" against "between 1 and 100000". So
 * `field:code` is tried first (a `.superRefine()` issue is zod's `custom`) and
 * the bare field name is the fallback, which covers `too_small`, `too_big` and
 * a non-integer alike: all three mean "that number is not one this field
 * accepts", and the message states the range.
 */
const ADVANCED_ERROR_KEYS: Record<string, AiKey> = {
  "monthlyLimit:custom": "advanced.monthlyBelowDaily",
  temperature: "advanced.temperatureRange",
  maxTokens: "advanced.maxTokensRange",
  dailyLimit: "advanced.dailyLimitRange",
  monthlyLimit: "advanced.monthlyLimitRange",
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
 * Save the nine global tuning values.
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
            aiMaxTokens: values.maxTokens,
            aiDefaultDailyLimit: values.dailyLimit,
            aiDefaultMonthlyLimit: values.monthlyLimit,
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
