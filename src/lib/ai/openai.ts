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
  // value and `fetch` rejects; that is caught here and never escapes.
  try {
    const base = (apiUrl?.trim() || OPENAI_DEFAULT_API_URL).replace(/\/+$/, "");
    const target = `${base}/chat/completions`;

    // **A malformed base URL is answered here, not by the catch below.** Letting
    // `new URL()` throw would fall through to `transportFailure()` and report
    // `network` -- "could not reach the OpenAI API" -- for a string that was
    // never a URL, and log a matching line saying the provider was unreachable.
    // The operator would then hunt a network fault that does not exist. A
    // missing scheme (`gateway.example.com/v1`) is far and away the likeliest
    // way to get here, so this is the common typo rather than an exotic one,
    // and it deserves the same precise answer as the scheme check below.
    // `URL.canParse` rather than a nested try/catch: the question being asked is
    // literally "is this parseable".
    if (!URL.canParse(target)) {
      return {
        ok: false,
        cause: "unexpected",
        detail: "The configured API URL is not a URL.",
      };
    }
    const endpoint = new URL(target);
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
      // Not trusted as a verdict: this provider carries
      // `quotaMeansVerified: false` in `providers.ts`, because its base URL is
      // an operator setting and a gateway can shed load at its edge before
      // reading the Authorization header. That paragraph is deliberately
      // duplicated there, since the fact and this branch live in different
      // files -- change both.
      return {
        ok: false,
        cause: "quota",
        detail: "Rate limited before a verdict was reached.",
      };
    }
    if (response.status === 401) {
      return { ok: false, cause: "unauthorized", detail: "The API key was rejected." };
    }
    // **403 stays a verdict, and that was ruled on rather than assumed.** The
    // objection is real and was raised in review: this is the one provider
    // whose endpoint is an operator setting, so a proxy can answer 403 without
    // ever having asked OpenAI -- which is exactly the argument that makes its
    // 429 untrustworthy (`quotaMeansVerified: false`). The human's ruling was to
    // keep it: a 403 from a real OpenAI endpoint genuinely is a rejection, a
    // misrouted proxy 403 is rarer than a plain bad key, and storing the
    // credential with the integration off makes a typo visible instead of
    // silently producing empty summaries. Do not re-derive this as a defect.
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
