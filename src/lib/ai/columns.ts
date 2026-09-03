import type { UserSettings } from "@/lib/db/schema";
import type { FlagColumn, TextColumn } from "@/lib/integrations/define";

import { type AiProvider, type AiProviderKey, AI_PROVIDERS, providerByKey } from "./providers";

/**
 * The one `UserSettings`-shaped structural type `providerEnabled()`/
 * `activeProvider()` need -- `activeAiProvider` plus every provider's
 * `*Enabled` flag column -- rather than the full row.
 *
 * **Deliberately `Partial<UserSettings>`, not `UserSettings`.** `./queries`'s
 * `getAiStatus()` always has a full row (`getSettings()`'s return), but
 * `./run`'s `AIClient` -- the other caller, per the ruling that moved these two
 * functions here rather than having `run.ts` import `./queries` and drag
 * `getDb()` into its module graph -- is handed `Partial<UserSettings>`
 * (`AiRuntimeSettings`). A full `UserSettings` satisfies `Partial<UserSettings>`
 * trivially, so this widening costs the `/ai` call site nothing.
 */
type ActiveProviderSettings = Partial<UserSettings>;

/**
 * Which `user_settings` columns belong to which AI provider.
 *
 * **One table, read by both halves of the feature.** `./actions` builds three
 * `defineIntegration()` descriptors out of it and needs the flag column again to
 * keep `active_ai_provider` honest; `./queries` projects the same columns into
 * what the page renders. Written twice, a copy-paste slip between two providers
 * -- `anthropicApiKey` where `geminiApiKey` was meant -- is not a type error,
 * because every one of these columns is a `string`: it would quietly show one
 * provider's mask under another's heading, and quietly probe the wrong stored
 * key. That is exactly the class of drift `defineIntegrationIn()` exists to
 * remove, so the mapping is data in one place rather than spelled out in two.
 *
 * **It has to be a separate module** because `./actions` carries `"use server"`
 * and therefore cannot export a constant at all, and `./queries` is the wrong
 * home for something a descriptor is built from.
 *
 * The two imports are **type-only**, so nothing here reaches the browser bundle
 * even though `@/lib/integrations/define` pulls in Drizzle and `next/cache`:
 * `TextColumn` and `FlagColumn` are derived from `userSettings.$inferInsert`, so
 * a column renamed in `schema/users.ts` fails `npm run typecheck` at the entry
 * that names it rather than at a query.
 */
export type AiColumns = {
  enabled: FlagColumn;
  apiKey: TextColumn;
  model: TextColumn;
  /**
   * Present exactly where {@link AiProvider.hasCustomUrl} is `true` -- only
   * OpenAI has a column for a base URL, and the two facts are pinned against
   * each other in `columns.test.ts` rather than left to agree by inspection.
   */
  apiUrl?: TextColumn;
};

/**
 * `satisfies` rather than a type annotation, and the difference is load-bearing:
 * annotated `Record<AiProviderKey, AiColumns>`, `AI_COLUMNS.openai.apiUrl` would
 * be `TextColumn | undefined` and a descriptor could not name it without a
 * non-null assertion, while `AI_COLUMNS.anthropic.apiUrl` would silently be
 * `undefined` instead of a compile error. This way each entry keeps its own
 * shape -- OpenAI's base-URL column is a known literal, and reaching for one on
 * the other two does not typecheck -- while the record as a whole is still
 * checked against {@link AiColumns} and against `AiProviderKey`'s completeness.
 */
export const AI_COLUMNS = {
  openai: {
    enabled: "openaiEnabled",
    apiKey: "openaiApiKey",
    model: "openaiModel",
    apiUrl: "openaiApiUrl",
  },
  anthropic: {
    enabled: "anthropicEnabled",
    apiKey: "anthropicApiKey",
    model: "anthropicModel",
  },
  gemini: {
    enabled: "geminiEnabled",
    apiKey: "geminiApiKey",
    model: "geminiModel",
  },
  mistral: {
    enabled: "mistralEnabled",
    apiKey: "mistralApiKey",
    model: "mistralModel",
  },
  qwen: {
    enabled: "qwenEnabled",
    apiKey: "qwenApiKey",
    model: "qwenModel",
  },
  deepseek: {
    enabled: "deepseekEnabled",
    apiKey: "deepseekApiKey",
    model: "deepseekModel",
  },
  openrouter: {
    enabled: "openrouterEnabled",
    apiKey: "openrouterApiKey",
    model: "openrouterModel",
  },
} satisfies Record<AiProviderKey, AiColumns>;

