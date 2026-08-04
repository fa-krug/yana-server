import type { FlagColumn, TextColumn } from "@/lib/integrations/define";

import { type AiProvider, type AiProviderKey, AI_PROVIDERS } from "./providers";

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
 */
export function resolveModel(provider: AiProvider, stored: string): string {
  return provider.models.some((model) => model.value === stored) ? stored : provider.defaultModel;
}

/** Every provider, paired with its columns -- the shape both halves iterate. */
export function providersWithColumns(): { provider: AiProvider; columns: AiColumns }[] {
  return AI_PROVIDERS.map((provider) => ({ provider, columns: AI_COLUMNS[provider.key] }));
}
