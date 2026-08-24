import { plainTextOf } from "@/lib/aggregators/blocks/parser";
import type { Block } from "@/lib/aggregators/blocks/types";
import type { UserSettings } from "@/lib/db/schema";

import { blocksToText, canonicalBlocks, textToBlocks } from "./block-text";

import { DEEPSEEK_API_URL, MISTRAL_API_URL, OPENROUTER_API_URL, QWEN_API_URL } from "./providers";

/**
 * What `AIClient` and `applyAiToBlocks` accept for a user's AI configuration.
 *
 * `getSettings()`'s real row is `UserSettings` -- camelCase, one field per
 * column -- so `Partial<UserSettings>` covers every production caller. Every
 * field is also read under its snake_case column name (`this.settings.aiMaxRetries
 * ?? this.settings.ai_max_retries`), which nothing in this codebase's own
 * callers produces today; it is kept because dropping it would be a behavior
 * change for whatever *does* hand this a snake_case row (a raw query result, a
 * fixture ported from `old/core/ai_client.py`'s Django settings object).
 *
 * `aiMaxRetryTime`/`ai_max_retry_time` (the retry-budget cap read in
 * `requestWithRetry()`) has no `user_settings` column at all -- `old/core/ai_client.py`
 * reads it with `getattr(self.settings, "ai_max_retry_time", 60)`, always falling
 * back to its default -- so both spellings are declared here rather than on
 * `UserSettings`.
 */
export type AiRuntimeSettings = Partial<UserSettings> & {
  active_ai_provider?: string;
  aiMaxRetryTime?: number;
  ai_max_retries?: number;
  ai_retry_delay?: number;
  ai_max_retry_time?: number;
  ai_temperature?: number;
  ai_request_timeout?: number;
  openai_enabled?: boolean;
  openai_api_key?: string;
  openai_api_url?: string;
  openai_model?: string;
  anthropic_enabled?: boolean;
  anthropic_api_key?: string;
  anthropic_model?: string;
  gemini_enabled?: boolean;
  gemini_api_key?: string;
  gemini_model?: string;
  mistral_enabled?: boolean;
  mistral_api_key?: string;
  mistral_model?: string;
  qwen_enabled?: boolean;
  qwen_api_key?: string;
  qwen_model?: string;
  deepseek_enabled?: boolean;
  deepseek_api_key?: string;
  deepseek_model?: string;
  openrouter_enabled?: boolean;
  openrouter_api_key?: string;
  openrouter_model?: string;
};

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Narrows a caught value to the numeric `.status` some rejections carry. */
function errorStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = (err as Record<string, unknown>).status;
    if (typeof status === "number") {
      return status;
    }
  }
  return undefined;
}

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

export class AIClient {
  private settings: AiRuntimeSettings;
  private provider: string;
  private onLog?: (message: string) => void;

