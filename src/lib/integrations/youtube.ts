import { PROBE_TIMEOUT_MS, type ProbeResult } from "./probe";

/**
 * One minimal authenticated call. Costs 1 quota unit, which is the cheapest
 * request that still proves the key works.
 *
 * Provider messages are classified rather than forwarded: a raw body can echo
 * the submitted key straight back into the page.
 */
export async function testYoutubeKey(apiKey: string): Promise<ProbeResult> {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "id");
  url.searchParams.set("forHandle", "@youtube");
  url.searchParams.set("key", apiKey);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (response.ok) return { ok: true, detail: "Key accepted." };

    const body = (await response.json().catch(() => ({}))) as {
      error?: { errors?: { reason?: string }[] };
    };
    const reason = body.error?.errors?.[0]?.reason ?? "";

    // Same 403 status as a rejected key, but the operator's next action
    // differs: the key is fine, only today's quota is gone. Checked before
    // the generic status check below for exactly that reason.
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
      return {
        ok: false,
        cause: "quota",
        detail: "Daily quota exhausted. The key itself is valid.",
      };
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      return { ok: false, cause: "unauthorized", detail: "The API key was rejected." };
    }
    return { ok: false, cause: "unexpected", detail: `Unexpected status ${response.status}.` };
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return { ok: false, cause: "timeout", detail: "The request timed out." };
    }
    return { ok: false, cause: "network", detail: "Could not reach the YouTube API." };
  }
}
