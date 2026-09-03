import { plainTextOf } from "@/lib/aggregators/blocks/plain-text";
import type { Block } from "@/lib/aggregators/blocks/types";
import type { UserSettings } from "@/lib/db/schema";

import { blocksToText, textToBlocks } from "./block-text";
import { AI_COLUMNS, activeProvider, resolveModel } from "./columns";
import type { AiProviderKey } from "./providers";
import {
  DEEPSEEK_API_URL,
  GEMINI_API_BASE_URL,
  MISTRAL_API_URL,
  OPENAI_DEFAULT_API_URL,
  OPENROUTER_API_URL,
  QWEN_API_URL,
  providerByKey,
} from "./providers";

/**
 * What `AIClient` and `applyAiToBlocks` accept for a user's AI configuration.
 *
 * `getSettings()`'s real row is `UserSettings` -- camelCase, one field per
 * column -- so `Partial<UserSettings>` covers every production caller:
 * `aggregate.ts`, `reload.ts` and `POST /api/v1/ai/prompt` all pass a full
 * Drizzle `UserSettings` row.
 *
 * **There used to be a parallel snake_case surface here too** -- every field
 * also readable under its snake_case column name
 * (`this.settings.aiMaxRetries ?? this.settings.ai_max_retries`), 29 fields and
 * 38 fallback chains, kept "for whatever *does* hand this a snake_case row."
 * Nothing does: every production caller reads a Drizzle row, camelCase by
 * construction, and the only object literals using the snake_case keys were
 * raw-SQL row assertions in tests (reading a column back from SQLite, not
 * constructing an `AiRuntimeSettings`). Deleted along with it:
 * `aiMaxRetryTime`/`ai_max_retry_time` had **no column in either spelling** --
 * see `MAX_RETRY_TIME_SECONDS` below for where that budget lives now.
 */
export type AiRuntimeSettings = Partial<UserSettings>;

/** The JSON body an AI provider's chat/completion endpoint is POSTed. */
export type AiRequestBody = Record<string, unknown>;

/**
 * Thrown by `requestWithRetry()` on a 401 or 403 from the provider -- the
 * credential itself was rejected, not a transient failure. Not retried (same
 * as every other non-429 status), and deliberately a distinct type from a
 * plain failure so `generateResponse()`'s catch can tell "the stored key is
 * bad" from "something else went wrong" without threading a status code
 * through every intermediate `callXxx()` method.
 */
export class ProviderUnauthorizedError extends Error {}

export type AiGenerationResult =
  | { ok: true; text: string }
  | { ok: false; reason: "noProvider" | "providerUnauthorized" | "providerError" };

/**
 * The `max_tokens` Anthropic's Messages API requires, since it is the one
 * provider here that will not accept a request without a ceiling. 16000 rather
 * than a model's full output limit because these requests are not streamed, and
 * a non-streaming request that asks for a very large answer can exceed the
 * API's own request timeout before any of it comes back. It is deliberately far
 * above the longest article this stage sends, so it is a safety limit and never
 * a truncation point.
 */
const ANTHROPIC_MAX_TOKENS = 16000;

/**
 * The fixed ceiling on how long `requestWithRetry()` will keep backing off a
 * 429 before giving up, in seconds.
 *
 * **A named constant, not a `user_settings` column, and that is a deliberate
 * ruling.** There is no `aiMaxRetryTime`/`ai_max_retry_time` column in either
 * spelling -- the setting-shaped surface that used to read one always fell
 * back to this same value, so the "setting" never actually varied. Adding a
 * column now would reverse the direction the rest of this module's tuning
 * values already went: the per-user request caps and `aiMaxTokens` were both
 * removed outright (see `generateResponse()`'s doc comment) on the owner's
 * explicit instruction that AI, once switched on, runs without knobs refusing
 * work. A seventh retry-budget knob would be exactly that kind of knob. `60` is
 * also the only value this has ever had in production: the Django original
 * this was ported from read it as `getattr(self.settings, "ai_max_retry_time",
 * 60)`, always falling through to the default.
 */
const MAX_RETRY_TIME_SECONDS = 60;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Mirrors `err?.message || err` for a caught value of unknown shape. */
function describeError(err: unknown): string {
  if (typeof err === "object" && err !== null && "message" in err) {
    const message = (err as Record<string, unknown>).message;
    if (typeof message === "string" && message) {
      return message;
    }
  }
  return String(err);
}

/**
 * Which request/response envelope a provider speaks. `AIClient.callProvider()`
 * switches on this to decide which method actually issues the call; the
 * `openai-compatible` five all end up in the one `callOpenaiCompatible()`
 * shared body, while `anthropic` and `gemini` keep methods of their own.
 */
type ProviderRequestShape = "openai-compatible" | "anthropic" | "gemini";

/**
 * One row per provider: where its request goes, and which envelope it speaks.
 *
 * **This is the table Task 4 exists to build.** Five of the seven `callXxx()`
 * methods this replaced were the same twelve-line shape -- read `enabled`,
 * read `apiKey`, warn-and-return, read `model`, read `timeout`, call
 * `callOpenaiCompatible` with a base URL -- differing only in which columns
 * and which constant URL they read. Declaring that difference as data here,
 * once, is what `AIClient.callProvider()` now reads instead of an
 * `if (this.provider === "openai") … else if …` chain of seven branches.
 *
 * `url` is a function only for OpenAI, whose base URL is the one
 * operator-configurable setting among the seven (`openaiApiUrl`); every other
 * provider's endpoint is the fixed constant from `./providers`.
 *
 * A plain type annotation, not `satisfies`, is enough here to make a missing
 * provider a compile error -- unlike `AI_COLUMNS` in `./columns`, no entry's
 * shape needs to differ from its neighbours' (there is no optional field the
 * way `apiUrl` is optional there), so there is nothing a wider inferred type
 * would lose.
 */
