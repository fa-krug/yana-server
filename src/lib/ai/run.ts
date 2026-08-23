import * as cheerio from "cheerio";
import type { Element } from "domhandler";

import { escapeHtml } from "@/lib/aggregators/extract/format";
import { writeTransaction } from "@/lib/db/client";
import type { UserSettings } from "@/lib/db/schema";

import { DEEPSEEK_API_URL, MISTRAL_API_URL, OPENROUTER_API_URL, QWEN_API_URL } from "./providers";
import { checkAndRecordAiUsage } from "./usage";

export interface ArticleInput {
  name?: string;
  content?: string;
  [key: string]: unknown;
}

/**
 * What `AIClient` and `applyAiOptions` accept for a user's AI configuration.
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
  ai_max_tokens?: number;
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
  | {
      ok: false;
      reason:
        | "noProvider"
        | "dailyLimitExceeded"
        | "monthlyLimitExceeded"
        | "providerUnauthorized"
        | "providerError";
    };

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
   * `bypassUsageLimit` skips both the check and the recording of this call
   * against the daily/monthly caps -- used for a user-triggered single-article
   * reload (see `applyAiOptions()`'s own `bypassUsageLimit` parameter), which
   * is a deliberate, one-off action the operator asked for right now, not the
   * unattended bulk processing those caps exist to bound. It must not merely
   * skip *enforcement* while still recording the call: doing so would spend
   * part of the same budget background aggregation relies on, silently
   * tightening the effective cap for every other AI call that day.
   */
  public async generateResponse(
    prompt: string,
    jsonMode = false,
    jsonSchema?: Record<string, unknown>,
    bypassUsageLimit = false,
  ): Promise<AiGenerationResult> {
    if (!this.provider) {
      this.warn("No AI provider selected.");
      return { ok: false, reason: "noProvider" };
    }

    const userId = this.settings.userId;
    if (userId && !bypassUsageLimit) {
      const dailyLimit = this.settings.aiDefaultDailyLimit ?? 200;
      const monthlyLimit = this.settings.aiDefaultMonthlyLimit ?? 2000;
      let usage: ReturnType<typeof checkAndRecordAiUsage>;
      try {
        usage = writeTransaction((tx) =>
          checkAndRecordAiUsage(tx, userId, dailyLimit, monthlyLimit),
        );
      } catch (error) {
        this.warn(`AI usage check failed: ${describeError(error)}`);
        return { ok: false, reason: "providerError" };
      }
      if (usage === "dailyLimitExceeded" || usage === "monthlyLimitExceeded") {
        return { ok: false, reason: usage };
      }
    } else if (!userId) {
      // No settings row carried a userId (nothing in production hits this
      // today -- both real call sites read a full `user_settings` row --
      // but a caller that omits one gets the call through unmetered rather
      // than a thrown error, matching this class's warn-and-continue style
      // for misconfiguration elsewhere).
      this.warn("No user id on AI settings; usage limit not enforced for this call.");
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
    const maxTokens = this.settings.aiMaxTokens ?? this.settings.ai_max_tokens ?? 1000;

    const data: AiRequestBody = {
      model,
      messages: [{ role: "user", content: prompt }],
      temperature,
      max_tokens: maxTokens,
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
    const maxTokens = this.settings.aiMaxTokens ?? this.settings.ai_max_tokens ?? 1000;
    const timeout = this.settings.aiRequestTimeout ?? this.settings.ai_request_timeout ?? 30;

    const data = {
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
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
    const maxTokens = this.settings.aiMaxTokens ?? this.settings.ai_max_tokens ?? 1000;
    const timeout = this.settings.aiRequestTimeout ?? this.settings.ai_request_timeout ?? 30;

    const generationConfig: Record<string, unknown> = {
      temperature,
      maxOutputTokens: maxTokens,
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
 * What `applyAiOptions()` actually did, distinct from the `ArticleInput` it
 * mutates in place -- a caller that asked for AI processing (a feed's
 * summarize/improve-writing/translate options) and didn't get it needs to be
 * able to tell that apart from "no AI options were configured at all," which
 * is a normal, silent no-op rather than a failure.
 */
export type ApplyAiOutcome =
  { status: "skipped" } | { status: "applied" } | { status: "failed"; reason: string };

/**
 * Detach the article's lead-media `<header>` -- the one every aggregator emits
 * as the first element of its content (`buildHeaderHtml()` in
 * `@/lib/aggregators/extract/format`, Tagesschau's and Reddit's own
 * `media-header`) -- and hand back its HTML so the caller can put it back at
 * the first position afterwards.
 *
 * Only a *leading* header is taken, because only a leading header is the lead
 * media: a `<header>` further down the body is decorative chrome (byline, date,
 * site logo), which `headerBlocks()` in `../aggregators/blocks/parser.ts`
 * already strips of its images. Everything else the strip below removes
 * (footer/nav/script/style, and any non-leading header) stays removed.
 *
 * This has to be detached-and-restored rather than simply left in place: the
 * model must not see the media markup (it rewrites, translates or drops it),
 * and its answer *replaces* the whole document -- so a header that is only
 * removed is a header that is gone. It was: with any AI option enabled, an
 * aggregated article lost its lead image both from `articles.content` and from
 * the block tree parsed out of it, taking the client's lead image and timeline
 * thumbnail with it.
 */
function takeLeadHeaderHtml($: cheerio.CheerioAPI): string | null {
  const first = $.root().children().first();
  if (
    first.length === 0 ||
    (first.get(0) as Element | undefined)?.name?.toLowerCase() !== "header"
  ) {
    return null;
  }
  return $.html(first);
}

/**
 * The summary's own element, second in the finished document, and the marker
 * `parseBlocks()` turns into a `summary` block.
 *
 * `data-sanitized-class` rather than `class` matches what
 * `formatArticleContent()` writes for `article-content`/`article-comments`:
 * the aggregators' own sanitizer (`sanitizeClassNames()`) renames `class` to
 * exactly this, and the reload path runs that sanitizer *after* this function,
 * so writing the sanitized name here keeps the two paths emitting one shape.
 *
 * The name breaks that pair's `article-*` convention on purpose. Those two are
 * wrappers nothing parses; this one *decides a block kind*, and the parser
 * cannot tell our marker from a scraped page's own markup -- `article-summary`
 * is an ordinary CSS class out there, so a site using it would have its teaser
 * served to clients as this article's AI summary. `yana-ai-summary` is ours.
 *
 * The text is escaped, never interpolated raw: it is model output on its way
 * into stored HTML, and asking for plain prose (see the prompt) is not a
 * guarantee of getting it.
 */
function summarySectionHtml(summary: string): string {
  const paragraphs = summary
    .split(/\n\s*\n|\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");
  if (!paragraphs) {
    return "";
  }
  return `<section data-sanitized-class="yana-ai-summary">${paragraphs}</section>`;
}

export async function applyAiOptions(
  article: ArticleInput,
  options?: Record<string, unknown> | null,
  userSettings?: AiRuntimeSettings,
  onLog?: (message: string) => void,
  /**
   * Set by `reload.ts` for a user-triggered single-article reload -- see the
   * doc comment on `AIClient.generateResponse()`'s own parameter of the same
   * name for why a reload doesn't count against the daily/monthly caps the
   * way unattended aggregation does.
   */
  bypassUsageLimit = false,
): Promise<ApplyAiOutcome> {
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
  const aiEnabled = Boolean(
    opts.ai_summarize || opts.ai_improve_writing || opts.ai_translate || customPrompt,
  );

  if (!aiEnabled) {
    return { status: "skipped" };
  }

  if (!userSettings) {
    console.warn("No userSettings provided for AI processing.");
    return { status: "failed", reason: "noProvider" };
  }

  const provider = userSettings.activeAiProvider ?? userSettings.active_ai_provider;
  if (!provider) {
    console.warn("No active AI provider selected.");
    return { status: "failed", reason: "noProvider" };
  }

  const client = new AIClient(userSettings, onLog);

  const content = article.content || "";
  if (!content) {
    return { status: "skipped" };
  }

  // Parse HTML, keep the lead-media header aside, strip headers, footers,
  // navs, scripts, styles
  const $ = cheerio.load(content, null, false);
  const leadHeaderHtml = takeLeadHeaderHtml($);
  $("header, footer, nav, script, style").remove();
  const cleanHtml = $.html();

  const wantsSummary = Boolean(opts.ai_summarize);

  const promptParts: string[] = [];

  promptParts.push(
    "You are an AI assistant that processes article content. " +
      "You will receive an article title and content in HTML format. " +
      "You must return the result as a JSON object with keys 'title' and 'content'" +
      (wantsSummary ? " and 'summary'" : "") +
      ". " +
      "Do not include any markdown formatting (like ```json) in the response, just the raw JSON string.",
  );

  if (wantsSummary) {
    // The summary is its own field and its own element in the finished
    // document -- it does NOT replace the article. Asking for a summary *in*
    // `content` (what this used to do) both destroyed the body and
    // contradicted the structural paragraph below, which demands `content`
    // keep the exact structure of the input.
    promptParts.push(
      "Write a concise summary of the article, 2-3 sentences, into the 'summary' field. " +
        "Plain prose only: no HTML tags, no markdown, no leading label. " +
        "The 'content' field must still carry the complete article -- never replace it with the summary.",
    );
  }

  if (opts.ai_improve_writing) {
    promptParts.push(
      "Rewrite the content to improve clarity, flow, and style. " +
        "IMPORTANT: Preserve the complete HTML structure including all tags. " +
        "Keep all links (<a> tags) exactly as they are - do not modify href attributes or remove any links. " +
        "Only improve the text content itself.",
    );
  }

  if (opts.ai_translate) {
    const targetLang =
      typeof opts.ai_translate_language === "string" ? opts.ai_translate_language : "English";
    promptParts.push(
      `Translate the title${wantsSummary ? ", summary" : ""} and content to ${targetLang}. ` +
        "IMPORTANT: Do NOT translate link labels (the text inside <a> tags). " +
        "Keep link text in the original language. Only translate regular text content.",
    );
  }

  if (customPrompt) {
    // Delimited and labelled as the user's own text, and placed *before* the
    // structural paragraph below rather than last: the JSON/HTML contract the
    // response parser depends on has to be the final word, or a custom prompt
    // (deliberately or not) reshapes the output into something unparseable.
    promptParts.push(
      "The user of this feed has supplied the following additional instruction. " +
        "Follow it where it does not conflict with the output format required below:\n" +
        `"""\n${customPrompt}\n"""`,
    );
  }

  promptParts.push(
    "The input content is HTML with stripped headers/footers. " +
      "CRITICAL: Preserve ALL HTML tags and structure in your output. " +
      "This includes: links (<a>), paragraphs (<p>), headings (<h1>-<h6>), lists (<ul>, <ol>, <li>), " +
      "images (<img>), divs, spans, and all other HTML elements. " +
      "Your output 'content' field must be valid HTML with the exact same structure as the input.",
  );

  const inputData = { title: article.name || "", content: cleanHtml };
  const fullPrompt = promptParts.join("\n") + "\n\nInput Data:\n" + JSON.stringify(inputData);

  const jsonSchema = {
    type: "OBJECT",
    properties: {
      title: { type: "STRING" },
      content: { type: "STRING" },
      ...(wantsSummary ? { summary: { type: "STRING" } } : {}),
    },
    required: wantsSummary ? ["title", "content", "summary"] : ["title", "content"],
  };

  const generation = await client.generateResponse(fullPrompt, true, jsonSchema, bypassUsageLimit);

  if (generation.ok) {
    const result = generation.text;
    let parsedResult: { title?: string; content?: string; summary?: string } | null = null;
    try {
      parsedResult = JSON.parse(result);
    } catch {
      const match = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(result);
      if (match) {
        try {
          parsedResult = JSON.parse(match[1]);
        } catch {}
      }
      if (!parsedResult) {
        const start = result.indexOf("{");
        const end = result.lastIndexOf("}");
        if (start !== -1 && end !== -1 && end > start) {
          try {
            parsedResult = JSON.parse(result.substring(start, end + 1));
          } catch {}
        }
      }
    }

    if (parsedResult) {
      if (typeof parsedResult.title === "string") {
        article.name = parsedResult.title;
      }
      const summaryHtml =
        typeof parsedResult.summary === "string" ? summarySectionHtml(parsedResult.summary) : "";
      if (typeof parsedResult.content === "string") {
        // The finished document's fixed order: the lead-media header first
        // when there is one, the summary second when there is one, the article
        // itself after them. Both are optional and neither may appear anywhere
        // else -- `parseBlocks()` turns this straight into the block tree the
        // clients read. The summary carries its own `summary` block kind
        // there, so a client need not count blocks to find it; the header has
        // no kind of its own and stays positional (an `image` or `embed` block
        // like any other), which is why the order is still a rule.
        article.content = [leadHeaderHtml, summaryHtml, parsedResult.content]
          .filter(Boolean)
          .join("\n\n");
      }
      if (wantsSummary && !summaryHtml) {
        // Summarization was asked for and did not happen. Reported rather than
        // swallowed, for the reason every other arm here is: AI features
        // failing silently is indistinguishable from AI never having run. What
        // did come back (title, content, header) is already applied above.
        const message = `AI returned no summary for article '${article.name || ""}'.`;
        console.warn(message);
        onLog?.(message);
        return { status: "failed", reason: "missingSummary" };
      }
      return { status: "applied" };
    } else {
      const message = `AI returned invalid JSON for article '${article.name || ""}': ${result.slice(0, 100)}...`;
      console.warn(message);
      onLog?.(message);
      return { status: "failed", reason: "invalidJson" };
    }
  } else {
    // `generation.reason` is one of noProvider/dailyLimitExceeded/
    // monthlyLimitExceeded/providerUnauthorized/providerError -- surfacing it
    // (not just "failed") is what tells an operator a 429 apart from a
    // misconfigured key, without which this looked identical to AI silently
    // doing nothing.
    const message = `AI processing failed for article '${article.name || ""}' (${generation.reason}). Keeping original content.`;
    console.warn(message);
    onLog?.(message);
    return { status: "failed", reason: generation.reason };
  }
}
