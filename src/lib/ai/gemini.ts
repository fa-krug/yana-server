import {
  PROBE_TIMEOUT_MS,
  readJson,
  transportFailure,
  type ProbeResult,
} from "@/lib/integrations/probe";

import { GEMINI_API_BASE_URL } from "./providers";

/**
 * Fixed: `hasCustomUrl` is `false` for this provider, so there is nothing to
 * configure. The base URL itself lives in `./providers`
 * (`GEMINI_API_BASE_URL`) rather than as a private copy here, so this probe
 * and `run.ts`'s `callGemini()` cannot drift apart on the host.
 */
const GEMINI_API_BASE = GEMINI_API_BASE_URL;

/** Whether a `google.rpc.ErrorInfo` detail says the key itself was refused. */
function saysKeyInvalid(details: unknown): boolean {
  if (!Array.isArray(details)) return false;
  return details.some(
    (detail) =>
      typeof detail === "object" &&
      detail !== null &&
      (detail as { reason?: unknown }).reason === "API_KEY_INVALID",
  );
}

/**
 * One 1-token generation -- the cheapest call that proves the key and the model
 * id work together.
 *
 * **The key travels in a header, not the query string.** Google's own docs show
 * both `?key=` and `x-goog-api-key`, and the header is chosen deliberately: a
 * URL with the secret in it ends up in a `fetch` failure message, and
 * `logUnreachable()` reads only `.code` for exactly that reason (see the note
 * on the YouTube probe, whose endpoint has no header form). Keeping the key out
 * of the URL removes the hazard rather than working around it.
 *
 * **This probe judges the status alone, like YouTube's and unlike Reddit's.**
 * `generateContent` has two legitimate empty-but-valid 200s and requiring a
 * field would reject a working key on both: a single-token budget spent on
 * thinking returns a candidate with `finishReason: "MAX_TOKENS"` and no parts,
 * and a project with strict safety settings can answer with `promptFeedback`
 * and no candidates at all. A 200 from the Google API frontend is an answer
 * from the API, which is what the status is being trusted for.
 */
export async function testGeminiKey({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): Promise<ProbeResult> {
  // URL building and header construction happen inside the try, with the
  // request: this function resolves to a classified ProbeResult for every
  // input and never rejects, and that must hold structurally rather than by an
  // argument about which characters a model id or a key can contain. A model id
  // with a slash or a space is encoded; a key with a newline makes an illegal
  // header value and `fetch` rejects -- caught here, not escaped.
  try {
    const url = `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "hi" }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (response.ok) return { ok: true, detail: "Key accepted." };

    const body = (await readJson(response)) as { error?: { details?: unknown } } | null;

    // **A 400 is where Google puts a rejected API key, and also where it puts
    // our own mistakes.** `API_KEY_INVALID` and a malformed `generationConfig`
    // both arrive as `400 INVALID_ARGUMENT`; only the `google.rpc.ErrorInfo`
    // reason separates them. Reading it is what keeps a bad request of ours
    // from being reported to the operator as a rejected key -- which, under the
    // write-on-rejection rule in `define.ts`, would store the credential and
    // switch the integration off over a bug in this file. Checked before the
    // generic status arms for that reason.
    if (saysKeyInvalid(body?.error?.details)) {
      return { ok: false, cause: "unauthorized", detail: "The API key was rejected." };
    }
    if (response.status === 401) {
      return { ok: false, cause: "unauthorized", detail: "The API key was rejected." };
    }
    if (response.status === 403) {
      return { ok: false, cause: "unauthorized", detail: "Access was refused for this API key." };
    }
    if (response.status === 429) {
      // **A rate limit here does prove the credential was accepted**, and this
      // provider's declaration says so (`quotaMeansVerified: true` in
      // `providers.ts`, where this paragraph is deliberately duplicated because
      // the fact and this branch live in different files -- change both) -- for
      // the same stated reason as YouTube's, not by inheriting it.
      // Quota is accounted against the *project the key resolves
      // to*, so the key is validated first; a key Google does not recognise
      // answers `400 API_KEY_INVALID` and never reaches accounting. The
      // endpoint is fixed, so nothing can shed load in front of that check.
      // The cost of this answer is the free tier, where a model with no
      // remaining daily quota is indistinguishable from a momentary burst; both
      // store the key and switch the integration on, and the operator is told
      // it is rate limited.
      return {
        ok: false,
        cause: "quota",
        detail: "Rate limited or out of quota. The key itself is valid.",
      };
    }
    // Neither is a verdict about the credential, so both write nothing.
    if (response.status === 404) {
      return {
        ok: false,
        cause: "unexpected",
        detail: "No such model or API version (404).",
      };
    }
    if (response.status === 400) {
      return {
        ok: false,
        cause: "unexpected",
        detail: "The API rejected the request as malformed (400).",
      };
    }
    return { ok: false, cause: "unexpected", detail: `Unexpected status ${response.status}.` };
  } catch (error) {
    return transportFailure("gemini", error, "Could not reach the Gemini API.");
  }
}
