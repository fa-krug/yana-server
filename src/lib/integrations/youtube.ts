import { PROBE_TIMEOUT_MS, transportFailure, type ProbeResult } from "./probe";

/**
 * One minimal authenticated call. Costs 1 quota unit, which is the cheapest
 * request that still proves the key works.
 *
 * Provider messages are classified rather than forwarded: a raw body can echo
 * the submitted key straight back into the page.
 *
 * **This probe judges the status, not the body -- deliberately, and unlike the
 * Reddit one.** `channels?part=id&forHandle=…` legitimately answers
 * `200 {"items": []}` when a handle does not resolve, so a good key can produce
 * an empty result: requiring a field in the body would report a working key as
 * broken and, under the write-on-rejection rule in `./actions`, overwrite it
 * with nothing gained. Reddit's token endpoint has no such empty-but-valid
 * answer, which is why it does check its body. Do not "align" the two.
 */
export async function testYoutubeKey(apiKey: string): Promise<ProbeResult> {
  // Inside the try, with the request: this function's contract is that it
  // resolves to a classified ProbeResult and never rejects, and that has to
  // hold structurally rather than by an argument about which characters `URL`
  // and `URLSearchParams` accept. (Reddit's probe encodes inside its try for
  // exactly the same reason -- phase 7 copies one of these two.)
  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/channels");
    url.searchParams.set("part", "id");
    url.searchParams.set("forHandle", "@youtube");
    url.searchParams.set("key", apiKey);

    const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (response.ok) return { ok: true, detail: "Key accepted." };

    const body = (await response.json().catch(() => ({}))) as {
      error?: { errors?: { reason?: string }[]; status?: string };
    };

    // Same 403 status as a rejected key, but the operator's next action
    // differs: the key is fine, only today's quota is gone. Checked before
    // the generic status check below for exactly that reason.
    //
    // **Two envelopes, and the second one is a deliberate belt-and-braces.**
    // The legacy `error.errors[0].reason` is what Google documents and what a
    // live credential-free call still returns; `error.status` is the newer
    // google.rpc code it now populates alongside it (a live 403 carries
    // `"PERMISSION_DENIED"`, verified). If a future envelope drops `reason`, a
    // quota answer would silently degrade to `unauthorized` -- which in
    // `./actions` stores the key with the integration switched off, so an
    // operator whose only fault was a spent daily budget would be told their
    // key was rejected. Reading both makes that a non-event.
    const reason = body.error?.errors?.[0]?.reason ?? "";
    if (
      reason === "quotaExceeded" ||
      reason === "dailyLimitExceeded" ||
      body.error?.status === "RESOURCE_EXHAUSTED"
    ) {
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
    return transportFailure("youtube", error, "Could not reach the YouTube API.");
  }
}
