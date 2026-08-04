# Mein-MMO Bluesky Rich Embed Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Mein-MMO aggregator's Bluesky (bsky.app) embed handling fetch the real post from the public Bluesky API and render a rich HTML card (author, text, images, stats), matching `old/core/aggregators/utils/bluesky.py`'s `build_bluesky_embed_html` (the Django origin both the TS server and the iOS app were ported from) instead of the current static "View on Bluesky" link.

**Architecture:** `src/lib/aggregators/embeds/bluesky.ts` already has DID resolution + Bluesky API fetch helpers (built for a different, currently-unwired `EmbedBlock` pipeline) — this plan adds a new exported `buildBlueskyEmbedHtml()` next to them that reuses those helpers to build HTML, mirroring the Python function line-for-line. Wiring that into Mein-MMO's per-figure embed processing requires the Mein-MMO content-extraction path to become async (it currently is not), which is a small, controlled widening of one already-optional return type (`BaseAggregator.extractContent`) plus one `await` at its single call site.

**Tech Stack:** TypeScript, Cheerio, Vitest.

## Global Constraints

- Line length 100, double quotes, semicolons, trailing commas (Prettier owns this).
- No dependency changes.
- `npm run lint && npm run format:check && npm run typecheck && npm test` must all pass before any task is considered done.
- Every new/changed file follows this repo's convention: comments only where the *why* is non-obvious (a design decision, a matched-failure-mode, a security reason) — never comments restating what code does.
- Match `old/core/aggregators/utils/bluesky.py` and `old/core/aggregators/mein_mmo/embed_processors.py`'s `BlueskyEmbedProcessor` behavior exactly (see "Investigation notes" below) — that Python is the authoritative oracle for this feature, not iOS (iOS's rich Bluesky render is itself a port of this same Python; the earlier audit that recommended this work initially compared against iOS's legacy raw-HTML `Yana/Aggregators/` pipeline, which is a *different* concern — see the explicit "Not in scope" section below).

## Investigation notes (read before starting)

Two facts, established by reading `old/core/aggregators/mein_mmo/embed_processors.py` and its test file `old/core/tests/test_bluesky_embed.py`, drive every design decision below:

1. **On fetch/build failure, the whole `<figure>` is removed, not replaced with a fallback link.** Django's generic figure-processing loop (`embed_processors.py:387-398`) does: try each processor's `can_handle()`; on match, call `process()`; if it returns a truthy replacement, `figure.replace_with(replacement)`; **if it returns `None`/falsy, `figure.decompose()` — the figure is deleted entirely.** `BlueskyEmbedProcessor.process()` returns `None` whenever `build_bluesky_embed_html()` returns `None` (invalid URL, DID resolution failure, or the post fetch itself failing) — see `test_process_removes_figure_when_embed_fails` in the Python test file. The current TS `BlueskyEmbedProcessor` in `src/lib/aggregators/sites/mein_mmo/embeds.ts:187-224` does not match this: it always succeeds with a static link, because `buildBlueskyEmbedHtmlSync()` never touches the network. That sync fallback function is being deleted, not preserved as a failure fallback.
2. **The rich HTML embeds the Bluesky CDN image URLs directly (`<img src="https://cdn.bsky.app/...">`), with no localization/download step inside `build_bluesky_embed_html` itself.** Localization happens later and generically: `src/lib/aggregators/sites/mein_mmo/content.ts:116-125` already rewrites every `<img src>` inside the extracted content (via `storeImageRefFromUrlSync`) after `processEmbeds()` runs, exactly the same way it already does for `RedditEmbedProcessor`'s embedded thumbnail (`embeds.ts:149-164`). No new localization code is needed in this plan — placing plain CDN URLs in the new function's output is correct, and this pass will pick them up automatically since it runs after `processEmbeds()` in the same function.

**Why this needs new async plumbing:** Django's `build_bluesky_embed_html` makes a blocking `requests.get()` call, which is unremarkable in a synchronous Python worker. Node has no synchronous `fetch`, so the same real API call in TypeScript must be `await`ed. Mein-MMO's current figure-processing (`processEmbeds`) is fully synchronous and is called from `extractContent()` (a method the whole codebase treats as synchronous: `BaseAggregator.extractContent(html, article): string` in `src/lib/aggregators/base.ts:208`). Tasks 1–3 below thread a `Promise<string>` return type through exactly the files that need it — `base.ts`, `website.ts`'s one call site, `mein_mmo/{aggregator,content,embeds}.ts`, and one test file — leaving every other aggregator's synchronous `extractContent` override untouched (TypeScript permits a subclass to return a narrower type than its base class declares, so `merkur.ts`'s and every other site's plain-`string` overrides remain valid without any change).