  constructor(settings: AiRuntimeSettings, onLog?: (message: string) => void) {
    this.settings = settings || {};
    this.provider = this.settings.activeAiProvider ?? this.settings.active_ai_provider ?? "";
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
    const maxRetries = this.settings.aiMaxRetries ?? this.settings.ai_max_retries ?? 3;
    const retryDelay = this.settings.aiRetryDelay ?? this.settings.ai_retry_delay ?? 2;
    const maxRetryTime = this.settings.aiMaxRetryTime ?? this.settings.ai_max_retry_time ?? 60;

    const startTime = Date.now();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutSeconds * 1000);

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
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

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
        if (attempt < maxRetries && errorStatus(err) === 429) {
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
    if (!this.provider) {
      this.warn("No AI provider selected.");
      return { ok: false, reason: "noProvider" };
    }

    try {
      let text: string | null;
      if (this.provider === "openai") {
        text = await this.callOpenai(prompt, jsonMode);
      } else if (this.provider === "anthropic") {
        text = await this.callAnthropic(prompt);
      } else if (this.provider === "gemini") {
        text = await this.callGemini(prompt, jsonMode, jsonSchema);
      } else if (this.provider === "mistral") {
        text = await this.callMistral(prompt, jsonMode);
      } else if (this.provider === "qwen") {
        text = await this.callQwen(prompt, jsonMode);
      } else if (this.provider === "deepseek") {
        text = await this.callDeepseek(prompt, jsonMode);
      } else if (this.provider === "openrouter") {
        text = await this.callOpenrouter(prompt, jsonMode);
      } else {
        this.warn(`Unknown AI provider: ${this.provider}`);
        return { ok: false, reason: "providerError" };
      }
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
   * The `/chat/completions` request/response shape every OpenAI-compatible
   * provider shares. `callOpenai()` and the Mistral/Qwen/DeepSeek branches
   * all call this with their own resolved base URL, key and model — only
   * OpenAI's base URL is an operator setting, so only `callOpenai()` needs
   * to resolve one before calling in.
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

    const temperature = this.settings.aiTemperature ?? this.settings.ai_temperature ?? 0.7;

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

  private async callOpenai(prompt: string, jsonMode: boolean): Promise<string | null> {
    const enabled = this.settings.openaiEnabled ?? this.settings.openai_enabled;
    const apiKey = this.settings.openaiApiKey ?? this.settings.openai_api_key;
    if (!enabled || !apiKey) {
      console.warn("OpenAI is not enabled or configured.");
      return null;
    }

    const baseUrl =
      this.settings.openaiApiUrl ?? this.settings.openai_api_url ?? "https://api.openai.com/v1";
    const model = this.settings.openaiModel ?? this.settings.openai_model ?? "gpt-4o-mini";
    const timeout = this.settings.aiRequestTimeout ?? this.settings.ai_request_timeout ?? 30;

    return this.callOpenaiCompatible(baseUrl, apiKey, model, prompt, jsonMode, timeout);
  }

  private async callAnthropic(prompt: string): Promise<string | null> {
    const enabled = this.settings.anthropicEnabled ?? this.settings.anthropic_enabled;
    const apiKey = this.settings.anthropicApiKey ?? this.settings.anthropic_api_key;
    if (!enabled || !apiKey) {
      console.warn("Anthropic is not enabled or configured.");
      return null;
    }

    const url = "https://api.anthropic.com/v1/messages";
    const headers = {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };

    const model =
      this.settings.anthropicModel ?? this.settings.anthropic_model ?? "claude-sonnet-4-20250514";
    const temperature = this.settings.aiTemperature ?? this.settings.ai_temperature ?? 0.7;
    const timeout = this.settings.aiRequestTimeout ?? this.settings.ai_request_timeout ?? 30;

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

  private async callGemini(
    prompt: string,
    jsonMode: boolean,
    jsonSchema?: Record<string, unknown>,
  ): Promise<string | null> {
    const enabled = this.settings.geminiEnabled ?? this.settings.gemini_enabled;
    const apiKey = this.settings.geminiApiKey ?? this.settings.gemini_api_key;
    if (!enabled || !apiKey) {
      console.warn("Gemini is not enabled or configured.");
      return null;
    }

    const model =
      this.settings.geminiModel ?? this.settings.gemini_model ?? "gemini-3-flash-preview";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const headers = {
      "Content-Type": "application/json",
    };

    const temperature = this.settings.aiTemperature ?? this.settings.ai_temperature ?? 0.7;
    const timeout = this.settings.aiRequestTimeout ?? this.settings.ai_request_timeout ?? 30;

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
      console.warn(`Unexpected Gemini response format: ${JSON.stringify(result)}`);
      return null;
    }
    return text;
  }

  private async callMistral(prompt: string, jsonMode: boolean): Promise<string | null> {
    const enabled = this.settings.mistralEnabled ?? this.settings.mistral_enabled;
    const apiKey = this.settings.mistralApiKey ?? this.settings.mistral_api_key;
    if (!enabled || !apiKey) {
      console.warn("Mistral is not enabled or configured.");
      return null;
    }
    const model =
      this.settings.mistralModel ?? this.settings.mistral_model ?? "mistral-small-latest";
    const timeout = this.settings.aiRequestTimeout ?? this.settings.ai_request_timeout ?? 30;
    return this.callOpenaiCompatible(MISTRAL_API_URL, apiKey, model, prompt, jsonMode, timeout);
  }

  private async callQwen(prompt: string, jsonMode: boolean): Promise<string | null> {
    const enabled = this.settings.qwenEnabled ?? this.settings.qwen_enabled;
    const apiKey = this.settings.qwenApiKey ?? this.settings.qwen_api_key;
    if (!enabled || !apiKey) {
      console.warn("Qwen is not enabled or configured.");
      return null;
    }
    const model = this.settings.qwenModel ?? this.settings.qwen_model ?? "qwen3.5-flash";
    const timeout = this.settings.aiRequestTimeout ?? this.settings.ai_request_timeout ?? 30;
    return this.callOpenaiCompatible(QWEN_API_URL, apiKey, model, prompt, jsonMode, timeout);
  }

  private async callDeepseek(prompt: string, jsonMode: boolean): Promise<string | null> {
    const enabled = this.settings.deepseekEnabled ?? this.settings.deepseek_enabled;
    const apiKey = this.settings.deepseekApiKey ?? this.settings.deepseek_api_key;
    if (!enabled || !apiKey) {
      console.warn("DeepSeek is not enabled or configured.");
      return null;
    }
    const model =
      this.settings.deepseekModel ?? this.settings.deepseek_model ?? "deepseek-v4-flash";
    const timeout = this.settings.aiRequestTimeout ?? this.settings.ai_request_timeout ?? 30;
    return this.callOpenaiCompatible(DEEPSEEK_API_URL, apiKey, model, prompt, jsonMode, timeout);
  }

  private async callOpenrouter(prompt: string, jsonMode: boolean): Promise<string | null> {
    const enabled = this.settings.openrouterEnabled ?? this.settings.openrouter_enabled;
    const apiKey = this.settings.openrouterApiKey ?? this.settings.openrouter_api_key;
    if (!enabled || !apiKey) {
      console.warn("OpenRouter is not enabled or configured.");
      return null;
    }
    const model =
      this.settings.openrouterModel ?? this.settings.openrouter_model ?? "openrouter/free";
    const timeout = this.settings.aiRequestTimeout ?? this.settings.ai_request_timeout ?? 30;
    return this.callOpenaiCompatible(OPENROUTER_API_URL, apiKey, model, prompt, jsonMode, timeout);
  }
}

/**
 * What the AI stage actually did, distinct from the block tree it returns -- a
 * caller that asked for AI processing (a feed's
 * summarize/improve-writing/translate options) and didn't get it needs to be
 * able to tell that apart from "no AI options were configured at all," which
 * is a normal, silent no-op rather than a failure.
 */
export type ApplyAiOutcome =
  { status: "skipped" } | { status: "applied" } | { status: "failed"; reason: string };

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
  "The document uses this notation. Return the same notation, nothing else:",
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

  if (!wantsSummary && !wantsRewrite) {
    return unchanged({ status: "skipped" });
  }

  if (!userSettings) {
    console.warn("No userSettings provided for AI processing.");
    return unchanged({ status: "failed", reason: "noProvider" });
  }
  if (!(userSettings.activeAiProvider ?? userSettings.active_ai_provider)) {
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
      promptParts.push(
        `Translate the title${wantsSummary ? ", summary" : ""} and document to ${targetLang}. ` +
          "Translate link labels too, but never the (L...) index inside them.",
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
  // Canonicalized only on the rewrite path, where the tree has to survive the
  // notation round trip. A summarize-only request serializes nothing, so
  // normalizing there was pure loss: it collapsed in-paragraph line breaks and
  // merged runs for no reason, storing a different tree than the same article
  // would get on a feed with AI switched off.
  let blocks = wantsRewrite ? canonicalBlocks(input.blocks) : input.blocks;

  if (wantsRewrite) {
    // Only a request that asked for a rewrite may change either. A model that
    // volunteers a title for a summarize-only request is renaming an article
    // nobody asked to have renamed.
    if (typeof answer.title === "string" && answer.title.trim()) {
      title = answer.title;
    }
    if (typeof answer.document === "string") {
      const parsed = textToBlocks(answer.document, document);
      if (parsed.blocks.length > 0) {
        blocks = parsed.blocks;

        const lead = leadMediaOf(input.blocks);
        if (lead) {
          blocks = pinLeadMedia(lead, blocks);
        }

        if (parsed.droppedOpaque.length > 0) {
          const message =
            `AI dropped ${parsed.droppedOpaque.length} media/code block(s) from article ` +
            `'${title}'; the rest of the rewrite was kept.`;
          console.warn(message);
          onLog?.(message);
        }
      }
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
      return wantsRewrite
        ? {
            title,
            blocks,
            outcome: { status: "failed", reason: "missingSummary" },
            requested: true,
          }
        : unchanged({ status: "failed", reason: "missingSummary" }, true);
    }
  }

  return { title, blocks, outcome: { status: "applied" }, requested: true };
}
