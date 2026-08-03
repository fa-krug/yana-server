import { PROBE_TIMEOUT_MS, readJson, transportFailure, type ProbeResult } from "./probe";

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
  userAgent: string;
}

/**
 * Base64 of `clientId:clientSecret`, byte-for-byte equal to what
 * `Buffer.from(s, "utf8").toString("base64")` produces.
 *
 * `btoa()` alone is not enough: it requires every code unit of its input to
 * be in the range 0-255 and throws `InvalidCharacterError` for anything above
 * U+00FF (an accented letter, a curly quote, an emoji), and even for code
 * units it accepts (0x80-0xFF) it treats the JS string as one byte per
 * UTF-16 code unit rather than UTF-8, so a two-byte UTF-8 character becomes
 * one wrong byte instead. Encoding to UTF-8 bytes first and then mapping each
 * byte back to the code point of the same numeric value produces a string
 * that is a legal `btoa` input by construction -- every code unit is already
 * 0-255 -- while representing the real UTF-8 bytes underneath.
 *
 * That remapping is a plain loop rather than
 * `String.fromCharCode(...utf8Bytes)`, which spreads the whole byte array
 * into a single call's argument list -- fine for a short credential, but
 * with no bound here worth relying on. It is also deliberately **not**
 * `TextDecoder("latin1")`: despite the name, the WHATWG Encoding Standard
 * defines the `"latin1"` label as an alias for **windows-1252**, not a
 * byte-identity ISO-8859-1 decode, so it remaps exactly the 0x80-0x9F range
 * -- which is where UTF-8 continuation bytes live -- to unrelated code
 * points (curly quotes, "Y with diaeresis", …) instead of passing them
 * through untouched. Caught by `reddit.test.ts` asserting this function's
 * output against `Buffer.from(s, "utf8").toString("base64")` on a credential
 * built from exactly that byte range, rather than reasoning about it.
 */
function toBasicAuthBase64(value: string): string {
  const utf8Bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of utf8Bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * One client-credentials token request against Reddit's OAuth endpoint.
 *
 * Shared between {@link testRedditCredentials} (which only needs to know
 * whether the exchange succeeded) and the identifier-search action in
 * `src/lib/aggregators/search.ts` (which needs the token itself to call
 * `/subreddits/search`). Never rejects for an HTTP-level failure -- only a
 * genuine transport failure (network, timeout) throws, exactly like every
 * other probe in this file.
 */
export async function fetchRedditAccessToken({
  clientId,
  clientSecret,
  userAgent,
}: RedditCredentials): Promise<{ ok: true; token: string } | { ok: false; result: ProbeResult }> {
  // Encoded here, inside the caller's `try`, on purpose: `toBasicAuthBase64`
  // can throw on a hostile credential, and every probe in this codebase owes a
  // never-rejects contract that has to hold structurally rather than rest on an
  // argument about which characters a credential can contain.
  const credentials = toBasicAuthBase64(`${clientId}:${clientSecret}`);
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "User-Agent": userAgent,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });

  /**
   * **A 200 is not enough here: the token has to be in it.** See the note that
   * used to live on `testRedditCredentials` -- unchanged reasoning, just moved
   * with the code: an OAuth token endpoint has real answers that are `200` and
   * prove nothing about the credential (`{"error":"unsupported_grant_type"}` if
   * the form body ever changes, or an HTML interstitial to a flagged IP).
   */
  if (response.ok) {
    const tokenResponse = (await readJson(response)) as { access_token?: unknown } | null;
    if (typeof tokenResponse?.access_token === "string" && tokenResponse.access_token !== "") {
      return { ok: true, token: tokenResponse.access_token };
    }
    return {
      ok: false,
      result: { ok: false, cause: "unexpected", detail: "A 200 answer carried no access token." },
    };
  }
  if (response.status === 401) {
    return {
      ok: false,
      result: { ok: false, cause: "unauthorized", detail: "The client credentials were rejected." },
    };
  }
  if (response.status === 429) {
    // Not a verdict on the credential: Reddit sheds load at the edge, before
    // the Basic auth header is validated.
    return {
      ok: false,
      result: {
        ok: false,
        cause: "quota",
        detail: "Rate limited before the credentials could be checked.",
      },
    };
  }
  return {
    ok: false,
    result: { ok: false, cause: "unexpected", detail: `Unexpected status ${response.status}.` },
  };
}

/**
 * One client-credentials token request -- the cheapest call that proves the
 * client id and secret are accepted. Provider messages are classified rather
 * than forwarded, for the same reason as the YouTube probe: a raw body can
 * echo a submitted credential straight back into the page.
 */
export async function testRedditCredentials({
  clientId,
  clientSecret,
  userAgent,
}: RedditCredentials): Promise<ProbeResult> {
  // Reddit rate-limits a missing or generic User-Agent aggressively, so a
  // blank one is a doomed request -- refused before any HTTP call is made,
  // not after.
  if (userAgent.trim() === "") {
    return {
      ok: false,
      cause: "unauthorized",
      detail: "A descriptive User-Agent is required and none was configured.",
    };
  }

  try {
    const tokenResult = await fetchRedditAccessToken({ clientId, clientSecret, userAgent });
    if (!tokenResult.ok) return tokenResult.result;
    return { ok: true, detail: "Credentials accepted." };
  } catch (error) {
    return transportFailure("reddit", error, "Could not reach the Reddit API.");
  }
}
