# Phase 11b: Embeds & Media — Implementation Plan

> **Path note (post folder swap):** the Next.js app is the repository root and the
> Django tree is `old/`. Read Python paths below — `core/…`, `yana/…` — as
> `old/core/…` / `old/yana/…`, and treat `uv run …` commands as historical: `old/`
> is read-only reference and is not runnable as configured.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Structural. Interfaces and ordering are settled; per-module step lists refresh against the Python before execution.

**Goal:** Port the ~1.2k LOC of embed and media handling — YouTube and Dailymotion facades, Bluesky, Twitter/X, Tagesschau media, Reddit media — so `embed` blocks reach the client as typed data carrying canonical public URLs.

**Architecture:** Each provider is a module exposing one detection function and one conversion function, registered in a table the block parser consults. That replaces the Python's scattered handling with a single dispatch point, without changing observable output — the goldens hold the behaviour fixed while the structure improves.

**Tech Stack:** cheerio, sharp, phase 11a's block types and image pipeline.

## Global Constraints

- Embeds carry a **canonical public URL** in `externalUrl`, never a locally-proxied one. The `/api/youtube-proxy` and `/api/dailymotion-proxy` endpoints were removed from the Django server and must not be reintroduced in any form.
- `provider` must be one of `youtube`, `dailymotion`, `video`, `tweet`, `generic`. Anything unrecognized becomes `generic` — never fatal, never a new provider string.
- Thumbnails are **localized** through phase 11a's image store, becoming `yana-img://<hash>` in `thumbnailRef`. A remote thumbnail URL left in place is a privacy leak: it lets the provider track every reader who opens the article.
- No `<iframe>` markup is emitted anywhere. The client renders embeds natively from typed fields.
- Behaviour is defined by the Python source. The goldens are the arbiter.
- Each provider lands with its golden cases passing before the next begins.

---

## File Structure

| Path | Ports from | LOC |
|---|---|---|
| `src/lib/aggregators/embeds/registry.ts` | new — dispatch table | — |
| `src/lib/aggregators/embeds/youtube.ts` | `utils/youtube.py` | 233 |
| `src/lib/aggregators/embeds/dailymotion.ts` | part of `mein_mmo/embed_processors.py` | — |
| `src/lib/aggregators/embeds/bluesky.ts` | `utils/bluesky.py` | 304 |
| `src/lib/aggregators/embeds/twitter.ts` | `utils/twitter.py` | 281 |
| `src/lib/aggregators/embeds/processors.ts` | `mein_mmo/embed_processors.py` | 402 |
| `src/lib/aggregators/media/tagesschau.ts` | `tagesschau/media_processor.py` | 256 |
| `src/lib/aggregators/media/reddit.ts` | `reddit/images.py` | 346 |

---

### Task 1: The provider registry

**Interfaces:**
- `type EmbedProviderSpec = { key: EmbedProvider; detect: (element: Element, $: CheerioAPI) => boolean; convert: (element: Element, $: CheerioAPI, context: ExtractionContext) => Promise<EmbedBlock | null> }`
- `EMBED_PROVIDERS_REGISTRY: EmbedProviderSpec[]` — order matters, first match wins
- `convertEmbed(element, $, context): Promise<EmbedBlock | null>`

- [ ] Read `mein_mmo/embed_processors.py` first — it is the reference implementation the project's own docs point to, and its ordering decisions reveal which detections must precede which.
- [ ] Implement the registry with **explicit ordering** and a comment per entry stating why it sits where it does. A generic detector placed before a specific one silently swallows every specific case.
- [ ] `convertEmbed` returns `null` when nothing matches, and the caller drops the element. Test that an unrecognized embed produces no block rather than a `generic` one with an empty URL — an empty embed renders as a dead tap target on the client.

---

### Task 2: YouTube

**Interfaces:** `detectYoutube`, `convertYoutube`, `youtubeIdFrom(url): string | null`, `thumbnailUrlFor(id): string`