const PROVIDER_REQUESTS: Record<
  AiProviderKey,
  { url: string | ((settings: AiRuntimeSettings) => string); shape: ProviderRequestShape }
> = {
  openai: {
    // `?.trim() || DEFAULT`, matching `testOpenaiKey()` in `./openai` --
    // `??` alone does not catch an *empty* stored `openaiApiUrl` (an operator
    // who cleared the field rather than leaving it untouched), which would
    // otherwise send every request to `https://` with nothing after it.
    url: (settings) => settings.openaiApiUrl?.trim() || OPENAI_DEFAULT_API_URL,
    shape: "openai-compatible",
  },
  anthropic: { url: "https://api.anthropic.com/v1/messages", shape: "anthropic" },
  // `GEMINI_API_BASE_URL` is the *base* -- `callGemini()` appends
  // `/<model>:generateContent?key=<apiKey>` to whatever this resolves to. It
  // used to be a second, independent copy of the same host string
  // (`callGemini()` hardcoded it directly, and this table carried a third,
  // unread copy purely to satisfy the shared `{ url, shape }` shape) -- now
  // there is exactly one literal, in `./providers`, and both this table and
  // `./gemini`'s probe import it.
  gemini: { url: GEMINI_API_BASE_URL, shape: "gemini" },
  mistral: { url: MISTRAL_API_URL, shape: "openai-compatible" },
  qwen: { url: QWEN_API_URL, shape: "openai-compatible" },
  deepseek: { url: DEEPSEEK_API_URL, shape: "openai-compatible" },
  openrouter: { url: OPENROUTER_API_URL, shape: "openai-compatible" },
};

export class AIClient {
  private settings: AiRuntimeSettings;
  private provider: AiProviderKey | "";
  private onLog?: (message: string) => void;

  constructor(settings: AiRuntimeSettings, onLog?: (message: string) => void) {
    this.settings = settings || {};
    // **Routed through `activeProvider()`, not the raw `activeAiProvider`
    // column.** That function (`./columns`, re-exported from `./queries` for
    // `/ai` and `POST /api/v1/ai/prompt`) is documented as "the *only* place
    // this decision is made" -- it requires the provider's own probe-derived
    // `*Enabled` flag to agree with the stored preference, which a bare
    // truthiness read on the column does not. Without this, a re-probe that
    // classified a key `unauthorized`, or an operator pressing Remove -- both
    // of which deliberately leave `activeAiProvider` in place -- left `/ai`
    // correctly reporting no active provider while this client still passed
    // its guard, dispatched, hit the provider's own `!enabled` check and
    // reported `providerError`: "the provider failed" for a request that was
    // never sent.
    this.provider = activeProvider(this.settings);
    this.onLog = onLog;
  }

  /** Every AI-side failure/retry goes through here so it reaches both the
   * server log and (when set) the triggering job's own output -- otherwise a
   * provider rate limit or outage was indistinguishable from AI silently
   * doing nothing. */
  private warn(message: string): void {
    console.warn(message);
    this.onLog?.(message);
  }