## Not in scope (found during investigation, explicitly rejected)

The original audit (comparing against iOS's `Yana/Aggregators/EmbedRewriter.swift`) also flagged that TS's YouTube/Dailymotion "facades" have no poster thumbnail or click-to-play JS, unlike iOS's legacy standalone renderer. **Do not implement that.** `old/core/aggregators/utils/youtube.py`'s `build_youtube_facade_html` docstring states this explicitly: *"There is no iframe and no proxy endpoint: the client renders the typed `embed` block natively with its own privacy-mode player, so the server's only job is to carry the video id through the HTML stage of the pipeline."* The facade HTML is an intermediate carrier format that `src/lib/aggregators/blocks/parser.ts`'s `embedFacade()` converts into a typed `EmbedBlock { provider, externalUrl, thumbnailRef, title }` — any `onclick`/iframe-swap trickery placed in the HTML would be silently discarded at that conversion step and would never reach any client. iOS's `EmbedRewriter.swift` click-to-play HTML belongs to its legacy standalone `Yana/Aggregators/` pipeline, which the project's direction record (`docs/superpowers/specs/2026-07-29-client-server-remigration-direction.md`) says is slated for deletion — it is not the target architecture and must not be replicated server-side.

## Task 1: Widen `extractContent` to allow an async override

**Files:**
- Modify: `src/lib/aggregators/base.ts:208`
- Modify: `src/lib/aggregators/website.ts:160`
- Modify: `src/lib/parity/corpus.test.ts:84`

**Interfaces:**
- Produces: `BaseAggregator.extractContent(html: string, article: RawArticle): string | Promise<string>` — the new declared return type every subclass override is checked against. Every existing subclass keeps returning a plain `string` (a valid narrowing); only `MeinMmoAggregator` (Task 4) will return `Promise<string>`.

This task has no new behavior of its own — it only removes the type-level restriction that prevents Task 4. There is nothing to TDD here; the check is that the full existing suite still passes after the two mechanical edits.

- [ ] **Step 1: Confirm the baseline passes**

Run: `npm run typecheck && npm test`
Expected: PASS (establishes that any later failure is caused by this task's edits, not pre-existing).

- [ ] **Step 2: Widen the base class signature**

In `src/lib/aggregators/base.ts`, change:

```ts
  extractContent(html: string, _article: RawArticle): string {
    return html;
  }
```

to:

```ts
  extractContent(html: string, _article: RawArticle): string | Promise<string> {
    return html;
  }
```

- [ ] **Step 3: Await it at its one call site**

In `src/lib/aggregators/website.ts`, inside `enrichArticles()`, change:

```ts
        const content = this.extractContent(rawHtml, article);
```

to:

```ts
        const content = await this.extractContent(rawHtml, article);
```

(This method is already `async` and already awaits `this.processContent(...)` on the next line, so no other change is needed here.)

- [ ] **Step 4: Await it in the golden-corpus test loop**

In `src/lib/parity/corpus.test.ts`, change:

```ts
        const extracted = agg.extractContent(fixtureContent, rawArticle);
```

to:

```ts
        const extracted = await agg.extractContent(fixtureContent, rawArticle);
```

(`await` on a plain `string` is a no-op, so every currently-passing case for every other aggregator is unaffected.)

- [ ] **Step 5: Run the full check suite**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: PASS, identical results to Step 1 (mein_mmo cases remain in `SKIP_LIST` and are not exercised by this task).

- [ ] **Step 6: Commit**

```bash
git add src/lib/aggregators/base.ts src/lib/aggregators/website.ts src/lib/parity/corpus.test.ts
git commit -m "refactor(aggregators): allow extractContent to return a Promise"
```

## Task 2: Add `buildBlueskyEmbedHtml` to the Bluesky embed module

**Files:**
- Modify: `src/lib/aggregators/embeds/bluesky.ts`
- Create: `src/lib/aggregators/embeds/bluesky.test.ts`

**Interfaces:**
- Consumes: the file's own existing (currently module-private) `extractBlueskyPostInfo` (exported already), `fetchBlueskyPost(actor: string, rkey: string): Promise<Record<string, unknown> | null>`, and `extractImageUrls(post: Record<string, unknown>): string[]` — all defined earlier in this same file, so no export changes are needed to reach them from a new function in the same module.
- Produces (for Task 3): `export async function buildBlueskyEmbedHtml(url: string): Promise<string | null>` — returns `null` when the URL isn't a Bluesky post URL, DID resolution fails, or the post fetch fails; otherwise a self-contained HTML `<blockquote>...</blockquote>` string.
- Produces (public, testable in their own right): `export function formatBlueskyCount(count: number): string` and `export function formatBlueskyPostDate(createdAt: string): string | null`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/aggregators/embeds/bluesky.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildBlueskyEmbedHtml, formatBlueskyCount, formatBlueskyPostDate } from "./bluesky";
import * as cheerio from "cheerio";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const SAMPLE_POST = {
  author: {
    handle: "stirpicus.bsky.social",
    displayName: "eric stirpe",
  },
  record: {
    text: "This is a test post.",
    createdAt: "2026-06-04T04:34:34.364Z",
  },
  likeCount: 3275,
  repostCount: 868,
  replyCount: 20,
  embed: {
    $type: "app.bsky.embed.images#view",
    images: [{ fullsize: "https://cdn.bsky.app/img/1.jpg" }],
  },
};

/** Routes the two Bluesky API calls `buildBlueskyEmbedHtml` makes: DID resolution, then the post fetch. */
function mockBlueskyApi(post: Record<string, unknown> | null) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("resolveHandle")) {
      return { ok: true, json: async () => ({ did: "did:plc:test123" }) };
    }
    return { ok: true, json: async () => ({ posts: post ? [post] : [] }) };
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe("formatBlueskyCount", () => {
  it("returns small counts verbatim", () => {
    expect(formatBlueskyCount(0)).toBe("0");
    expect(formatBlueskyCount(999)).toBe("999");
  });

  it("formats thousands with one decimal", () => {
    expect(formatBlueskyCount(1234)).toBe("1.2K");
  });

  it("formats millions with one decimal", () => {
    expect(formatBlueskyCount(1_500_000)).toBe("1.5M");
  });
});

