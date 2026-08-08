import * as cheerio from "cheerio";

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

  constructor(settings: AiRuntimeSettings) {
    this.settings = settings || {};
    this.provider = this.settings.activeAiProvider ?? this.settings.active_ai_provider ?? "";
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
            console.warn(
              `Rate limited (429), but retrying would exceed time budget (${Math.round(
                elapsedSeconds,
              )}s elapsed, ${waitSeconds}s wait, ${maxRetryTime}s max). Giving up.`,
            );
            return null;
          }

          console.warn(
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

        console.warn(`AI API call failed with status ${response.status}: ${response.statusText}`);
        return null;
      } catch (err: unknown) {
        if (err instanceof ProviderUnauthorizedError) throw err;
        if (attempt < maxRetries && errorStatus(err) === 429) {
          const waitSeconds = retryDelay ? retryDelay * Math.pow(2, attempt) : 0;
          const elapsedSeconds = (Date.now() - startTime) / 1000;
          if (waitSeconds > 0 && elapsedSeconds + waitSeconds > maxRetryTime) {
            console.warn(
              `Rate limited (429), but retrying would exceed time budget (${Math.round(
                elapsedSeconds,
              )}s elapsed, ${waitSeconds}s wait, ${maxRetryTime}s max). Giving up.`,
            );
            return null;
          }
          console.warn(
            `Rate limited (429), retrying in ${waitSeconds}s (attempt ${attempt + 1}/${maxRetries})`,
          );
          if (waitSeconds > 0) {
            await sleep(waitSeconds * 1000);
          }
          continue;
        }

        console.warn(`AI API request error: ${describeError(err)}`);
        return null;
      }
    }

    return null;
  }

  public async generateResponse(
    prompt: string,
    jsonMode = false,
    jsonSchema?: Record<string, unknown>,
  ): Promise<AiGenerationResult> {
    if (!this.provider) {
      console.warn("No AI provider selected.");
      return { ok: false, reason: "noProvider" };
    }

    const userId = this.settings.userId;
    if (userId) {
      const dailyLimit = this.settings.aiDefaultDailyLimit ?? 200;
      const monthlyLimit = this.settings.aiDefaultMonthlyLimit ?? 2000;
      let usage: ReturnType<typeof checkAndRecordAiUsage>;
      try {
        usage = writeTransaction((tx) =>
          checkAndRecordAiUsage(tx, userId, dailyLimit, monthlyLimit),
        );
      } catch (error) {
        console.warn(`AI usage check failed: ${describeError(error)}`);
        return { ok: false, reason: "providerError" };
      }
      if (usage === "dailyLimitExceeded" || usage === "monthlyLimitExceeded") {
        return { ok: false, reason: usage };
      }
    } else {
      // No settings row carried a userId (nothing in production hits this
      // today -- both real call sites read a full `user_settings` row --
      // but a caller that omits one gets the call through unmetered rather
      // than a thrown error, matching this class's warn-and-continue style
      // for misconfiguration elsewhere).
      console.warn("No user id on AI settings; usage limit not enforced for this call.");
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
        console.warn(`Unknown AI provider: ${this.provider}`);
        return { ok: false, reason: "providerError" };
      }
      return text === null ? { ok: false, reason: "providerError" } : { ok: true, text };
    } catch (e: unknown) {
      if (e instanceof ProviderUnauthorizedError) {
        console.warn(`AI provider rejected the stored credentials: ${describeError(e)}`);
        return { ok: false, reason: "providerUnauthorized" };
      }
      console.warn(`AI API call failed: ${describeError(e)}`);
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

export async function applyAiOptions(
  article: ArticleInput,
  options?: Record<string, unknown> | null,
  userSettings?: AiRuntimeSettings,
): Promise<ArticleInput> {
  const opts = options || {};
  const aiEnabled = Boolean(opts.ai_summarize || opts.ai_improve_writing || opts.ai_translate);

  if (!aiEnabled) {
    console.warn("AI processing disabled or no AI options selected.");
    return article;
  }

  if (!userSettings) {
    console.warn("No userSettings provided for AI processing.");
    return article;
  }

  const provider = userSettings.activeAiProvider ?? userSettings.active_ai_provider;
  if (!provider) {
    console.warn("No active AI provider selected.");
    return article;
  }

  const client = new AIClient(userSettings);

  const content = article.content || "";
  if (!content) {
    return article;
  }

  // Parse HTML and strip headers, footers, navs, scripts, styles
  const $ = cheerio.load(content, null, false);
  $("header, footer, nav, script, style").remove();
  const cleanHtml = $.html();

  const promptParts: string[] = [];

  promptParts.push(
    "You are an AI assistant that processes article content. " +
      "You will receive an article title and content in HTML format. " +
      "You must return the result as a JSON object with keys 'title' and 'content'. " +
      "Do not include any markdown formatting (like ```json) in the response, just the raw JSON string.",
  );

  if (opts.ai_summarize) {
    promptParts.push("Summarize the article content concisely.");
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
      `Translate the title and content to ${targetLang}. ` +
        "IMPORTANT: Do NOT translate link labels (the text inside <a> tags). " +
        "Keep link text in the original language. Only translate regular text content.",
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
    },
    required: ["title", "content"],
  };

  const generation = await client.generateResponse(fullPrompt, true, jsonSchema);

  if (generation.ok) {
    const result = generation.text;
    let parsedResult: { title?: string; content?: string } | null = null;
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
      if (typeof parsedResult.content === "string") {
        article.content = parsedResult.content;
      }
    } else {
      console.warn(
        `AI returned invalid JSON for article '${article.name || ""}': ${result.slice(0, 100)}...`,
      );
    }
  } else {
    console.warn(`AI processing failed for article '${article.name || ""}'. Skipping.`);
  }

  return article;
}
