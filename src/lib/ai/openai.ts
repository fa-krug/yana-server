import { openaiCompatibleChatProbe, type ProbeResult } from "@/lib/integrations/probe";

import { OPENAI_DEFAULT_API_URL } from "./providers";

/**
 * Re-exported so this module still reads as the home of everything the OpenAI
 * probe needs, while the constant itself lives in the client-safe registry --
 * the column default, the action's empty-field fallback and task 3's form
 * placeholder all need it, and none of them may import a probe module.
 *
 * The probe still defaults, rather than requiring `apiUrl`: it is optional on
 * `AiCredentials`, and a probe that could not resolve an endpoint would have to
 * invent a failure for a state the schema makes impossible.
 */
export { OPENAI_DEFAULT_API_URL };

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
  // value and `fetch` rejects; that is caught here and never escapes.
  const base = (apiUrl?.trim() || OPENAI_DEFAULT_API_URL).replace(/\/+$/, "");
  const target = `${base}/chat/completions`;

  if (!URL.canParse(target)) {
    return { ok: false, cause: "unexpected", detail: "The configured API URL is not a URL." };
  }
  const endpoint = new URL(target);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    return {
      ok: false,
      cause: "unexpected",
      detail: "The configured API URL is not an http(s) URL.",
    };
  }
  if (endpoint.username !== "" || endpoint.password !== "") {
    return {
      ok: false,
      cause: "unexpected",
      detail: "The configured API URL carries a username or password.",
    };
  }

  return openaiCompatibleChatProbe({ providerName: "openai", endpoint: target, apiKey, model });
}
