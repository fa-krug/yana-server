import * as cheerio from "cheerio";

export interface ArticleInput {
  name?: string;
  content?: string;
  [key: string]: unknown;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class AIClient {
  private settings: any;
  private provider: string;

  constructor(settings: any) {
    this.settings = settings || {};
    this.provider = this.settings.activeAiProvider ?? this.settings.active_ai_provider ?? "";
  }

  private async requestWithRetry(
    url: string,
    headers: Record<string, string>,
    data: any,
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

        console.warn(`AI API call failed with status ${response.status}: ${response.statusText}`);
        return null;
      } catch (err: any) {
        if (attempt < maxRetries && err?.status === 429) {
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

        console.warn(`AI API request error: ${err?.message || err}`);
        return null;
      }
    }

    return null;
  }

  public async generateResponse(
    prompt: string,
    jsonMode = false,
    jsonSchema?: Record<string, unknown>,
  ): Promise<string | null> {
    if (!this.provider) {
      console.warn("No AI provider selected.");
      return null;
    }

    try {
      if (this.provider === "openai") {
        return await this.callOpenai(prompt, jsonMode);
      } else if (this.provider === "anthropic") {
        return await this.callAnthropic(prompt);
      } else if (this.provider === "gemini") {
        return await this.callGemini(prompt, jsonMode, jsonSchema);
      } else {
        console.warn(`Unknown AI provider: ${this.provider}`);
        return null;
      }
    } catch (e: any) {
      console.warn(`AI API call failed: ${e?.message || e}`);
      return null;
    }
  }

  private async callOpenai(prompt: string, jsonMode: boolean): Promise<string | null> {
    const enabled = this.settings.openaiEnabled ?? this.settings.openai_enabled;
    const apiKey = this.settings.openaiApiKey ?? this.settings.openai_api_key;
    if (!enabled || !apiKey) {
      console.warn("OpenAI is not enabled or configured.");
      return null;
    }

    const baseUrl = (
      this.settings.openaiApiUrl ??
      this.settings.openai_api_url ??
      "https://api.openai.com/v1"
    ).replace(/\/+$/, "");
    const url = `${baseUrl}/chat/completions`;
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const model = this.settings.openaiModel ?? this.settings.openai_model ?? "gpt-4o-mini";
    const temperature = this.settings.aiTemperature ?? this.settings.ai_temperature ?? 0.7;
    const maxTokens = this.settings.aiMaxTokens ?? this.settings.ai_max_tokens ?? 1000;
    const timeout = this.settings.aiRequestTimeout ?? this.settings.ai_request_timeout ?? 30;

    const data: any = {
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
}

export async function applyAiOptions(
  article: ArticleInput,
  options?: Record<string, unknown> | null,
  userSettings?: any,
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

  const result = await client.generateResponse(fullPrompt, true, jsonSchema);

  if (result) {
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
