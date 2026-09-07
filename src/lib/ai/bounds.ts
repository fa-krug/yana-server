/**
 * The five global tuning values: what they are called, in what order they are
 * shown, and what each one accepts.
 *
 * **This module imports nothing, for `./providers`' reason.** It is read by the
 * `/ai` form -- a client component -- and by `./actions`, which builds its zod
 * schema out of it. Anything reachable from here reaches the browser bundle.
 *
 * **It exists because the bounds were written twice.** The form spelled them out
 * as `min`/`max` on the number inputs and `advancedInput` in `./actions`
 * spelled the same bounds out again, with nothing keeping the two equal: an edit
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
 *
 * There used to be three more. `dailyLimit` and `monthlyLimit` capped how many
 * requests a user could make per UTC day and month; `maxTokens` capped one
 * answer's length. All three were removed on the owner's explicit instruction
 * -- switched on, AI is expected to run without a limit refusing it -- along
 * with the `ai_requests` table the first two counted against. Cost is
 * controlled by not making pointless requests (the aggregate handler's
 * `contentHash` skip) and by not asking for fields nothing needs (`wantsRewrite`
 * in `./run`), neither of which costs anything when the work *is* wanted.
 * They are also why the cross-field `.superRefine()` in `./actions` is gone:
 * `monthlyLimit >= dailyLimit` was the only rule about a pair.
 *
 * `maxTokens` is worth its own note, because it was not merely a ceiling
 * nobody wanted: it was a live hazard. Its default of 2000 was below what a
 * rewritten article needs, so a longer one came back truncated mid-JSON, failed
 * to parse, and spent the whole paid request on an `invalidJson` failure. A
 * correct value cannot be chosen in advance -- it is the length of an answer
 * nobody has seen yet -- so `./run` now sends no cap at all, except to
 * Anthropic, whose API declares the field required (see `ANTHROPIC_MAX_TOKENS`
 * there).
 * - **`requestTimeout` 5-600 s.** Below five seconds no provider ever answers,
 *   so every request would abort and every summary fail -- a setting that can
 *   only be wrong. Ten minutes is past any real completion.
 * - **`maxRetries` 0-10.** Zero is meaningful (do not retry). The ceiling used
 *   to be justified as "ten retries against a rate-limited provider is already
 *   an hour of `retryDelay`", which does not describe shipped behaviour twice
 *   over: `./run`'s back-off is *exponential* (`retryDelay * 2^attempt`, so ten
 *   of them at the maximum `retryDelay` of 60 s add up to
 *   60 x (2^0 + ... + 2^9) = 61,380 s, about seventeen hours, of which the last
 *   single wait is eight and a half -- not an hour, and not the "days" an
 *   earlier version of this comment overshot to), and above it sits an
 *   un-configurable 60-second budget -- `MAX_RETRY_TIME_SECONDS`
 *   there -- that refuses any wait which would carry the schedule past a
 *   minute. **The comment was the wrong half to keep, not the bound**, because
 *   that budget is only consulted when there is a wait to check: the guard is
 *   `waitSeconds > 0 && elapsed + waitSeconds > maxRetryTime`, so at
 *   `retryDelay = 0` -- a legal, meaningful value -- nothing bounds the loop
 *   except this number, and all ten retries really do run. Lowering it would
 *   also refuse a value an existing row may already hold, and `/ai` saves the
 *   whole card as one unit, so the next Save of any of the five would start
 *   failing until the user found the one that had gone out of range.
 * - **`retryDelay` 0-60 s** and **`requestDelay` 0-60 s.** Zero is meaningful
 *   for both -- no spacing at all -- and a minute between calls is as slow as a
 *   spacing setting can usefully be.
 */

/**
 * The five, in the order the form renders them.
 *
 * The names are the projection's, not the columns' -- `aiTemperature` ->
 * `temperature`. That renaming happens in `getAiStatus()` and in
 * `saveAdvanced()` and nowhere else.
 */
export const AI_ADVANCED_FIELDS = [
  "temperature",
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
  requestTimeout: { min: 5, max: 600, integer: true },
  maxRetries: { min: 0, max: 10, integer: true },
  retryDelay: { min: 0, max: 60, integer: true },
  requestDelay: { min: 0, max: 60, integer: true },
} as const satisfies Record<AiAdvancedField, AiBound>;