  private async requestWithRetry(
    url: string,
    headers: Record<string, string>,
    data: AiRequestBody,
    timeoutSeconds: number,
  ): Promise<Response | null> {
    const maxRetries = this.settings.aiMaxRetries ?? 3;
    const retryDelay = this.settings.aiRetryDelay ?? 2;
    const maxRetryTime = MAX_RETRY_TIME_SECONDS;

    const startTime = Date.now();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(data),
          // Same reasoning as the probe's fetch in `openai.ts`: `url` can carry
          // an operator-supplied `openaiApiUrl`, and `fetch`'s default
          // `redirect: "follow"` would let a malicious gateway redirect this
          // call past whatever host validation exists. No real provider
          // endpoint redirects a POST.
          redirect: "error",
          // `AbortSignal.timeout()`, as every probe already does, rather than
          // a hand-rolled `AbortController` + `setTimeout` pair. That
          // combination had two problems: `clearTimeout` was skipped whenever
          // `fetch` threw, leaving an armed timer behind on every failed
          // attempt, and it only ever bounded the headers -- `clearTimeout`
          // fired the moment `fetch()` resolved, before any of the three
          // `callXxx()` shapes calls `response.json()`, so a provider that
          // sent headers and then stalled the body could hang the job
          // indefinitely. A self-cleaning, self-expiring signal fixes both:
          // nothing to leak on a throw, and the deadline still covers the
          // body, since aborting the signal after `fetch()` resolves but
          // before the body is fully read aborts that read too.
          signal: AbortSignal.timeout(timeoutSeconds * 1000),
        });

        if (response.ok) {
          return response;
        }

        if (response.status === 429 && attempt < maxRetries) {
          const waitSeconds = retryDelay ? retryDelay * Math.pow(2, attempt) : 0;
          const elapsedSeconds = (Date.now() - startTime) / 1000;

          if (waitSeconds > 0 && elapsedSeconds + waitSeconds > maxRetryTime) {
            this.warn(
              `Rate limited (429), but retrying would exceed time budget (${Math.round(
                elapsedSeconds,
              )}s elapsed, ${waitSeconds}s wait, ${maxRetryTime}s max). Giving up.`,
            );
            return null;
          }

          this.warn(
            `Rate limited (429), retrying in ${waitSeconds}s (attempt ${attempt + 1}/${maxRetries})`,
          );

          if (waitSeconds > 0) {
            await sleep(waitSeconds * 1000);
          }
          continue;
        }

        if (response.status === 401 || response.status === 403) {
          throw new ProviderUnauthorizedError(
            `AI provider rejected the credentials (status ${response.status}).`,
          );
        }

        this.warn(`AI API call failed with status ${response.status}: ${response.statusText}`);
        return null;
      } catch (err: unknown) {
        if (err instanceof ProviderUnauthorizedError) throw err;

        // **No caught-error 429 branch here**, unlike the response-status one
        // above. A `fetch()` rejection is a `TypeError` (undici's
        // `"fetch failed"`, carrying the real transport cause) or a
        // `DOMException` from `AbortSignal.timeout()` firing -- neither ever
        // carries a `.status`, which only exists on a `Response`, and a
        // response with a status is the `response.ok`/`response.status`
        // branch above, never this `catch`. There is therefore no rejection
        // shape that reaches here with `.status === 429`; the code that used
        // to check for one was a literal port of Python `requests`'
        // `raise_for_status()` idiom, where a non-2xx response *is* a raised
        // exception carrying `.response.status_code` -- a shape `fetch`
        // does not share.
        this.warn(`AI API request error: ${describeError(err)}`);
        return null;
      }
    }

    return null;
  }

  /**
   * **There is no request cap in front of this, by design.** A per-user
   * daily/monthly counter used to gate every call here, and it was removed on
   * the owner's explicit instruction: when AI is switched on it is expected to
   * run without a quota refusing it. Cost control is the caller's job instead,
   * and it is structural rather than a ceiling -- `handleAggregateJob()`'s
   * `contentHash` comparison never reaches this for an article the feed already
   * has unchanged, and `applyAiToBlocks()` below asks only for the fields the
   * feed's options actually need. A cap only ever refused work that had already
   * been decided to be worth doing; not asking in the first place costs
   * nothing.
   *
   * The same reasoning removed `aiMaxTokens`, and that one was worse than a
   * ceiling nobody wanted: guessed low it truncated the JSON envelope this
   * stage asks for, so the whole paid request was spent on an unparseable
   * answer. Every provider branch below now sends no output cap at all, except
   * Anthropic's, whose API requires the field (`ANTHROPIC_MAX_TOKENS`).
   *
   * Do not reintroduce either without that decision being revisited.
   */
  public async generateResponse(
    prompt: string,
    jsonMode = false,
    jsonSchema?: Record<string, unknown>,
  ): Promise<AiGenerationResult> {
    const provider = this.provider;
    if (!provider) {
      this.warn("No AI provider selected.");
      return { ok: false, reason: "noProvider" };
    }

    try {
      const text = await this.callProvider(provider, prompt, jsonMode, jsonSchema);
      return text === null ? { ok: false, reason: "providerError" } : { ok: true, text };
    } catch (e: unknown) {
      if (e instanceof ProviderUnauthorizedError) {
        this.warn(`AI provider rejected the stored credentials: ${describeError(e)}`);
        return { ok: false, reason: "providerUnauthorized" };
      }
      this.warn(`AI API call failed: ${describeError(e)}`);
      return { ok: false, reason: "providerError" };
    }
  }

  /**
   * Dispatches to the one provider `generateResponse()` already confirmed is
   * active, reading everything provider-specific -- its enabled flag, its
   * credential column, its model column, and which request URL and envelope
   * it uses -- out of {@link PROVIDER_REQUESTS} and `AI_COLUMNS`
   * (`./columns`) rather than out of seven near-identical methods.
   *
   * **Anthropic and Gemini keep their own request/response envelopes**
   * (`callAnthropic`/`callGemini`, below) -- neither speaks the shared
   * `/chat/completions` shape -- but both read their column names and base
   * URL from this same table, so a provider cannot end up with its enabled
   * flag checked against one column and its API key against another's.
   */
  private async callProvider(
    key: AiProviderKey,
    prompt: string,
    jsonMode: boolean,
    jsonSchema?: Record<string, unknown>,
  ): Promise<string | null> {
    const provider = providerByKey(key);
    const entry = PROVIDER_REQUESTS[key];
    if (!provider || !entry) {
      this.warn(`Unknown AI provider: ${key}`);
      return null;
    }

    const columns = AI_COLUMNS[key];
    const enabled = Boolean(this.settings[columns.enabled]);
    const apiKey = this.settings[columns.apiKey];
    if (!enabled || !apiKey) {
      this.warn(`${provider.label} is not enabled or configured.`);
      return null;
    }

    const model = resolveModel(provider, this.settings[columns.model] ?? "");
    const timeout = this.settings.aiRequestTimeout ?? 30;
    // Resolved once, not once per branch: every shape reads its base URL
    // from this same `entry.url`, whether that entry is a fixed string
    // (every provider but OpenAI) or a function of the settings (OpenAI's
    // operator-configurable `openaiApiUrl`).
    const baseUrl = typeof entry.url === "function" ? entry.url(this.settings) : entry.url;

    switch (entry.shape) {
      case "anthropic":
        return this.callAnthropic(baseUrl, apiKey, model, prompt, timeout);
      case "gemini":
        return this.callGemini(baseUrl, apiKey, model, prompt, jsonMode, jsonSchema, timeout);
      case "openai-compatible":
        return this.callOpenaiCompatible(baseUrl, apiKey, model, prompt, jsonMode, timeout);
    }
  }

  /**
   * The `/chat/completions` request/response shape every OpenAI-compatible
   * provider shares -- OpenAI itself, plus Mistral, Qwen, DeepSeek and
   * OpenRouter, all five routed here by {@link callProvider} through
   * {@link PROVIDER_REQUESTS}.
   */
  private async callOpenaiCompatible(
    baseUrl: string,
    apiKey: string,
    model: string,
    prompt: string,
    jsonMode: boolean,
    timeout: number,
  ): Promise<string | null> {
    const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const temperature = this.settings.aiTemperature ?? 0.7;

    // No `max_tokens`. Every OpenAI-compatible provider treats it as optional
    // and defaults to "as much as the model can answer with", which is the
    // only correct ceiling for a request whose output length is the article's
    // length: the setting this replaced defaulted to 1000, and the moment the
    // stage asked for a rewritten document back, a longer article came back
    // truncated mid-JSON, failed to parse, and the whole paid request was
    // spent on an `invalidJson` failure. A cap cannot be set correctly here
    // without knowing the answer's length in advance, so none is sent.
    const data: AiRequestBody = {
      model,
      messages: [{ role: "user", content: prompt }],
      temperature,
    };
    if (jsonMode) {
      data.response_format = { type: "json_object" };
    }

    const response = await this.requestWithRetry(url, headers, data, timeout);
    if (!response) return null;
    const result = await response.json();
    return result?.choices?.[0]?.message?.content ?? null;
  }

  /** Anthropic's Messages API envelope -- distinct from every other provider's. */
  private async callAnthropic(
    url: string,
    apiKey: string,
    model: string,
    prompt: string,
    timeout: number,
  ): Promise<string | null> {
    const headers = {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };

    const temperature = this.settings.aiTemperature ?? 0.7;

    const data = {
      model,
      messages: [{ role: "user", content: prompt }],
      // The one provider that cannot be sent without a ceiling: Anthropic's
      // Messages API declares `max_tokens` **required**, so unlike every
      // OpenAI-compatible branch and Gemini's -- which simply omit theirs --
      // this one has to name a number. It is a constant rather than a setting
      // for the reason the setting was removed: an operator cannot know an
      // article's answer length in advance, and guessing low truncates the
      // JSON envelope and wastes the whole request.
      max_tokens: ANTHROPIC_MAX_TOKENS,
      temperature,
    };

    const response = await this.requestWithRetry(url, headers, data, timeout);
    if (!response) return null;
    const result = await response.json();
    return result?.content?.[0]?.text ?? null;
  }

  /**
   * Gemini's `generateContent` envelope -- distinct from every other
   * provider's. `baseUrl` is `entry.url` resolved by `callProvider()`
   * (`GEMINI_API_BASE_URL` from `./providers`), not a second, independently
   * hardcoded copy of the host -- that duplication (this method, the table
   * entry, and the characterisation test all carrying their own copy of the
   * same string) is exactly the class of drift Task 4 exists to remove.
   */
  private async callGemini(
    baseUrl: string,
    apiKey: string,
    model: string,
    prompt: string,
    jsonMode: boolean,
    jsonSchema: Record<string, unknown> | undefined,
    timeout: number,
  ): Promise<string | null> {
    const url = `${baseUrl}/${model}:generateContent?key=${apiKey}`;
    const headers = {
      "Content-Type": "application/json",
    };

    const temperature = this.settings.aiTemperature ?? 0.7;

    // No `maxOutputTokens`, for the reason spelled out in
    // `callOpenaiCompatible()`: omitted, Gemini answers up to the model's own
    // output limit, which is the only ceiling that cannot truncate a document
    // this stage asked for in full.
    const generationConfig: Record<string, unknown> = {
      temperature,
    };

    if (jsonMode) {
      generationConfig.responseMimeType = "application/json";
      if (jsonSchema) {
        generationConfig.responseSchema = jsonSchema;
      }
    }

    const data = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig,
    };

    const response = await this.requestWithRetry(url, headers, data, timeout);
    if (!response) return null;
    const result = await response.json();
    const text = result?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text === undefined) {
      this.warn(`Unexpected Gemini response format: ${JSON.stringify(result)}`);
      return null;
    }
    return text;
  }
}

