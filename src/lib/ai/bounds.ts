/**
 * The nine global tuning values: what they are called, in what order they are
 * shown, and what each one accepts.
 *
 * **This module imports nothing, for `./providers`' reason.** It is read by the
 * `/ai` form -- a client component -- and by `./actions`, which builds its zod
 * schema out of it. Anything reachable from here reaches the browser bundle.
 *
 * **It exists because the bounds were written twice.** The form spelled them out
 * as `min`/`max` on nine number inputs and `advancedInput` in `./actions`
 * spelled the same nine out again, with nothing keeping the two equal: an edit
 * to one shipped a browser hint that disagreed with the server, and no test
 * could see it. The `"use server"` constraint that forces `AI_COLUMNS` into its
 * own module forces this one too -- `./actions` cannot export a constant at all
 * -- so a third module is the only place both halves can read.
 *
 * `integer` is here rather than derived, because it is the same fact the schema
 * needs (`.int()`, since the columns are `integer` and SQLite would store `2.5`
 * in one without complaint) and the input needs (`step`). Only `temperature` is
 * false.
 *
 * ## Every bound has a reason rather than a round number
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
 *   wrote down. **That one is not expressible here**: it is a rule about a pair,
 *   so it stays a `.superRefine()` in `./actions`, and it is why the form saves
 *   all nine as one unit.
 * - **`maxPromptLength` 1-100000 characters.** Zero sends an empty article.
 * - **`requestTimeout` 5-600 s.** Below five seconds no provider ever answers,
 *   so every request would abort and every summary fail -- a setting that can
 *   only be wrong. Ten minutes is past any real completion.
 * - **`maxRetries` 0-10.** Zero is meaningful (do not retry); ten retries
 *   against a rate-limited provider is already an hour of `retryDelay`.
 * - **`retryDelay` 0-60 s** and **`requestDelay` 0-60 s.** Zero is meaningful
 *   for both -- no spacing at all -- and a minute between calls is as slow as a
 *   spacing setting can usefully be.
 */

/**
 * The nine, in the order the form renders them.
 *
 * The names are the projection's, not the columns' -- `aiTemperature` ->
 * `temperature`. That renaming happens in `getAiStatus()` and in
 * `saveAdvanced()` and nowhere else.
 */
export const AI_ADVANCED_FIELDS = [
  "temperature",
  "maxTokens",
  "dailyLimit",
  "monthlyLimit",
  "maxPromptLength",
  "requestTimeout",
  "maxRetries",
  "retryDelay",
  "requestDelay",
] as const;

export type AiAdvancedField = (typeof AI_ADVANCED_FIELDS)[number];

export type AiBound = {
  min: number;
  max: number;
  /** Whether the column is an `integer` -- `.int()` server-side, `step={1}` in the form. */
  integer: boolean;
};

export const AI_ADVANCED_BOUNDS = {
  temperature: { min: 0, max: 2, integer: false },
  maxTokens: { min: 1, max: 200_000, integer: true },
  dailyLimit: { min: 1, max: 100_000, integer: true },
  monthlyLimit: { min: 1, max: 100_000, integer: true },
  maxPromptLength: { min: 1, max: 100_000, integer: true },
  requestTimeout: { min: 5, max: 600, integer: true },
  maxRetries: { min: 0, max: 10, integer: true },
  retryDelay: { min: 0, max: 60, integer: true },
  requestDelay: { min: 0, max: 60, integer: true },
} as const satisfies Record<AiAdvancedField, AiBound>;