/**
 * The stored model id, or the provider's default when the stored one is no
 * longer offered.
 *
 * **A stale id is the normal case, not an edge case.** Phase 2 seeded the
 * Django-era ids and migration `0003` only fixes the *defaults*; a row written
 * before it still holds `gpt-4o-mini`, and a model list refreshed next year will
 * strand ids written this year. Base UI's `<Select.Value>` resolves its label
 * from `items` alone and never reads `<Select.ItemText>` (CLAUDE.md), so an
 * unlisted value makes the collapsed trigger print the raw id while the open
 * popup looks perfect -- and a test that only opens the popup proves nothing.
 * Falling back here means the select always has a matching entry and the form
 * submits something the provider still serves.
 *
 * It deliberately does **not** write the fallback back to the row: a read path
 * that repairs data is the thing `getSettings()` is documented not to do, and
 * the next save persists the resolved value anyway.
 *
 * **The membership check is skipped entirely for a {@link AiProvider.hasDynamicModels}
 * provider whose stored value is non-empty -- OpenRouter, today.** For the
 * other six, `provider.models` *is* the whole valid set, so "not in the list"
 * really does mean "stale" and the fallback above is correct. OpenRouter's
 * `models` is not that: it is the two-entry static fallback shown before any
 * "Refresh models" press, never the full catalog (hundreds of ids, fetched live
 * by `listOpenrouterModels()` in `./actions`). Checking a live id against that
 * two-entry list would treat every real selection as unlisted -- an operator
 * saves `qwen/qwen3-coder:free`, the write genuinely lands in the column, and
 * the very next render of `/ai` calls this function and silently substitutes
 * `openrouter/free` back in, both mis-showing the picker and risking the next
 * Save overwriting the real stored value with the default. So for this
 * provider the stored value is trusted outright: it already passed the
 * permissive `openrouterModelField` schema (length only, no enum check) and a
 * live probe at save time, which is the validation the static-list check
 * performs for everyone else. An empty stored value is still not trusted --
 * that is a genuinely unconfigured row, not a dynamic id -- so it still falls
 * back to `provider.defaultModel`, the same as every other provider's empty
 * case.
 */
export function resolveModel(provider: AiProvider, stored: string): string {
  if (provider.hasDynamicModels) {
    return stored || provider.defaultModel;
  }
  return provider.models.some((model) => model.value === stored) ? stored : provider.defaultModel;
}

/** Every provider, paired with its columns -- the shape both halves iterate. */
export function providersWithColumns(): { provider: AiProvider; columns: AiColumns }[] {
  return AI_PROVIDERS.map((provider) => ({ provider, columns: AI_COLUMNS[provider.key] }));
}

/**
 * Is the provider this key names switched on in this row?
 *
 * **Moved here from `./queries`, by a human ruling, so `./run` can read it
 * without importing that module.** `./queries` reaches `getDb()` through
 * `getSettings()`, and `AIClient` (`./run`) must not drag that into its module
 * graph -- the same reason `plainTextOf()` was pulled out of
 * `blocks/parser.ts` into its own module, so `POST /api/v1/ai/prompt` stopped
 * pulling in cheerio for a function that never touches HTML. `providerEnabled()`
 * and `activeProvider()` below are pure row predicates with no session or
 * database dependency of their own, so moving them costs nothing; `./queries`
 * re-exports both so `/ai` and every existing caller is unchanged.
 */
export function providerEnabled(settings: ActiveProviderSettings, key: AiProviderKey): boolean {
  return Boolean(settings[AI_COLUMNS[key].enabled]);
}

/**
 * The provider AI actually runs on, or `""` for none.
 *
 * **Derived, not read straight out of the column, and this is the *only*
 * place that decision is made.** `active_ai_provider` is a preference; a
 * provider is only active if its probe-derived `*Enabled` flag agrees. Nothing
 * on the write side erases the preference when a flag goes false -- see
 * `setActiveProvider()` in `./actions` for why not, in short: OpenAI's unpaid
 * bill classifies as `unauthorized`, so clearing would permanently drop a
 * selection the operator never changed, and paying the bill would not bring it
 * back. Deriving here brings it back by itself.
 *
 * That also covers every route a write-side clear could not reach anyway: a
 * hand-edited database, an import, a later phase flipping a flag without going
 * through these actions, and a key the registry has since dropped. Same
 * argument `safeAvatarSrc()` rests on -- check the value you are about to
 * *use*, rather than trusting that every writer remembered.
 *
 * **`AIClient` (`./run`) routes through this too, not a bare truthiness read
 * of `activeAiProvider`.** It used to set its own provider from the raw
 * column, which agreed with this function everywhere except the one state
 * this function exists to handle -- a stored preference whose flag has since
 * gone false -- where the client dispatched anyway, hit the provider's own
 * `!enabled` guard, and reported `providerError` ("the provider failed") for a
 * request nothing ever sent, while `/ai` correctly showed no active provider.
 */
export function activeProvider(settings: ActiveProviderSettings): AiProviderKey | "" {
  const provider = providerByKey(settings.activeAiProvider ?? "");
  return provider && providerEnabled(settings, provider.key) ? provider.key : "";
}