/**
 * What the AI stage actually did, distinct from the block tree it returns -- a
 * caller that asked for AI processing (a feed's
 * summarize/improve-writing/translate options) and didn't get it needs to be
 * able to tell that apart from "no AI options were configured at all," which
 * is a normal, silent no-op rather than a failure.
 *
 * **`degraded` is a fourth arm, not a footnote on `failed`.** `failed` means
 * `blocks`/`title` on the result are `input` verbatim -- every `unchanged()`
 * return below is exactly that. `missingSummary` breaks that rule on purpose
 * when a rewrite was also requested and *did* come back (see the doc comment
 * where it is returned): the tree is a genuine, applied rewrite, just missing
 * the summary the feed also asked for. That distinction used to live only in
 * a comment, which is exactly why the two callers disagreed about it --
 * `aggregate.ts` discarded the kept rewrite along with every real failure, and
 * `reload.ts` wrote it and then failed the job over the one missing field,
 * mailing the owner a failure notice for a run that was mostly a success.
 * `degraded` makes the distinction something a caller has to handle rather
 * than infer: treat it as a stored, successful write with a caveat, never as
 * the "write nothing at all" case `failed` is.
 */
export type ApplyAiOutcome =
  | { status: "skipped" }
  | { status: "applied" }
  | { status: "degraded"; reason: string }
  | { status: "failed"; reason: string };

/**
 * The notation spec the model is given, once per request.
 *
 * Short on purpose: it is paid for on every article, and every line of it is a
 * rule the parser actually enforces. `[[M<n>]]` and `(L<n>)` are the two that
 * matter most -- they are the reason a rewrite cannot corrupt an image ref, an
 * embed, a line of code or a URL, because none of those is in the document to
 * corrupt.
 */
const NOTATION_SPEC = [
  "The document uses this notation. Answer in the same notation, and nothing else:",
  "- A blank line separates blocks.",
  '- "# " to "###### " begin a heading. "- " begins a list item, "1. " an ordered one. "> " begins a quoted line.',
  "- Inline styles are <b>bold</b>, <i>italic</i>, <s>struck</s>, <code>code</code>.",
  '- "[label](L3)" is a link. Rewrite the label, never the "(L3)", and never invent an index.',
  '- "[[M7]]" stands for an image, video, embed or code block. Reproduce every one of them exactly, on its own line. You may move them; never edit, duplicate or drop one.',
  "- A backslash escapes the character after it.",
].join("\n");

