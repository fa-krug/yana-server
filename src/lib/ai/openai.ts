import { PROBE_TIMEOUT_MS, type ProbeResult } from "@/lib/integrations/probe";

import { readJson, transportFailure } from "./probe-support";

/**
 * Where an OpenAI credential is probed when the operator configured no base URL.
 *
 * `user_settings.openaiApiUrl` carries the same string as its column default,
 * and the two are a hand-maintained duplicate today -- see the report for
 * phase 7 task 1. The probe still defaults, because `apiUrl` is optional on
 * `AiCredentials` and a probe that cannot resolve an endpoint would have to
 * invent a failure for a state the schema makes impossible.
 */
export const OPENAI_DEFAULT_API_URL = "https://api.openai.com/v1";

/**
 * One 1-token chat completion -- the cheapest call that proves the key, the
 * model id *and* the endpoint work together.
 *
 * A models-list call would prove only the first of those, and this provider is
 * the one where the endpoint is a variable: `hasCustomUrl` is `true` so that an
 * OpenAI-compatible gateway (LiteLLM, vLLM, OpenRouter, a corporate proxy) can
 * be used, and "the key is good but that gateway does not serve this model" is
 * a real, common, and otherwise silent failure.
 *
 * **`max_completion_tokens`, not `max_tokens`.** OpenAI documents `max_tokens`
 * as deprecated and "not compatible with o-series models", and the GPT-5.x
 * family reasons -- so the older field is refused where it matters most. A
 * gateway that does not understand the newer field answers 400, which this
 * probe classifies as `unexpected` (nothing is written) rather than blaming the
 * credential; see the status table below.
 *
 * **This probe inspects the 200 body, like Reddit's and unlike YouTube's.** The
 * reason is the configurable endpoint: whatever answers may be a proxy, a
 * captive portal or a gateway that reports errors with a 200 status, and
 * `/chat/completions` has no legitimate empty-but-valid success -- a completion
 * always carries at least one entry in `choices`. What is checked is the
 * *array*, never `choices[0].message.content`, which is legitimately `""` when
 * a reasoning model spends its single token thinking.
 */
export async function testOpenaiKey({
  apiKey,
  apiUrl,
  model,
}: {
  apiKey: string;
  apiUrl?: string;
  model: string;
}): Promise<ProbeResult> {
  // URL building and header construction happen inside the try, with the
  // request: this function's contract is that it resolves to a classified
  // ProbeResult for *every* input, and that has to hold structurally rather
  // than by an argument about which characters an operator can paste into a
  // base URL or an API key. A key containing a newline makes an illegal header
  // value and `fetch` rejects; a base URL of "not a url" throws in `new URL`.
  // Both are caught here, neither escapes.
  try {
    const base = (apiUrl?.trim() || OPENAI_DEFAULT_API_URL).replace(/\/+$/, "");
    const endpoint = new URL(`${base}/chat/completions`);
    if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      return {
        ok: false,
        cause: "unexpected",
        detail: "The configured API URL is not an http(s) URL.",
      };
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        max_completion_tokens: 1,
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (response.ok) {
      const body = (await readJson(response)) as { choices?: unknown } | null;
      if (Array.isArray(body?.choices) && body.choices.length > 0) {
        return { ok: true, detail: "Key accepted." };
      }
      return {
        ok: false,
        cause: "unexpected",
        detail: "A 200 answer carried no completion.",
      };
    }

    const body = (await readJson(response)) as { error?: { type?: unknown } } | null;
    const errorType = typeof body?.error?.type === "string" ? body.error.type : "";

    // **A 429 splits into two verdicts, and only one of them is a rate limit.**
    // `insufficient_quota` shares the status with `rate_limit_exceeded` but
    // means something permanent: the account is out of credit. Reporting it as
    // `quota` would send it to `judge()`'s `unknown` arm (see `define.ts`) and
    // write *nothing*, so an operator whose only fault is an unpaid bill could
    // never save a key that is perfectly valid. `unauthorized` stores the
    // credential with the integration switched off, which is the honest state:
    // the key is real, and it cannot summarise anything today. The catalog key
    // this maps to must therefore be worded as "the provider would not accept
    // this credential", not "the key is wrong" -- flagged for the actions task.
    if (errorType === "insufficient_quota") {
      return {
        ok: false,
        cause: "unauthorized",
        detail: "The key was accepted but the account is out of credit.",
      };
    }
    if (response.status === 429) {
      return {
        ok: false,
        cause: "quota",
        detail: "Rate limited before a verdict was reached.",
      };
    }
    if (response.status === 401) {
      return { ok: false, cause: "unauthorized", detail: "The API key was rejected." };
    }
    if (response.status === 403) {
      return { ok: false, cause: "unauthorized", detail: "Access was refused for this API key." };
    }
    // Neither of these is a verdict about the credential -- an unknown model or
    // a request this endpoint does not understand -- so both land in the arm
    // that writes nothing rather than storing a key with the integration off
    // and telling the operator it was rejected.
    if (response.status === 404) {
      return {
        ok: false,
        cause: "unexpected",
        detail: "No such model or endpoint (404).",
      };
    }
    if (response.status === 400) {
      return {
        ok: false,
        cause: "unexpected",
        detail: "The endpoint rejected the request as malformed (400).",
      };
    }
    return { ok: false, cause: "unexpected", detail: `Unexpected status ${response.status}.` };
  } catch (error) {
    return transportFailure("openai", error, "Could not reach the OpenAI API.");
  }
}
