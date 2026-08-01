import { PROBE_TIMEOUT_MS, type ProbeResult } from "@/lib/integrations/probe";

import { readJson, transportFailure } from "./probe-support";

/** Fixed: `hasCustomUrl` is `false` for this provider, so there is nothing to configure. */
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/**
 * Pinned rather than tracked. `anthropic-version` selects a frozen request and
 * response contract; bumping it is a deliberate change with a test behind it,
 * not something to keep current.
 */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * One 1-token message -- the cheapest call that proves the key, the model id and
 * the endpoint work together.
 *
 * `max_tokens: 1` is accepted for every current model: the parameter caps
 * thinking *and* response text together, so a model with adaptive thinking on
 * answers `200` with `stop_reason: "max_tokens"` and an empty `content` array
 * rather than refusing. That empty array is exactly why the body check below
 * reads what it reads.
 *
 * **This probe inspects the 200 body, but not the field the obvious reading
 * suggests.** `content` is legitimately `[]` here -- the single token was spent
 * before any text was emitted -- so requiring it would report every working key
 * as broken, which is the mistake YouTube's probe exists to warn about. What is
 * checked is the envelope discriminant `type: "message"`, which a real answer
 * always carries and a mangled one never does. Checking it is worth the two
 * lines even though the host is fixed: a TLS-inspecting middlebox on the
 * operator's network -- the same one `logUnreachable()` exists to diagnose --
 * can serve a 200 block page for any host, and a 200 that is not a message
 * envelope must not switch an integration on.
 */
export async function testAnthropicKey({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): Promise<ProbeResult> {
  // Inside the try, with the request: this function resolves to a classified
  // ProbeResult for every input and never rejects, and that has to hold
  // structurally. A key carrying a newline or a non-Latin-1 character makes an
  // illegal header value and `fetch` rejects -- caught here, not escaped.
  try {
    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (response.ok) {
      const body = (await readJson(response)) as { type?: unknown } | null;
      if (body?.type === "message") return { ok: true, detail: "Key accepted." };
      return {
        ok: false,
        cause: "unexpected",
        detail: "A 200 answer was not a message envelope.",
      };
    }

    const body = (await readJson(response)) as { error?: { type?: unknown } } | null;
    const errorType = typeof body?.error?.type === "string" ? body.error.type : "";

    if (response.status === 401) {
      return { ok: false, cause: "unauthorized", detail: "The API key was rejected." };
    }
    if (response.status === 403) {
      // **Two meanings share this status, and only the detail can tell them
      // apart.** Anthropic returns 403 for a permission problem *and* for
      // `billing_error` -- an account with no credit. Both are `unauthorized`
      // on purpose: the arm stores the credential and switches the integration
      // off, which is the true state in each case, and unlike a rate limit
      // neither heals on its own. Only the log line distinguishes them, which
      // is what `detail` is for. Nothing from the body is interpolated -- the
      // discriminant is read, never echoed.
      return errorType === "billing_error"
        ? {
            ok: false,
            cause: "unauthorized",
            detail: "The key was accepted but the account has no available credit.",
          }
        : { ok: false, cause: "unauthorized", detail: "Access was refused for this API key." };
    }
    if (response.status === 429) {
      // **A rate limit here does prove the credential was accepted**, and this
      // provider's declaration says so (`quotaMeansVerified: true` in
      // `providers.ts`, where this paragraph is deliberately duplicated because
      // the fact and this branch live in different files -- change both).
      // Anthropic's rate limits are per-organisation and are
      // resolved *from the key*: an unrecognised key answers 401
      // `authentication_error` and never reaches accounting, and credit
      // exhaustion -- the one 429 that would not heal -- is a 403
      // `billing_error` here rather than a 429. The endpoint is fixed, so no
      // gateway can shed load in front of the auth check the way Reddit's edge
      // does. That last clause is the whole difference from OpenAI, whose base
      // URL is configurable and whose answer is therefore `false`.
      return {
        ok: false,
        cause: "quota",
        detail: "Rate limited. The key itself was accepted.",
      };
    }
    // None of these is a verdict about the credential, so all three land in the
    // arm that writes nothing rather than storing a key and reporting it as
    // rejected: an unknown model, a request shape the API refused, and a
    // transient overload.
    if (response.status === 404) {
      return { ok: false, cause: "unexpected", detail: "No such model (404)." };
    }
    if (response.status === 400) {
      return {
        ok: false,
        cause: "unexpected",
        detail: "The API rejected the request as malformed (400).",
      };
    }
    if (response.status === 529) {
      return { ok: false, cause: "unexpected", detail: "The API is overloaded (529)." };
    }
    return { ok: false, cause: "unexpected", detail: `Unexpected status ${response.status}.` };
  } catch (error) {
    return transportFailure("anthropic", error, "Could not reach the Anthropic API.");
  }
}
