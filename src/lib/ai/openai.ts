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
 * gateway that does not understand the newer field answers 400, which
 * `openaiCompatibleChatProbe()` classifies as `unexpected` (nothing is
 * written) rather than blaming the credential; see the status classification
 * there.
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
  // This function's contract is that it resolves to a classified ProbeResult
  // for *every* input, and that has to hold structurally rather than by an
  // argument about which characters an operator can paste into a base URL or
  // an API key. The URL validation below runs unguarded because none of it can
  // throw (`URL.canParse` is exactly "is this parseable", never a throw); the
  // request itself, its header construction and the try/catch that keeps a
  // key containing a newline (an illegal header value, which makes `fetch`
  // reject) from escaping now live one level down, in
  // `openaiCompatibleChatProbe()` -- see `@/lib/integrations/probe`.
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

  // **A 429 from this endpoint is not trusted as a verdict.**
  // `openaiCompatibleChatProbe()` reports every 429 as `cause: "quota"`
  // regardless of caller; whether that is trusted is `quotaMeansVerified` on
  // this provider's entry in `./providers`, and OpenAI's is `false` for two
  // independent reasons. First, this is the one provider whose base URL is an
  // operator setting, so what answers may be a gateway that sheds load at its
  // edge before it ever reads the `Authorization` header -- Reddit's
  // situation exactly. Second, OpenAI puts `insufficient_quota` on the same
  // 429 as `rate_limit_exceeded`, but the shared probe pulls that out into
  // `unauthorized` before `quotaMeansVerified` is ever consulted, so what
  // reaches `quota` really is only a rate limit -- and it is still not
  // trusted. That paragraph is deliberately duplicated in `providers.ts`,
  // since the fact and this note live in different files -- change both.
  //
  // **403 stays a verdict, and that was ruled on rather than assumed.** The
  // objection is real and was raised in review: this is the one provider
  // whose endpoint is an operator setting, so a proxy can answer 403 without
  // ever having asked OpenAI -- which is exactly the argument that makes its
  // 429 untrustworthy above. The human's ruling was to keep it: a 403 from a
  // real OpenAI endpoint genuinely is a rejection, a misrouted proxy 403 is
  // rarer than a plain bad key, and storing the credential with the
  // integration off makes a typo visible instead of silently producing empty
  // summaries. Do not re-derive this as a defect.
  return openaiCompatibleChatProbe({ providerName: "openai", endpoint: target, apiKey, model });
}