- [ ] Read `utils/youtube.py` and `utils/youtube_client.py` (328 LOC). Only the URL/ID/thumbnail parts belong here; the API client belongs to phase 11c's YouTube aggregator.
- [ ] Port `youtubeIdFrom` covering every form the Python handles — `watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`, `/live/`, and ids inside iframe `src` attributes. Table-driven test, one row per form, including the malformed inputs that must return `null`.
- [ ] `externalUrl` is the canonical `https://www.youtube.com/watch?v=<id>`, regardless of which form was found. This is what makes the facade replacement observable in the goldens.
- [ ] Localize the thumbnail through phase 11a's `storeImage` and set `thumbnailRef`. Note that the highest-resolution thumbnail is not always present — port the Python's fallback order rather than assuming `maxresdefault` exists.

---

### Task 3: Dailymotion

- [ ] Extract the Dailymotion handling from `embed_processors.py`. The docs record a past bug where facades were built and then deleted immediately afterwards (commit `5e774a0`); read that fix before porting so the ordering it corrected is preserved.
- [ ] Same shape as YouTube: canonical URL, localized thumbnail, `provider: "dailymotion"`.

---

### Task 4: Bluesky and Twitter/X

- [ ] Port `utils/bluesky.py` (304 LOC) and `utils/twitter.py` (281 LOC). Both resolve post metadata and produce `provider: "tweet"` blocks — check the Python for which provider string each actually emits rather than assuming.
- [ ] `core/tests/test_bluesky_embed.py`, `test_twitter_embed.py` and `test_embed_privacy.py` exist. Port their assertions, especially the privacy ones: `test_embed_privacy.py` is a guard against exactly the remote-thumbnail leak this phase must not reintroduce.

---

### Task 5: Tagesschau and Reddit media

- [ ] Port `tagesschau/media_processor.py` (256 LOC). Commit `ce04fdc` localized its player preview images to `yana-img://` refs — that behaviour is required, not optional.
- [ ] Port `reddit/images.py` (346 LOC): galleries, previews, video, and the large-GIF case that motivated iOS's 64 MB cap. Confirm phase 11a's image cap does not drop these; if it does, the cap is wrong, not the fixture.

---

### Task 6: Wire into the parser and close the goldens

- [ ] Replace phase 11a Task 5's declared embed stub with `convertEmbed`.
- [ ] Run the full corpus. Every embed-bearing case must now pass; only phase 11c's scraper-specific cases may remain skipped.
- [ ] Remove the corresponding entries from 11a Task 9's skip list. The shrink assertion added there should force this.
- [ ] Add a test asserting **no block anywhere in the corpus** has an `externalUrl` containing `youtube-proxy` or `dailymotion-proxy`, and none has a `thumbnailRef` that is a remote URL. Both are regression guards for removals the project already paid for once.

---

## Self-Review

**Spec coverage.** Against the direction record's 11b scope: `mein_mmo/embed_processors` (Tasks 1, 3), `bluesky` and `twitter` (Task 4), `youtube` (Task 2), Tagesschau and Reddit media processors (Task 5). Complete.

**Placeholder scan.** Structural by design. Interfaces are exact; the non-obvious constraints are all stated — registry ordering and its failure mode, canonical-URL rule, thumbnail localization as a privacy requirement rather than an optimization, `null` over empty-`generic`, and the three prior fixes (`5e774a0`, `ce04fdc`, the proxy removal) whose behaviour must survive the port.

**Type consistency.** `EmbedBlock` and `EmbedProvider` come from phase 11a Task 1. `ExtractionContext` is 11a's. `storeImage` returning `yana-img://<hash>` is 11a Task 6's contract, consumed here unchanged.

**One risk.** Task 5's Reddit GIF case tests phase 11a's image cap from the other side. If the cap turns out too tight, fixing it means changing 11a code after 11a was signed off — worth expecting rather than treating as a regression. The cap's value was explicitly flagged in 11a Task 6 as the phase's one deliberate behaviour change, for this reason.
