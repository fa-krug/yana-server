import { PROBE_TIMEOUT_MS, type ProbeResult } from "./probe";

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

  // Encoding happens inside the try, alongside the request: this function's
  // whole contract is that it resolves to a classified ProbeResult and never
  // rejects, and that must hold structurally rather than by argument about
  // which characters a client id or secret can contain.
  try {
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

    if (response.ok) return { ok: true, detail: "Credentials accepted." };
    if (response.status === 401) {
      return { ok: false, cause: "unauthorized", detail: "The client credentials were rejected." };
    }
    if (response.status === 429) {
      return {
        ok: false,
        cause: "quota",
        detail: "Rate limited. The credentials themselves are valid.",
      };
    }
    return { ok: false, cause: "unexpected", detail: `Unexpected status ${response.status}.` };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return { ok: false, cause: "timeout", detail: "The request timed out." };
    }
    return { ok: false, cause: "network", detail: "Could not reach the Reddit API." };
  }
}