describe("formatBlueskyPostDate", () => {
  it("formats a valid ISO date", () => {
    expect(formatBlueskyPostDate("2026-06-04T04:34:34.364Z")).toBe("Jun 04, 2026");
  });

  it("returns null for an unparseable date", () => {
    expect(formatBlueskyPostDate("not a date")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(formatBlueskyPostDate("")).toBeNull();
  });
});

describe("buildBlueskyEmbedHtml", () => {
  it("renders author, text, image and stats for a full post", async () => {
    mockBlueskyApi(SAMPLE_POST);

    const result = await buildBlueskyEmbedHtml(
      "https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27",
    );

    expect(result).not.toBeNull();
    expect(result).toContain("<blockquote");
    expect(result).toContain("eric stirpe");
    expect(result).toContain("@stirpicus.bsky.social");
    expect(result).toContain("This is a test post.");
    expect(result).toContain("View on Bluesky");
    expect(result).toContain("https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27");
    expect(result).toContain("https://cdn.bsky.app/img/1.jpg");
    expect(result).toContain("3.3K");
    expect(result).toContain("868");
    expect(result).toContain("Jun 04, 2026");
  });

  it("omits the image paragraph when the post has none", async () => {
    mockBlueskyApi({
      author: { handle: "user.bsky.social", displayName: "" },
      record: { text: "Text only post.", createdAt: "" },
      likeCount: 0,
      repostCount: 0,
      replyCount: 0,
      embed: {},
    });

    const result = await buildBlueskyEmbedHtml("https://bsky.app/profile/user.bsky.social/post/abc");

    expect(result).not.toBeNull();
    expect(result).toContain("Text only post.");
    expect(result).not.toContain("<img");
  });

  it("strips tracking params from the post URL", async () => {
    mockBlueskyApi(SAMPLE_POST);

    const result = await buildBlueskyEmbedHtml(
      "https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27?foo=bar",
    );

    expect(result).not.toBeNull();
    expect(result).not.toContain("?foo=bar");
    expect(result).toContain("https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27");
  });

  it("HTML-escapes post text and author name", async () => {
    mockBlueskyApi({
      author: { handle: "user.bsky.social", displayName: "User <bad>" },
      record: { text: "Test <script>alert('xss')</script> & more", createdAt: "" },
      likeCount: 0,
      repostCount: 0,
      replyCount: 0,
      embed: {},
    });

    const result = await buildBlueskyEmbedHtml("https://bsky.app/profile/user.bsky.social/post/abc");

    expect(result).not.toBeNull();
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
    expect(result).toContain("&amp; more");
    expect(result).toContain("User &lt;bad&gt;");
  });

  it("returns null for a non-post URL", async () => {
    const result = await buildBlueskyEmbedHtml("https://example.com/not-a-post");
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns null when the API has no matching post", async () => {
    mockBlueskyApi(null);
    const result = await buildBlueskyEmbedHtml("https://bsky.app/profile/user.bsky.social/post/abc");
    expect(result).toBeNull();
  });

  it("skips a javascript: post URL as a link but still renders the card", async () => {
    mockBlueskyApi(SAMPLE_POST);
    // Not a realistic URL shape (fails extractBlueskyPostInfo's own pattern in practice),
    // so this exercises the is_safe_url guard on a URL that already matched a profile/post path.
    const result = await buildBlueskyEmbedHtml(
      "https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27",
    );
    expect(result).not.toBeNull();
    const $ = cheerio.load(result!);
    expect($("script").length).toBe(0);
  });

  it("skips an unsafe image URL rather than rendering it", async () => {
    mockBlueskyApi({
      ...SAMPLE_POST,
      embed: {
        $type: "app.bsky.embed.images#view",
        images: [{ fullsize: "javascript:alert(1)" }],
      },
    });

    const result = await buildBlueskyEmbedHtml(
      "https://bsky.app/profile/stirpicus.bsky.social/post/3mngsbu7t2s27",
    );

    expect(result).not.toBeNull();
    const $ = cheerio.load(result!);
    expect($("img").length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/aggregators/embeds/bluesky.test.ts`
Expected: FAIL — `buildBlueskyEmbedHtml`, `formatBlueskyCount`, `formatBlueskyPostDate` are not exported from `./bluesky` yet.

- [ ] **Step 3: Implement**

In `src/lib/aggregators/embeds/bluesky.ts`, add two imports at the top (alongside the existing ones):

```ts
import { escapeHtml } from "../extract/format";
import { isSafeUrl } from "../blocks/parser";
```

Then append the following at the end of the file (after the existing `registerEmbedProvider({...})` call, so it doesn't disturb that self-registration block):

```ts
/** Format an engagement count for display (e.g. 1234 -> "1.2K"). */
export function formatBlueskyCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Format an ISO 8601 Bluesky date string for display, or null if unparseable.
 * Uses UTC getters and a fixed month-name table rather than Intl: the input
 * is always UTC ("...Z"), and this avoids the display depending on the
 * server process's locale.
 */
export function formatBlueskyPostDate(createdAt: string): string | null {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  const month = MONTH_ABBREVIATIONS[date.getUTCMonth()]!;
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${month} ${day}, ${date.getUTCFullYear()}`;
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === "string" ? value : "";
}

function numberField(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  return typeof value === "number" ? value : 0;
}

/**
 * Build a rich HTML embed for a Bluesky post.
 *
 * Ported from old/core/aggregators/utils/bluesky.py's build_bluesky_embed_html.
 * Fetches post data from the public Bluesky API and renders it as a styled
 * blockquote with author info, post text, images, and engagement stats.
 *
 * Returns null when the URL isn't a post URL or the API fetch fails. The
 * caller (mein_mmo's BlueskyEmbedProcessor) removes the figure entirely in
 * that case -- matching the Python original, which never falls back to a
 * bare link.
 */
export async function buildBlueskyEmbedHtml(url: string): Promise<string | null> {
  const info = extractBlueskyPostInfo(url);
  if (!info) return null;

  const post = await fetchBlueskyPost(info.actor, info.rkey);
  if (!post) return null;

  const record = (post.record ?? {}) as Record<string, unknown>;
  const author = (post.author ?? {}) as Record<string, unknown>;
  const text = stringField(record, "text");
  const displayName = stringField(author, "displayName");
  const handle = stringField(author, "handle");
  const likes = numberField(post, "likeCount");
  const reposts = numberField(post, "repostCount");
  const replies = numberField(post, "replyCount");
  const createdAt = stringField(record, "createdAt");

  const cleanUrl = url.split("?")[0]!;

  const parts: string[] = [
    '<blockquote style="border-left: 3px solid #0085ff; padding: 12px 16px; ' +
      'margin: 1em 0; background: #f7f9fa;">',
  ];

  // clean_url and every image URL below are attacker-reachable (they come
  // from the source page), so each needs both an escape (for the attribute
  // context) and a scheme check via isSafeUrl -- escaping alone doesn't stop
  // a well-formed but unescaped javascript: URL.
  const authorDisplay = displayName || (handle ? `@${handle}` : "");
  const handleSuffix = displayName && handle ? ` (@${handle})` : "";
  const linkHtml = isSafeUrl(cleanUrl)
    ? `<a href="${escapeHtml(cleanUrl)}" target="_blank" rel="noopener">View on Bluesky</a>`
    : "View on Bluesky";
  parts.push(
    `<p style="margin: 0 0 8px 0;"><strong>${escapeHtml(authorDisplay)}</strong>` +
      `${escapeHtml(handleSuffix)} · ${linkHtml}</p>`,
  );

  if (text) {
    parts.push(`<p style="margin: 0 0 8px 0; white-space: pre-wrap;">${escapeHtml(text)}</p>`);
  }

  for (const imageUrl of extractImageUrls(post)) {
    if (!isSafeUrl(imageUrl)) continue;
    parts.push(
      `<p><img src="${escapeHtml(imageUrl)}" alt="Bluesky image" ` +
        `style="max-width: 100%; border-radius: 8px;"></p>`,
    );
  }

  const statsParts: string[] = [];
  if (likes) statsParts.push(`&#9829; ${formatBlueskyCount(likes)}`);
  if (reposts) statsParts.push(`&#128257; ${formatBlueskyCount(reposts)}`);
  if (replies) statsParts.push(`&#128172; ${formatBlueskyCount(replies)}`);
  const formattedDate = createdAt ? formatBlueskyPostDate(createdAt) : null;
  if (formattedDate) statsParts.push(formattedDate);

  if (statsParts.length > 0) {
    parts.push(
      `<p style="margin: 0; color: #536471; font-size: 0.9em;">${statsParts.join(" · ")}</p>`,
    );
  }

  parts.push("</blockquote>");

  return parts.join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/aggregators/embeds/bluesky.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Run the full check suite**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/aggregators/embeds/bluesky.ts src/lib/aggregators/embeds/bluesky.test.ts
git commit -m "feat(aggregators): add rich HTML Bluesky embed builder"
```

## Task 3: Wire the rich embed into Mein-MMO's figure processing

**Files:**
- Modify: `src/lib/aggregators/sites/mein_mmo/embeds.ts`
- Create: `src/lib/aggregators/sites/mein_mmo/embeds.test.ts`

**Interfaces:**
- Consumes: `buildBlueskyEmbedHtml(url: string): Promise<string | null>` from Task 2 (`../../embeds/bluesky`).
- Produces (for Task 4): `export async function processEmbeds($content: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI): Promise<void>` — same name, now async; callers must `await` it.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/aggregators/sites/mein_mmo/embeds.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as cheerio from "cheerio";
import { processEmbeds } from "./embeds";

vi.mock("../../embeds/bluesky", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../embeds/bluesky")>();
  return { ...actual, buildBlueskyEmbedHtml: vi.fn() };
});

import { buildBlueskyEmbedHtml } from "../../embeds/bluesky";

const mockBuildBluesky = vi.mocked(buildBlueskyEmbedHtml);

beforeEach(() => {
  mockBuildBluesky.mockReset();
});

describe("processEmbeds - Bluesky", () => {
  it("replaces the figure with the rich embed when the build succeeds", async () => {
    mockBuildBluesky.mockResolvedValue("<blockquote><p>Bluesky post text</p></blockquote>");

    const $ = cheerio.load(
      '<div class="entry-content"><figure class="wp-block-embed">' +
        '<a href="https://bsky.app/profile/user.bsky.social/post/abc">link</a>' +
        "</figure></div>",
    );
    const $content = $(".entry-content");

    await processEmbeds($content, $);

    expect($content.find("figure").length).toBe(0);
    expect($content.html()).toContain("Bluesky post text");
    expect($content.find('div[data-sanitized-class="bluesky-embed"]').length).toBe(1);
  });

  it("removes the figure entirely when the build fails", async () => {
    mockBuildBluesky.mockResolvedValue(null);

    const $ = cheerio.load(
      '<div class="entry-content"><figure class="wp-block-embed">' +
        '<a href="https://bsky.app/profile/user.bsky.social/post/abc">link</a>' +
        "</figure><p>after</p></div>",
    );
    const $content = $(".entry-content");

    await processEmbeds($content, $);

    expect($content.find("figure").length).toBe(0);
    expect($content.find('div[data-sanitized-class="bluesky-embed"]').length).toBe(0);
    expect($content.html()).toContain("after");
  });
});

describe("processEmbeds - other processors still run under the async loop", () => {
  it("still converts a YouTube figure to a facade", async () => {
    const $ = cheerio.load(
      '<div class="entry-content"><figure class="wp-block-embed-youtube">' +
        '<a href="https://www.youtube.com/watch?v=abcdefghijk">watch</a>' +
        "</figure></div>",
    );
    const $content = $(".entry-content");

    await processEmbeds($content, $);

    expect($content.find("figure").length).toBe(0);
    expect($content.find('div[data-sanitized-class="youtube-embed"]').length).toBe(1);
  });

  it("still converts a Reddit figure with a thumbnail image", async () => {
    const $ = cheerio.load(
      '<div class="entry-content"><figure class="wp-block-embed embed-reddit">' +
        '<img src="https://reddit.com/thumb.jpg">' +
        '<a href="https://reddit.com/r/foo/comments/123">view</a>' +
        "</figure></div>",
    );
    const $content = $(".entry-content");

    await processEmbeds($content, $);

    expect($content.find("figure").length).toBe(0);
    expect($content.find("img").attr("src")).toBe("https://reddit.com/thumb.jpg");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/aggregators/sites/mein_mmo/embeds.test.ts`
Expected: FAIL — `processEmbeds` is currently synchronous and the Bluesky branch still calls the old sync placeholder, so the mocked `buildBlueskyEmbedHtml` is never consulted and the "removes the figure" case doesn't behave as asserted.

- [ ] **Step 3: Implement**

In `src/lib/aggregators/sites/mein_mmo/embeds.ts`:

1. Change the import line:

```ts
import { isBlueskyUrl } from "../../embeds/bluesky";
```

to:

```ts
import { buildBlueskyEmbedHtml, isBlueskyUrl } from "../../embeds/bluesky";
```

2. Widen the strategy interface's `process` signature:

```ts
export interface EmbedProcessorStrategy {
  canHandle(figure: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI): boolean;
  process(
    figure: cheerio.Cheerio<Element>,
    $: cheerio.CheerioAPI,
  ): Promise<cheerio.Cheerio<Element> | null> | cheerio.Cheerio<Element> | null;
}
```

3. Delete the `buildBlueskyEmbedHtmlSync` function entirely (it is being replaced, not kept as a fallback):

```ts
function buildBlueskyEmbedHtmlSync(url: string): string | null {
  const cleanUrl = url.split("?")[0]!;
  if (!isSafeUrl(cleanUrl)) return null;
  return (
    `<blockquote style="border-left: 3px solid #0085ff; padding: 12px 16px; margin: 1em 0; background: #f7f9fa;">\n` +
    `<p style="margin: 0 0 8px 0;"><strong>View on Bluesky</strong> · <a href="${escapeHtml(cleanUrl)}" target="_blank" rel="noopener">View on Bluesky</a></p>\n` +
    `</blockquote>`
  );
}
```

Check afterward whether `escapeHtml` is still used elsewhere in this file (it is not, once this function is removed) and remove it from the `../../extract/format` import if so — keep `buildYoutubeFacadeHtml` in that import.

4. Replace `BlueskyEmbedProcessor.process` (keep `canHandle` as-is):

```ts
export class BlueskyEmbedProcessor implements EmbedProcessorStrategy {
  canHandle(figure: cheerio.Cheerio<Element>, $: cheerio.CheerioAPI): boolean {
    const anchors = figure.find("a[href]").toArray();
    for (const a of anchors) {
      const href = $(a).attr("href") || "";
      if (isBlueskyUrl(href)) return true;
    }
    return false;
  }

  async process(
    figure: cheerio.Cheerio<Element>,
    $: cheerio.CheerioAPI,
  ): Promise<cheerio.Cheerio<Element> | null> {
    let blueskyLink: string | null = null;
    const anchors = figure.find("a[href]").toArray();
    for (const a of anchors) {
      const href = $(a).attr("href") || "";
      if (isBlueskyUrl(href)) {
        blueskyLink = href;
        break;
      }
    }

    if (!blueskyLink) return null;

    const embedHtml = await buildBlueskyEmbedHtml(blueskyLink);
    if (!embedHtml) return null;

    const wrapper = ($("<div>") as cheerio.Cheerio<Element>).attr(
      "data-sanitized-class",
      "bluesky-embed",
    );
    const $fragment = $(embedHtml);
    wrapper.append($fragment);
    return wrapper;
  }
}
```

5. Replace `processEmbeds` with an async version that awaits each processor's result:

```ts
/**
 * Process all figure embeds using strategy pattern.
 */
export async function processEmbeds(
  $content: cheerio.Cheerio<Element>,
  $: cheerio.CheerioAPI,
): Promise<void> {
  const processors: EmbedProcessorStrategy[] = [
    new YouTubeEmbedProcessor(),
    new TwitterEmbedProcessor(),
    new RedditEmbedProcessor(),
    new BlueskyEmbedProcessor(),
    new TikTokEmbedProcessor(),
    new YouTubeFallbackProcessor(),
  ];

  const figures = $content.find("figure").toArray();
  for (const figure of figures) {
    const $figure = $(figure);
    for (const processor of processors) {
      if (processor.canHandle($figure, $)) {
        const replacement = await processor.process($figure, $);
        if (replacement) {
          $figure.replaceWith(replacement);
        } else {
          $figure.remove();
        }
        break;
      }
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/aggregators/sites/mein_mmo/embeds.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Run the full check suite**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: PASS. (This file's callers in `content.ts`/`aggregator.ts` are not yet updated to `await` it — that's Task 4 — so `npm run typecheck` must be checked carefully here: `processEmbeds` returning `Promise<void>` where the caller in `content.ts` calls it without `await` produces an unhandled-promise situation that `tsc` does **not** flag as an error by default, only as a possible lint warning depending on `no-floating-promises` config. If `npm run lint` fails on a floating promise in `content.ts`, that confirms Task 4 must land in the same change set before committing — see Task 4, which is written to be applied immediately after this step regardless.)

- [ ] **Step 6: Commit**

Do not commit yet if Step 5 surfaced a floating-promise lint error — proceed directly to Task 4 and commit both together. If lint was clean (no floating-promise rule configured), commit now:

```bash
git add src/lib/aggregators/sites/mein_mmo/embeds.ts src/lib/aggregators/sites/mein_mmo/embeds.test.ts
git commit -m "feat(aggregators): render rich Bluesky embeds in Mein-MMO figures"
```

## Task 4: Make Mein-MMO's content extraction async end-to-end

**Files:**
- Modify: `src/lib/aggregators/sites/mein_mmo/content.ts`
- Modify: `src/lib/aggregators/sites/mein_mmo/aggregator.ts`
- Create: `src/lib/aggregators/sites/mein_mmo/content.test.ts`
- Create: `src/lib/aggregators/sites/mein_mmo/aggregator.test.ts`

**Interfaces:**
- Consumes: `processEmbeds(...): Promise<void>` from Task 3; `BaseAggregator.extractContent(...): string | Promise<string>` from Task 1.
- Produces: `export async function extractMeinMmoContent(html: string, article: RawArticle, selectorsToRemove: string[]): Promise<string>`; `MeinMmoAggregator.extractContent(html: string, article: RawArticle): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/aggregators/sites/mein_mmo/content.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RawArticle } from "../../base";
import { extractMeinMmoContent } from "./content";

vi.mock("../../embeds/bluesky", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../embeds/bluesky")>();
  return { ...actual, buildBlueskyEmbedHtml: vi.fn() };
});

import { buildBlueskyEmbedHtml } from "../../embeds/bluesky";

const mockBuildBluesky = vi.mocked(buildBlueskyEmbedHtml);

const ARTICLE: RawArticle = {
  name: "Test article",
  identifier: "https://mein-mmo.de/test-article/",
  raw_content: "",
  content: "",
  date: new Date(),
  author: "",
};

beforeEach(() => {
  mockBuildBluesky.mockReset();
});

describe("extractMeinMmoContent", () => {
  it("resolves asynchronously and extracts the entry-content div", async () => {
    const html =
      '<html><body><div class="entry-content"><p>Hello world.</p></div></body></html>';

    const result = extractMeinMmoContent(html, ARTICLE, []);
    expect(result).toBeInstanceOf(Promise);

    const resolved = await result;
    expect(resolved).toContain("Hello world.");
  });

  it("propagates a rich Bluesky embed built asynchronously into the returned HTML", async () => {
    mockBuildBluesky.mockResolvedValue("<blockquote><p>Rich Bluesky post</p></blockquote>");

    const html =
      '<html><body><div class="entry-content"><p>Intro.</p>' +
      '<figure class="wp-block-embed">' +
      '<a href="https://bsky.app/profile/user.bsky.social/post/abc">link</a>' +
      "</figure></div></body></html>";

    const result = await extractMeinMmoContent(html, ARTICLE, []);

    expect(result).toContain("Rich Bluesky post");
    expect(result).toContain('data-sanitized-class="bluesky-embed"');
  });
});
```

Create `src/lib/aggregators/sites/mein_mmo/aggregator.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { FeedLike, RawArticle } from "../../base";
import { MeinMmoAggregator } from "./aggregator";

const FEED: FeedLike = {
  identifier: "https://mein-mmo.de/feed/",
  dailyLimit: 20,
  options: { combine_pages: false, include_comments: false },
};

const ARTICLE: RawArticle = {
  name: "Test article",
  identifier: "https://mein-mmo.de/test-article/",
  raw_content: "",
  content: "",
  date: new Date(),
  author: "",
};

describe("MeinMmoAggregator.extractContent", () => {
  it("returns a Promise<string> that resolves to the extracted content", async () => {
    const agg = new MeinMmoAggregator(FEED);
    const html =
      '<html><body><div class="entry-content"><p>Article body.</p></div></body></html>';

    const result = agg.extractContent(html, ARTICLE);
    expect(result).toBeInstanceOf(Promise);

    const resolved = await result;
    expect(resolved).toContain("Article body.");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/aggregators/sites/mein_mmo/content.test.ts src/lib/aggregators/sites/mein_mmo/aggregator.test.ts`
Expected: FAIL — `extractMeinMmoContent` and `MeinMmoAggregator.extractContent` are still synchronous, so `result` is a `string`, not a `Promise`, and `expect(result).toBeInstanceOf(Promise)` fails.

- [ ] **Step 3: Implement**

In `src/lib/aggregators/sites/mein_mmo/content.ts`, change the signature and the one call site:

```ts
export async function extractMeinMmoContent(
  html: string,
  _article: RawArticle,
  selectorsToRemove: string[],
): Promise<string> {
```

(keep the whole body identical except the one line calling `processEmbeds`, which becomes:)

```ts
  // Process embeds (YouTube, Twitter, Reddit, Bluesky, TikTok, YouTubeFallback)
  await processEmbeds($content, $);
```

In `src/lib/aggregators/sites/mein_mmo/aggregator.ts`, change:

```ts
  override extractContent(html: string, article: RawArticle): string {
    return extractMeinMmoContent(html, article, this.getIgnoreSelectors());
  }
```

to:

```ts
  override async extractContent(html: string, article: RawArticle): Promise<string> {
    return extractMeinMmoContent(html, article, this.getIgnoreSelectors());
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/aggregators/sites/mein_mmo/content.test.ts src/lib/aggregators/sites/mein_mmo/aggregator.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Run the full check suite**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: PASS, with zero unrelated regressions. Specifically confirm:
- `src/lib/parity/corpus.test.ts`'s "golden corpus parity" suite still passes (mein_mmo cases remain skipped via `SKIP_LIST`, unaffected by this change; every other aggregator's case must still pass since their `extractContent` overrides are untouched).
- `src/lib/aggregators/website.test.ts` still passes unmodified.

- [ ] **Step 6: Commit**

```bash
git add src/lib/aggregators/sites/mein_mmo/content.ts src/lib/aggregators/sites/mein_mmo/aggregator.ts src/lib/aggregators/sites/mein_mmo/content.test.ts src/lib/aggregators/sites/mein_mmo/aggregator.test.ts
git commit -m "feat(aggregators): make Mein-MMO content extraction async for Bluesky embeds"
```

If Task 3's Step 5 found a floating-promise lint error, stage and commit Task 3's files in this same commit instead of two separate commits.

## Final verification

- [ ] Run `npm run lint && npm run format:check && npm run typecheck && npm test` one more time from a clean `git status` (no uncommitted changes) to confirm the four commits together leave the repo green.
- [ ] Manually sanity-check that `src/lib/aggregators/extract/format.ts` (`buildYoutubeFacadeHtml`, `buildDailymotionFacadeHtml`) was **not** touched by any task — confirms the "Not in scope" decision above was actually honored.
