/**
 * The shared shape a credential probe reports, and the timeout every probe
 * uses.
 *
 * Defined once here rather than in `youtube.ts` -- the Reddit probe importing
 * it from a sibling provider's module would be an arbitrary dependency, and
 * phase 7 adds three more providers that report the same way.
 *
 * `detail` is a server-side log line, never a user-facing string: this
 * project routes every result a UI renders through a catalog `errorKey`, and
 * a provider response body can carry back exactly the secret a caller just
 * submitted. `detail` must therefore be built from string constants only --
 * never interpolate a response body, an error message, or a credential into
 * it. Interpolating a status *number* is fine.
 */
export type ProbeResult =
  | { ok: true; detail: string }
  | {
      ok: false;
      cause: "unauthorized" | "quota" | "network" | "timeout" | "unexpected";
      detail: string;
    };

/** Every probe aborts after this long rather than hanging on a slow provider. */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * The platform's own name for why a `fetch` never got an answer.
 *
 * `undici` wraps a transport failure as `TypeError: fetch failed` with the real
 * cause attached, and only that cause carries the code an operator needs:
 * `ENOTFOUND` (DNS), `ECONNREFUSED` (a proxy that is not listening),
 * `CERT_HAS_EXPIRED` / `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (a TLS-inspecting
 * middlebox), `ETIMEDOUT`. Without it, every one of those is the same
 * "Could not reach the API." line and there is nothing to act on.
 *
 * **Only `.code` is read, never the message.** A code is a Node constant; a
 * message can carry a hostname or, on some paths, the request URL -- which for
 * the YouTube probe has the API key in its query string.
 */
function transportCode(error: unknown): string | undefined {
  const cause =
    error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

/**
 * Log why a probe could not reach a provider at all.
 *
 * **This is a log line and it stays one.** `ProbeResult.detail` is built from
 * constants (see above) and nothing may be added to the result for a caller to
 * render, so the one diagnostic that distinguishes "the provider is down" from
 * "this server's egress is broken" is written here instead. A platform error
 * code is not provider-controlled content, so logging it does not reopen the
 * no-echo rule -- but it must not travel any further than this call.
 *
 * **The line carries the provider name and no page tag, deliberately.** It used
 * to say `[integrations]`, which was true while `/integrations` was the only
 * page with probes. It is not any more: one unreachable OpenAI probe wrote
 * `[integrations] openai probe could not reach the provider (ENOTFOUND)` and,
 * immediately after it, `defineIntegrationIn()`'s own bound line
 * `[ai] openai probe failed (network): …` -- two adjacent lines about one event
 * under two different tags, the first of them pointing at the wrong page.
 *
 * The alternative was threading a prefix down here, and it was rejected on cost:
 * a probe is handed nothing but a credential (`descriptor.probe(credential)`),
 * so the page would have to be hard-coded in each of the eight probe modules --
 * eight literals able to drift from the one `logPrefix` in each binding, which is
 * the duplication `logPrefix` was made a binding parameter to avoid. The
 * *provider* name is unique across all eight providers and appears in both lines,
 * so it is the handle that actually joins them; `grep openai` gets the whole
 * story where `grep '\[ai\]'` only ever got half of it.
 */
export function logUnreachable(provider: string, error: unknown): void {
  const code = transportCode(error);
  console.warn(
    `${provider} probe could not reach the provider` +
      (code ? ` (${code})` : " (no platform error code)"),
  );
}

/**
 * The tail of every probe's `catch`: a timeout, or nothing came back at all.
 *
 * Shared by all eight probes. It arrived in phase 7 serving the three AI ones
 * from `src/lib/ai/probe-support.ts`, which left *three* copies of this block
 * where there had been two -- so it moved here and `./youtube` and `./reddit`
 * were converted, and there is now one catch tail rather than a convention that
 * they should agree. Mistral, Qwen and DeepSeek route through
 * `openaiCompatibleChatProbe()` below, so they add no new copies of it.
 *
 * `unreachableDetail` **must be a string literal at the call site.** It is a
 * parameter only so the sentence can name the provider; nothing derived from a
 * response, an error or a credential may ever be passed here. `detail` is a
 * log line and the no-echo rule (see `ProbeResult`) is what keeps a provider
 * from replaying a submitted key back into it.
 *
 * The timeout arm is checked by `error.name`, which is what
 * `AbortSignal.timeout()` really rejects with (`DOMException("TimeoutError")`);
 * everything else is a transport failure, and the platform's error *code* --
 * the one thing that separates "the provider is down" from "this server's
 * egress is broken" -- goes to the log through `logUnreachable()` rather than
 * into the result.
 */
export function transportFailure(
  provider: string,
  error: unknown,
  unreachableDetail: string,
): ProbeResult {
  if (error instanceof Error && error.name === "TimeoutError") {
    return { ok: false, cause: "timeout", detail: "The request timed out." };
  }
  logUnreachable(provider, error);
  return { ok: false, cause: "network", detail: unreachableDetail };
}

/**
 * A response body, or `null` when it was not JSON.
 *
 * Typed `unknown` on purpose: every read of it has to narrow, which is what
 * stops a probe from reaching into a shape a hostile or merely broken
 * intermediary never sent. A rejected `.json()` (an HTML block page, an empty
 * body, a truncated stream) is data, not a failure -- swallowing it here is
 * what lets the classification stay inside the caller's `try` without a parse
 * error being reported as a network fault.
 */
export async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

/**
 * The OpenAI-compatible `/chat/completions` probe body every provider that
 * speaks this shape shares — OpenAI itself, plus Mistral, Qwen and DeepSeek.
 * `endpoint` must already be a validated, trusted URL: only OpenAI has an
 * operator-supplied one, and that validation (scheme, no userinfo) stays in
 * `src/lib/ai/openai.ts`, which calls this only once the URL is confirmed.
 *
 * One 1-token chat completion, exactly like `testOpenaiKey()`'s original
 * probe: it proves the key and the model id together.
 *
 * **`maxTokensField` defaults to `max_tokens`**, the field `run.ts`'s
 * `callOpenaiCompatible()` already sends on the real generation call for
 * every one of these four providers — so the probe and the run path agree by
 * default, rather than the probe speaking a dialect of its own. `openai.ts`
 * overrides it to `max_completion_tokens`: OpenAI documents `max_tokens` as
 * deprecated and refused by its o-series/GPT-5.x reasoning models. Mistral,
 * Qwen and DeepSeek do not document `max_completion_tokens` at all — sending
 * it to DeepSeek was confirmed live to draw an error response that this
 * function's status classification below has no case for, which fell
 * through to the generic `unexpected` verdict and made every DeepSeek "Test"
 * report "the provider answered unexpectedly" regardless of the credential.
 */
export async function openaiCompatibleChatProbe({
  providerName,
  endpoint,
  apiKey,
  model,
  maxTokensField = "max_tokens",
}: {
  providerName: string;
  endpoint: string;
  apiKey: string;
  model: string;
  maxTokensField?: string;
}): Promise<ProbeResult> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        [maxTokensField]: 1,
      }),
      // **Redirects are refused, not followed.** No real OpenAI-compatible
      // endpoint redirects a POST, so nothing legitimate is lost by refusing
      // one -- and for a caller whose endpoint is an operator setting (as
      // OpenAI's is: an OpenAI-compatible gateway is an accepted SSRF
      // surface, see CLAUDE.md), following a redirect would let any host
      // validation the caller performed before calling this be bypassed by a
      // gateway answering 302 to, say, a cloud metadata endpoint -- and this
      // probe's own network-vs-unexpected classification would then be a
      // usable oracle for what is listening there. `undici` rejects instead,
      // which the catch below turns into `network`.
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (response.ok) {
      const body = (await readJson(response)) as { choices?: unknown } | null;
      if (Array.isArray(body?.choices) && body.choices.length > 0) {
        return { ok: true, detail: "Key accepted." };
      }
      return { ok: false, cause: "unexpected", detail: "A 200 answer carried no completion." };
    }

    const body = (await readJson(response)) as { error?: { type?: unknown } } | null;
    const errorType = typeof body?.error?.type === "string" ? body.error.type : "";

    // **A 429 splits into two verdicts, and only one of them is a rate
    // limit.** `insufficient_quota` shares the status with
    // `rate_limit_exceeded` but means something permanent: the account is out
    // of credit. Reporting it as `quota` would send it to `judge()`'s
    // `unknown` arm (see `define.ts`) and write *nothing*, so an operator
    // whose only fault is an unpaid bill could never save a key that is
    // perfectly valid. `unauthorized` stores the credential with the
    // integration switched off, which is the honest state: the key is real,
    // and it cannot summarise anything today. The catalog key this maps to
    // must therefore be worded as "the provider would not accept this
    // credential", not "the key is wrong".
    if (errorType === "insufficient_quota") {
      return {
        ok: false,
        cause: "unauthorized",
        detail: "The key was accepted but the account is out of credit.",
      };
    }
    if (response.status === 429) {
      // **A bare 429 here is never trusted as a verdict by this shared
      // function** -- it always reports `cause: "quota"` and leaves it to the
      // caller to decide whether that means anything. Whether it does is
      // `quotaMeansVerified` on each provider's entry in `./providers` (a
      // required field precisely so a new provider has to answer this rather
      // than inherit a neighbour's), because the trustworthiness of a rate
      // limit depends on facts only the caller knows -- chiefly, whether the
      // endpoint is fixed or an operator setting a gateway could sit in front
      // of. See `./openai.ts` for that provider's own reasoning; Mistral,
      // Qwen and DeepSeek call this shared function directly with no probe
      // module of their own reasoning about the 429 case, so their answer --
      // and why it is `true` for each of them -- lives only beside the field
      // in `providers.ts`, not duplicated at a call site here.
      return { ok: false, cause: "quota", detail: "Rate limited before a verdict was reached." };
    }
    if (response.status === 401) {
      return { ok: false, cause: "unauthorized", detail: "The API key was rejected." };
    }
    // **403 is treated as a verdict here, not folded into the "unknown"
    // no-write arm** -- a genuine rejection from a real endpoint is far more
    // likely than a proxy or gateway answering 403 on the provider's behalf,
    // and storing the credential with the integration off makes a bad
    // credential visible instead of silently producing empty summaries. For a
    // caller whose endpoint is an operator setting this is a closer call
    // (the same gateway concern that makes 429 untrusted there); see
    // `./openai.ts` for the ruling on that tension for this provider.
    if (response.status === 403) {
      return { ok: false, cause: "unauthorized", detail: "Access was refused for this API key." };
    }
    if (response.status === 404) {
      return { ok: false, cause: "unexpected", detail: "No such model or endpoint (404)." };
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
    return transportFailure(providerName, error, `Could not reach the ${providerName} API.`);
  }
}
