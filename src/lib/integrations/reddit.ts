import { PROBE_TIMEOUT_MS, type ProbeResult } from "./probe";

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
  userAgent: string;
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

  // btoa rather than Buffer: this module reaches only fetch and
  // AbortSignal.timeout, both universal globals, and Buffer is Node-specific.
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const body = new URLSearchParams({ grant_type: "client_credentials" });

  try {
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