/** A tolerant read of a model's JSON answer: bare, fenced, or embedded. */
function parseJsonAnswer(raw: string): Record<string, unknown> | null {
  const attempt = (text: string): Record<string, unknown> | null => {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "object" && value !== null
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };

  const direct = attempt(raw);
  if (direct) return direct;

  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(raw);
  if (fenced) {
    const parsed = attempt(fenced[1]);
    if (parsed) return parsed;
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return attempt(raw.substring(start, end + 1));
  }
  return null;
}

/** The article's lead media: block 0, when it is an image or an embed. */
function leadMediaOf(blocks: Block[]): Block | null {
  const first = blocks[0];
  return first && (first.kind === "image" || first.kind === "embed") ? first : null;
}

/**
 * Whether two opaque blocks are the same piece of media, **by content rather
 * than by reference**.
 *
 * The distinction is the whole point. `textToBlocks()` returns the *same object*
 * for an embed but a **fresh** one for an image, because an image's caption is
 * prose a rewrite may have changed (`{ ...block, caption }` in `./block-text`).
 * So an identity test -- which is what this used to do -- was always false for
 * an image: the lead was prepended *and* the model's copy stayed, and every AI
 * rewrite of an article with a lead image stored that image twice. Reproduced
 * against the real module (one image in, two out) before this existed, and
 * missed by the three lead-media tests because each asserted only `blocks[0]`.
 */
function sameMedia(a: Block, b: Block): boolean {
  if (a.kind === "image" && b.kind === "image") return a.ref === b.ref;
  if (a.kind === "embed" && b.kind === "embed") {
    return a.externalUrl === b.externalUrl && a.thumbnailRef === b.thumbnailRef;
  }
  return false;
}

/**
 * Put the article's lead media back at index 0, exactly once.
 *
 * Restructuring is prose freedom, not licence to move the article's thumbnail:
 * clients hoist block 0 when it is an image (`ArticleBlockView.leadImageRef`),
 * so a relocated, dropped **or duplicated** lead image silently changes what a
 * timeline shows. Every case collapses to the same rule -- drop every copy the
 * answer contains, then prepend the one from the input -- which is also why a
 * model that emits `[[M0]]` twice cannot produce two lead images.
 *
 * The *input's* block is the one kept, not the answer's: only the input's is
 * guaranteed to carry the ref this article actually stores.
 */
function pinLeadMedia(lead: Block, blocks: Block[]): Block[] {
  return [lead, ...blocks.filter((block) => !sameMedia(block, lead))];
}

/**
 * Turn the model's summary prose into the `summary` block, placed after the
 * lead media when there is one and first otherwise.
 *
 * The prose is split on blank lines into paragraphs *inside* the one block --
 * the shape `SummaryBlock` exists for, so a two-paragraph answer does not push
 * the article down the document.
 */
function withSummary(blocks: Block[], summary: string): Block[] {
  const paragraphs = summary
    .split(/\n\s*\n|\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return blocks;

  const block: Block = {
    kind: "summary",
    blocks: paragraphs.map((text) => ({
      kind: "paragraph" as const,
      runs: [{ text, bold: false, italic: false, code: false, strikethrough: false, link: "" }],
    })),
  };

  const at = leadMediaOf(blocks) ? 1 : 0;
  return [...blocks.slice(0, at), block, ...blocks.slice(at)];
}

/** What the AI stage was given, and what it hands back. */
export interface AiBlockDocument {
  title: string;
  blocks: Block[];
}

export interface AiBlockResult extends AiBlockDocument {
  outcome: ApplyAiOutcome;
  /**
   * Whether a provider request was actually issued.
   *
   * The caller paces its inter-request delay on this rather than on "did this
   * article reach the stage": three arms return without touching the network
   * (no AI options, no active provider, an article with no blocks), and pacing
   * on article count slept two seconds before each of them -- ~100s per run on
   * a 50-article feed whose provider was simply not configured.
   */
  requested: boolean;
  /**
   * Whether the model dropped a media/code placeholder from the rewrite
   * (`textToBlocks()`'s `droppedOpaque`). `false` on every arm that returns
   * `input.blocks` untouched, and on a summarize-only request, which never
   * serializes the document at all.
   *
   * This is what `handleAggregateJob()` reads to withhold the `contentHash`
   * write even though the article and its (possibly degraded) blocks are
   * still stored: the hash is a fingerprint of the unchanged *source*, so
   * writing it here would make the next cycle match, skip, and leave the
   * dropped media gone for the life of that source article. Withholding it
   * costs a retry (and, if the model drops the same media reliably, a
   * recurring provider request on every cycle) rather than a permanent loss.
   */
  droppedMedia: boolean;
}

/**
 * Run a feed's AI options over an article's **block tree**, not its HTML.
 *
 * The block tree is what gets stored -- there is no `articles.content` column
 * -- so this is the format the stage should always have worked in.
 * `blocksToText()` (`./block-text`) renders it as compact prose in which every
 * URL and every non-prose block is an opaque index, and `textToBlocks()` reads
 * the answer back. Three things follow, and each was a real failure mode of the
 * HTML round trip this replaces:
 *
 * - **The model can restructure.** Merging, splitting and reordering blocks is
 *   allowed and expected for an improve-writing request, because the answer is
 *   read on its own terms rather than checked against the shape that went out.
 *   The HTML form forbade it in the prompt ("the exact same structure as the
 *   input") and had no way to enforce it.
 * - **It cannot damage what it cannot see.** An image ref, an embed, a line of
 *   code and every URL are indices, so a rewrite cannot alter one, and a
 *   truncated answer cannot produce unparseable markup -- the parser is total.
 * - **It costs a fraction as much.** Measured on real pages, the document is
 *   12-19% the size of the HTML it replaces, in *and* out.
 *
 * **The lead media stays the lead media.** Restructuring is prose freedom, not
 * licence to move the article's thumbnail: clients hoist block 0 when it is an
 * image (`ArticleBlockView.leadImageRef`), so an image the model relocated or
 * dropped would silently change what a timeline shows. If the input led with
 * one, the output does too.
 */
/**
 * Whether a feed's options ask for AI at all.
 *
 * Exported because `handleAggregateJob()` needs the same answer to pace its
 * inter-request delay, and it used to carry its own copy -- under a comment
 * asserting there was no second copy to drift from. The two already disagreed:
 * a custom prompt of only whitespace is truthy there and `.trim()`-empty here,
 * so the handler slept `aiRequestDelay` per article for requests it never made.
 */
export function wantsAi(options?: Record<string, unknown> | null): boolean {
  const opts = options ?? {};
  return Boolean(
    opts.ai_summarize ||
    opts.ai_improve_writing ||
    opts.ai_translate ||
    (opts.ai_custom_prompt &&
      typeof opts.ai_custom_prompt_text === "string" &&
      opts.ai_custom_prompt_text.trim()),
  );
}

export async function applyAiToBlocks(
  input: AiBlockDocument,
  options?: Record<string, unknown> | null,
  userSettings?: AiRuntimeSettings,
  onLog?: (message: string) => void,
): Promise<AiBlockResult> {
  const unchanged = (outcome: ApplyAiOutcome, requested = false): AiBlockResult => ({
    ...input,
    outcome,
    requested,
    droppedMedia: false,
  });

  const opts = options || {};
  /**
   * The feed's own extra instruction (`ai_custom_prompt` +
   * `ai_custom_prompt_text` in `src/lib/aggregators/specs.ts`). Both halves are
   * required: a checked box with empty text is a no-op rather than a failure,
   * the same as an unchecked one, because there is nothing to ask the provider.
   */
  const customPrompt =
    opts.ai_custom_prompt && typeof opts.ai_custom_prompt_text === "string"
      ? opts.ai_custom_prompt_text.trim()
      : "";
  const wantsSummary = Boolean(opts.ai_summarize);
  /**
   * Whether the article body has to come back at all. Only three options
   * rewrite it -- improve-writing, translate, and a custom instruction, which
   * is free-form and so has to be assumed to. `ai_summarize` alone needs
   * nothing but the summary, so it sends plain text and gets three sentences
   * back rather than paying for a copy of a document we already hold.
   */
  const wantsRewrite = Boolean(opts.ai_improve_writing || opts.ai_translate || customPrompt);

  /** What this feed asked for, for the log line on the applied path below. */
  const asked = [
    opts.ai_summarize ? "summarize" : null,
    opts.ai_improve_writing ? "improve" : null,
    opts.ai_translate ? "translate" : null,
    customPrompt ? "custom" : null,
  ].filter((label): label is string => label !== null);

  if (!wantsSummary && !wantsRewrite) {
    return unchanged({ status: "skipped" });
  }

  if (!userSettings) {
    console.warn("No userSettings provided for AI processing.");
    return unchanged({ status: "failed", reason: "noProvider" });
  }
  // Routed through `activeProvider()`, the same function `AIClient`'s
  // constructor now uses, rather than a bare truthiness read of
  // `activeAiProvider` -- the raw column agrees with this function everywhere
  // except the one state it exists to catch: a stored preference whose
  // provider has since been probed as unauthorized, or explicitly removed
  // (both leave the preference in place, see `activeProvider()`'s doc comment
  // in `./columns`). In that state the raw-column check here used to pass
  // (the column is still truthy), `AIClient` would dispatch anyway and hit
  // the provider's own `!enabled` guard, and the article was reported
  // `{ status: "failed", reason: "providerError" }` -- "the provider failed"
  // for a request that never left this process, one layer above the
  // identical bug in `AIClient` itself.
  if (!activeProvider(userSettings)) {
    console.warn("No active AI provider selected.");
    return unchanged({ status: "failed", reason: "noProvider" });
  }
  if (input.blocks.length === 0) {
    return unchanged({ status: "skipped" });
  }

  const client = new AIClient(userSettings, onLog);
  const document = blocksToText(input.blocks);

  const promptParts: string[] = [];
  const responseKeys = [
    ...(wantsRewrite ? ["'title'", "'document'"] : []),
    ...(wantsSummary ? ["'summary'"] : []),
  ];

  promptParts.push(
    "You are an AI assistant that processes article content. " +
      `You must answer with a JSON object with ${responseKeys.length > 1 ? "keys" : "the key"} ` +
      responseKeys.join(" and ") +
      ". Do not wrap it in markdown fences; return the raw JSON.",
  );

  if (wantsSummary) {
    promptParts.push(
      "Write a concise summary of the article, 2-3 sentences, into the 'summary' field. " +
        "Plain prose only: no notation, no markdown, no leading label." +
        (wantsRewrite ? "" : " Return the summary only; do not reproduce the article."),
    );
  }

  if (wantsRewrite) {
    promptParts.push(NOTATION_SPEC);

    if (opts.ai_improve_writing) {
      promptParts.push(
        "Rewrite the document to improve clarity, flow and style. " +
          "You may merge, split and reorder blocks where that reads better -- the structure is " +
          "yours to change. Keep every link label meaningful and keep every [[M...]] placeholder.",
      );
    }

    if (opts.ai_translate) {
      const targetLang =
        typeof opts.ai_translate_language === "string" ? opts.ai_translate_language : "English";
      // Spelled out to the point of redundancy, and every clause is here
      // because the short version ("Translate the title and document to X")
      // produced answers that translated the title and handed the document
      // back untouched -- reported by a user for a Reddit article, whose
      // document is long and mostly quoted comments, which is exactly the
      // shape a model shortcuts on. The notation spec above is seven lines of
      // "keep this exactly", so the one line asking for a *changed* document
      // has to say so unmistakably, and has to name the parts a model
      // otherwise skips: a quoted line looks like a citation to leave alone.
      promptParts.push(
        `Translate the title${wantsSummary ? ", the summary" : ""} and the whole document into ` +
          `${targetLang}. Every line of the document must come back in ${targetLang}: headings, ` +
          "list items, quoted lines and image captions included. Translate link labels too, but " +
          "never the (L...) index inside them, and never the [[M...]] placeholders. Returning " +
          "the document in its original language is not an acceptable answer.",
      );
    }

    if (customPrompt) {
      // Delimited and labelled as the user's own text, and placed before the
      // closing contract below: the JSON/notation shape the parser depends on
      // has to be the final word, or a custom prompt (deliberately or not)
      // reshapes the output into something unreadable.
      promptParts.push(
        "The user of this feed has supplied the following additional instruction. " +
          "Follow it where it does not conflict with the output format required below:\n" +
          `"""\n${customPrompt}\n"""`,
      );
    }

    promptParts.push(
      "Put the rewritten document in the 'document' field, in the notation described above, " +
        "and the article title in 'title'.",
    );
  }

  const payload = wantsRewrite
    ? { title: input.title, document: document.text }
    : { title: input.title, text: plainTextOf(input.blocks) };

  const jsonSchema = {
    type: "OBJECT",
    properties: {
      ...(wantsRewrite ? { title: { type: "STRING" }, document: { type: "STRING" } } : {}),
      ...(wantsSummary ? { summary: { type: "STRING" } } : {}),
    },
    required: [
      ...(wantsRewrite ? ["title", "document"] : []),
      ...(wantsSummary ? ["summary"] : []),
    ],
  };

  const generation = await client.generateResponse(
    promptParts.join("\n") + "\n\nInput:\n" + JSON.stringify(payload),
    true,
    jsonSchema,
  );

  if (!generation.ok) {
    const message = `AI processing failed for article '${input.title}' (${generation.reason}). Keeping original content.`;
    console.warn(message);
    onLog?.(message);
    return unchanged({ status: "failed", reason: generation.reason }, true);
  }

  const answer = parseJsonAnswer(generation.text);
  if (!answer) {
    const message = `AI returned invalid JSON for article '${input.title}': ${generation.text.slice(0, 100)}...`;
    console.warn(message);
    onLog?.(message);
    return unchanged({ status: "failed", reason: "invalidJson" }, true);
  }

  let title = input.title;
  // Not canonicalized here: on the rewrite path this value is always either
  // overwritten by the actual rewritten blocks (once the model's answer
  // parses) or bypassed entirely by an early `unchanged()` return, so a
  // canonicalized copy assigned here would never be read -- a dead full-tree
  // copy on every rewritten article. `canonicalBlocks()` is still what makes
  // `textToBlocks(answer.document)` comparable against the sent document (see
  // the `echoed` check below), it is just never applied to *this* variable.
  let blocks = input.blocks;
  /** How many blocks the rewrite came back as, before any summary block. */
  let rewrittenCount = blocks.length;
  /** See `AiBlockResult.droppedMedia` -- set below when the rewrite dropped one. */
  let droppedMedia = false;

  if (wantsRewrite) {
    let rewritten: Block[] | null = null;

    if (typeof answer.document === "string") {
      const parsed = textToBlocks(answer.document, document);
      if (parsed.blocks.length > 0) {
        // **Did the model change anything at all?** Asked in the one place it
        // can be asked cheaply and exactly: `blocksToText()` of the answer's
        // tree is byte-identical to what was sent precisely when the answer is
        // the input echoed back, because the notation is a normal form (the
        // round-trip contract in `./block-text`). Comparing the serialized
        // forms rather than the trees is deliberate -- a deep compare would
        // have to know that `canonicalBlocks()` and `textToBlocks()` build
        // their objects with different key order, and would miss an echo whose
        // whitespace differed.
        //
        // A model that reproduces the document instead of rewriting it is not
        // a hypothetical: it is what a user saw as "reload only translates the
        // title", with the (unchanged) English body stored over the English
        // body, the title stored translated, and the job green. An echo parses
        // perfectly, so nothing downstream could tell.
        const echoed =
          plainTextOf(input.blocks).trim() !== "" &&
          blocksToText(parsed.blocks).text === document.text;

        if (echoed && opts.ai_translate) {
          // For a translation this is not a judgement call: a document
          // identical to the one sent is, by definition, not translated. Fails
          // rather than warns, for the same reason `missingDocument` does --
          // a translated title over an untranslated body is the broken article
          // this whole arm exists to stop storing.
          //
          // The one false positive is a feed whose source is *already* in the
          // target language, where an unchanged document is the right answer.
          // The message says so, because the fix there is to turn translation
          // off for that feed rather than to make this quieter.
          const message =
            `AI returned the document unchanged for article '${input.title}', so it was not ` +
            `translated. Nothing was stored. (If this feed's articles are already in the ` +
            `target language, turn translation off for it.)`;
          console.warn(message);
          onLog?.(message);
          return unchanged({ status: "failed", reason: "documentUnchanged" }, true);
        }

        if (echoed) {
          // Improve-writing and a custom instruction are a different matter:
          // "this reads fine as it is" is a legitimate answer, so this is a
          // note in the job's own log rather than a failure.
          const message = `AI returned the document unchanged for article '${input.title}'.`;
          console.warn(message);
          onLog?.(message);
        }

        rewritten = parsed.blocks;

        const lead = leadMediaOf(input.blocks);
        if (lead) {
          rewritten = pinLeadMedia(lead, rewritten);
        }

        // **Whether the model's handling of the lead media -- dropped,
        // duplicated or caption-cleared -- still counts as a real loss
        // excludes the lead itself, and `droppedOpaque`/`clearedCaptions`
        // share this one exclusion rather than each recomputing it.**
        // `pinLeadMedia()` above unconditionally throws away whatever the
        // model returned for the lead slot -- caption included -- and
        // substitutes the *input's* own lead block verbatim. So a model that
        // omits the lead placeholder entirely (which the notation spec does
        // not forbid any more strictly than dropping any other placeholder,
        // and is common enough in practice) or reproduces it with its
        // caption stripped ends up with a fully correct, fully captioned
        // document anyway: nothing the model did to that one slot survives
        // into what is actually stored. Counting either as a real loss would
        // be wrong in both directions -- it would withhold the content
        // fingerprint (see `AiBlockResult.droppedMedia`) on an article that
        // is not actually missing anything, and it would log a caption loss
        // for a caption that is, in the stored article, fully intact. A
        // *non*-lead placeholder has no such recovery, so it is the only
        // thing either report still counts.
        const leadIndex = lead ? document.opaque.findIndex((block) => sameMedia(block, lead)) : -1;

        if (parsed.droppedOpaque.length > 0) {
          if (parsed.droppedOpaque.some((index) => index !== leadIndex)) {
            droppedMedia = true;
          }

          const message =
            `AI dropped ${parsed.droppedOpaque.length} media/code block(s) from article ` +
            `'${input.title}'; the rest of the rewrite was kept.` +
            (droppedMedia
              ? " The content fingerprint will be withheld so the next aggregation run " +
                "retries this article."
              : "");
          console.warn(message);
          onLog?.(message);
        }

        if (parsed.duplicatedOpaque.length > 0) {
          // Only the first occurrence made it into `rewritten` (see
          // `parseLines()` in `./block-text`); this is purely a report that the
          // model repeated a placeholder rather than moving it.
          const message =
            `AI repeated ${parsed.duplicatedOpaque.length} media/code placeholder(s) in ` +
            `article '${input.title}'; only the first occurrence was kept.`;
          console.warn(message);
          onLog?.(message);
        }

        const reportableClearedCaptions = parsed.clearedCaptions.filter(
          (index) => index !== leadIndex,
        );
        if (reportableClearedCaptions.length > 0) {
          const message =
            `AI dropped the caption on ${reportableClearedCaptions.length} image(s) in ` +
            `article '${input.title}'; the image itself was kept.`;
          console.warn(message);
          onLog?.(message);
        }
      }
    }

    if (!rewritten) {
      // A rewrite was asked for and the document did not come back -- absent,
      // not a string, empty, or notation that read as no blocks at all.
      //
      // **Reported, and the title left alone with it.** This arm used to fall
      // through: the answer's `title` was applied and the source blocks were
      // stored beside it, on an outcome of `applied`. That is a translated
      // title over an untranslated body -- the article a user reported after
      // reloading a Reddit post -- stored silently, with the job green and
      // nothing in its log. A title and a body are one answer to one rewrite
      // request, so half of it is not partial success: the article stays wholly
      // as the source has it, the job reports the failure, and (in
      // `handleAggregateJob`) no `contentHash` is stored, so the next cycle
      // tries again. Deliberately *not* symmetrical with `missingSummary`
      // below, which keeps a rewrite that did come back: a summary is an
      // addition an article reads fine without, where a rewritten title over an
      // untouched body is a visibly broken article.
      const message = `AI returned no rewritten document for article '${input.title}'.`;
      console.warn(message);
      onLog?.(message);
      return unchanged({ status: "failed", reason: "missingDocument" }, true);
    }

    blocks = rewritten;
    rewrittenCount = rewritten.length;

    // Only a request that asked for a rewrite may change the title. A model
    // that volunteers one for a summarize-only request is renaming an article
    // nobody asked to have renamed.
    if (typeof answer.title === "string" && answer.title.trim()) {
      title = answer.title;
    }
  }

  if (wantsSummary) {
    if (typeof answer.summary === "string" && answer.summary.trim()) {
      blocks = withSummary(blocks, answer.summary);
    } else {
      // Summarization was asked for and did not happen. Reported rather than
      // swallowed, for the reason every other arm here is: AI features failing
      // silently are indistinguishable from AI never having run. A rewrite that
      // did come back is still applied; a summarize-only request has nothing
      // else to keep, so it is returned untouched.
      const message = `AI returned no summary for article '${title}'.`;
      console.warn(message);
      onLog?.(message);
      // `degraded`, not `failed`, when a rewrite came back: `blocks`/`title`
      // here are the applied rewrite, not `input` echoed back, and a caller
      // that treated this like `missingDocument` (write nothing, fail the
      // job) would throw away a good rewrite and mail the owner a failure
      // notice for a run that was mostly a success. With no rewrite requested
      // there is nothing to keep, so that case still reports plain `failed`
      // with `input` untouched, via `unchanged()`.
      return wantsRewrite
        ? {
            title,
            blocks,
            outcome: { status: "degraded", reason: "missingSummary" },
            requested: true,
            droppedMedia,
          }
        : unchanged({ status: "failed", reason: "missingSummary" }, true);
    }
  }

  // **One line on the applied path, and it is worth its space.** Every failure
  // arm above logs; success logged nothing at all -- so a reload whose job log
  // read "reloaded article content" and nothing else was indistinguishable
  // between "this feed never asked for AI", "the provider was never called"
  // and "the model answered and its answer changed nothing". That ambiguity is
  // what made the "reload only translates the title" report take a round of
  // guessing to place: the one question the log could not answer was whether
  // the stage had run. It can now, per article, in one line.
  onLog?.(
    `AI (${asked.join("+")}) applied to '${input.title}': ` +
      (wantsRewrite
        ? `document ${input.blocks.length} -> ${rewrittenCount} blocks, ` +
          `title ${title === input.title ? "unchanged" : "rewritten"}`
        : "summary only") +
      (wantsSummary ? ", summary added" : ""),
  );

  return { title, blocks, outcome: { status: "applied" }, requested: true, droppedMedia };
}
