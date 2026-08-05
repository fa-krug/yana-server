# Reddit Aggregator Correctness & iOS-Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the correctness bugs found in `src/lib/aggregators/sites/reddit/` (cross-tenant credential leakage, swallowed auth/forbidden failures) and close the behavioral gaps versus both the Django oracle (`old/core/aggregators/reddit/`) and the iOS app (`/Users/skrug/PycharmProjects/yana-ios/Yana/Aggregators/Concrete/Reddit*.swift`) — an incomplete header-image priority chain, no inline Reddit-video playback, no Giphy link handling, narrow HTML-entity decoding, and no Markdown table support.

**Architecture:** No new subsystems. Every task edits or extends the existing file-per-concern layout under `src/lib/aggregators/sites/reddit/` (mirrors `old/core/aggregators/reddit/` and the iOS `Reddit*.swift` split), reusing existing shared infrastructure (`src/lib/aggregators/errors.ts`'s `ArticleSkipError`/`AggregatorError`, `src/lib/aggregators/images/extractor.ts`'s `getOverrideImageUrl`/`extractImages`, `src/lib/aggregators/images/store.ts`'s `storeImageRefFromUrl`) rather than duplicating it.

**Tech Stack:** TypeScript, Next.js, Drizzle ORM, better-sqlite3, Vitest (node project — every new test is `.test.ts`, no jsdom needed).

## Global Constraints

- Style: 100-char lines, double quotes, semicolons, trailing commas (Prettier owns this — run `npm run format` if unsure).
- No `^`/`~` on dependencies — this plan adds none.
- Every new test file goes in the **node** Vitest project (`.test.ts`, not `.test.tsx`) per `vitest.config.ts`.
- Mock `fetch` with `vi.stubGlobal("fetch", vi.fn())` and real `Response` objects — the established pattern in `src/lib/aggregators/search.test.ts`.
- Tests that touch the database use `applyMigrationsAt()` from `src/lib/db/test-support.ts` against a temp-file `DATABASE_PATH`, following `src/lib/jobs/handlers/handlers.test.ts`'s exact setup/teardown shape — never a driver mock.
- `writeTransaction()` callbacks are synchronous — never pass an `async` callback to `client.writeTransaction(...)`.
- Run `npm run lint && npm run format:check && npm run typecheck && npm test` before considering any task done.

---

### Task 1: Fix the cross-tenant Reddit OAuth token cache

**Problem:** `getRedditAccessToken()` caches the access token in a single module-level variable and checks only whether it's unexpired — it never checks whether the cached token belongs to the `clientId`/`clientSecret` being requested. In this multi-tenant app (Reddit credentials are per-user, stored in `user_settings`), a second user's feed aggregating within the ~55-minute cache window is served the **first user's** OAuth token.

**Files:**
- Modify: `src/lib/aggregators/sites/reddit/auth.ts`
- Test: `src/lib/aggregators/sites/reddit/auth.test.ts` (new)

**Interfaces:**
- Produces: `getRedditAccessToken(clientId: string, clientSecret: string, userAgent?: string): Promise<string | null>` — same signature, now correctly scoped per credential pair.

- [ ] **Step 1: Write the failing test**

Create `src/lib/aggregators/sites/reddit/auth.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { getRedditAccessToken } from "./auth";

function basicAuthFor(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

describe("getRedditAccessToken", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not serve one credential pair's cached token to a different pair", async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const token = headers.Authorization === basicAuthFor("client-a", "secret-a")
        ? "token-a"
        : "token-b";
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: token, expires_in: 3600 })),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokenA = await getRedditAccessToken("client-a", "secret-a");
    const tokenB = await getRedditAccessToken("client-b", "secret-b");

    expect(tokenA).toBe("token-a");
    expect(tokenB).toBe("token-b");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reuses a cached token for the same credentials without a second fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "token-c", expires_in: 3600 })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await getRedditAccessToken("client-c", "secret-c");
    const second = await getRedditAccessToken("client-c", "secret-c");

    expect(first).toBe("token-c");
    expect(second).toBe("token-c");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/aggregators/sites/reddit/auth.test.ts`
Expected: FAIL on the first test — `tokenB` comes back as `"token-a"` (the stale singleton cache), not `"token-b"`.

- [ ] **Step 3: Fix `auth.ts`**

Replace the single `cachedAccessToken` variable and the body of `getRedditAccessToken` in `src/lib/aggregators/sites/reddit/auth.ts`:

```ts
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getRedditAccessToken(
  clientId: string,
  clientSecret: string,
  userAgent = "Yana/1.0",
): Promise<string | null> {
  if (!clientId || !clientSecret) return null;

  const cacheKey = `${clientId}:${clientSecret}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  try {
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const res = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": userAgent,
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) return null;

    const token = data.access_token;
    const expiresIn = (data.expires_in || 3600) - 60;
    tokenCache.set(cacheKey, { token, expiresAt: Date.now() + expiresIn * 1000 });
    return token;
  } catch {
    return null;
  }
}
```

Remove the now-unused `let cachedAccessToken: ... = null;` declaration entirely.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/aggregators/sites/reddit/auth.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/aggregators/sites/reddit/auth.ts src/lib/aggregators/sites/reddit/auth.test.ts
git commit -m "fix(aggregators): scope the Reddit OAuth token cache per credential pair"
```

---

### Task 2: Wire the feed owner's stored Reddit/YouTube credentials into aggregation

**Problem:** `src/lib/jobs/handlers/aggregate.ts` loads a bare `feeds` row and passes it straight to `createAggregator(feed)`. `feed.options` never contains the feed owner's `reddit_client_id`/`reddit_client_secret`/`reddit_user_agent`/`youtube_api_key` — those live only in `user_settings`, written via `/integrations`, and nothing joins the two. So `getRedditUserSettings()`/the YouTube aggregator's equivalent always fall through to `process.env.REDDIT_CLIENT_ID`/`YOUTUBE_API_KEY` — a single instance-wide credential — regardless of which user owns the feed.

**Files:**
- Create: `src/lib/aggregators/credential-resolution.ts`
- Create: `src/lib/aggregators/credential-resolution.test.ts`
- Modify: `src/lib/jobs/handlers/aggregate.ts`

**Interfaces:**
- Produces: `resolveFeedCredentials(feed: Feed): Feed` — returns a new `Feed` whose `options` has the owner's stored Reddit/YouTube credential fields merged in (feed's own options win on any name collision, but there are none today), or the same `feed` unchanged if it has no `user_settings` row.
- Consumes: `Feed` from `@/lib/db/schema`, `userSettings` table (columns `redditEnabled`/`redditClientId`/`redditClientSecret`/`redditUserAgent`/`youtubeApiKey`, per `src/lib/db/schema/users.ts:88-96`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/aggregators/credential-resolution.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../db/test-support";

describe("resolveFeedCredentials", () => {
  let dbPath: string;
  let client: typeof import("../db/client");
  let schema: typeof import("../db/schema");
  let resolution: typeof import("./credential-resolution");

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-credres-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    applyMigrationsAt(dbPath);

    client = await import("../db/client");
    schema = await import("../db/schema");
    resolution = await import("./credential-resolution");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("merges the feed owner's stored Reddit/YouTube credentials into feed.options", () => {
    let feed: InstanceType<typeof Object> & Record<string, unknown>;

    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
      db.insert(schema.userSettings)
        .values({
          userId: "user1",
          redditEnabled: true,
          redditClientId: "abc123",
          redditClientSecret: "shh",
          redditUserAgent: "Yana/1.0 (test)",
          youtubeApiKey: "yt-key",
        })
        .run();
      feed = db
        .insert(schema.feeds)
        .values({
          name: "r/test",
          userId: "user1",
          aggregator: "reddit",
          options: { min_comments: 3 },
        })
        .returning()
        .get();
    });

    const resolved = resolution.resolveFeedCredentials(feed! as never);

    expect(resolved.options).toEqual({
      min_comments: 3,
      reddit_enabled: true,
      reddit_client_id: "abc123",
      reddit_client_secret: "shh",
      reddit_user_agent: "Yana/1.0 (test)",
      youtube_api_key: "yt-key",
    });
  });

  it("returns the feed unchanged when the owner has no user_settings row", () => {
    let feed: InstanceType<typeof Object> & Record<string, unknown>;

    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "orphan", email: "orphan@example.com" }).run();
      feed = db
        .insert(schema.feeds)
        .values({ name: "r/test", userId: "orphan", aggregator: "reddit" })
        .returning()
        .get();
    });

    const resolved = resolution.resolveFeedCredentials(feed! as never);
    expect(resolved).toBe(feed!);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/aggregators/credential-resolution.test.ts`
Expected: FAIL with "Cannot find module './credential-resolution'".

- [ ] **Step 3: Write `credential-resolution.ts`**

Create `src/lib/aggregators/credential-resolution.ts`:

```ts
import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { type Feed, userSettings } from "@/lib/db/schema";

/**
 * Merges the feed owner's stored integration credentials (Reddit, YouTube)
 * into a copy of the feed's `options`. Background aggregation has no signed-in
 * session to read `/integrations` state from, so without this the per-user
 * credentials configured there are unreachable and every aggregator silently
 * falls back to a single instance-wide env var (see
 * `getRedditUserSettings()` in `sites/reddit/auth.ts`).
 */
export function resolveFeedCredentials(feed: Feed): Feed {
  const settings = getDb()
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, feed.userId))
    .get();
  if (!settings) return feed;

  return {
    ...feed,
    options: {
      ...feed.options,
      reddit_enabled: settings.redditEnabled,
      reddit_client_id: settings.redditClientId,
      reddit_client_secret: settings.redditClientSecret,
      reddit_user_agent: settings.redditUserAgent,
      youtube_api_key: settings.youtubeApiKey,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/aggregators/credential-resolution.test.ts`
Expected: PASS

- [ ] **Step 5: Wire it into the job handler**

In `src/lib/jobs/handlers/aggregate.ts`, add the import and apply it before constructing the aggregator:

```ts
import { resolveFeedCredentials } from "@/lib/aggregators/credential-resolution";
```

Change:

```ts
  const feed = db.select().from(feeds).where(eq(feeds.id, feedId)).get();
  if (!feed || !feed.enabled) return;

  const aggregator = createAggregator(feed);
```

to:

```ts
  const feed = db.select().from(feeds).where(eq(feeds.id, feedId)).get();
  if (!feed || !feed.enabled) return;

  const aggregator = createAggregator(resolveFeedCredentials(feed));
```

- [ ] **Step 6: Run the full jobs test suite to confirm no regression**

Run: `npx vitest run src/lib/jobs`
Expected: PASS (existing `handlers.test.ts` cases are unaffected — they don't assert on credential fields).

- [ ] **Step 7: Commit**

```bash
git add src/lib/aggregators/credential-resolution.ts src/lib/aggregators/credential-resolution.test.ts src/lib/jobs/handlers/aggregate.ts
git commit -m "fix(aggregators): resolve the feed owner's stored credentials before aggregating"
```

---

### Task 3: Stop swallowing Reddit auth/forbidden/not-found failures

**Problem:** Every Reddit HTTP call in `comments.ts`/`posts.ts`/`aggregator.ts`'s `fetchSourceData` does `if (!res.ok) return <empty>` (or a bare `catch { return <empty> }`), so a private/removed post, bad credentials, or a banned subreddit look identical to "no results" — silently. The Django oracle (`old/core/aggregators/reddit/{comments,posts,aggregator}.py`) raises `ArticleSkipError` on a 403/404 fetching comments (and `enrich_articles` drops that one article rather than keeping it with empty content) and raises a distinguishable `ValueError` for a 401, a forbidden/missing subreddit, or a rate limit.

**Files:**
- Modify: `src/lib/aggregators/sites/reddit/comments.ts`
- Modify: `src/lib/aggregators/sites/reddit/posts.ts`
- Modify: `src/lib/aggregators/sites/reddit/aggregator.ts`
- Test: `src/lib/aggregators/sites/reddit/comments.test.ts` (new)
- Test: `src/lib/aggregators/sites/reddit/posts.test.ts` (new)

**Interfaces:**
- Consumes: `ArticleSkipError`, `AggregatorError` from `src/lib/aggregators/errors.ts` (already defined, already used elsewhere — see `website.ts`).
- Produces: `fetchPostComments(...)` now `throw`s `ArticleSkipError` on a 403/404 instead of returning `[]`. `fetchRedditPost(...)` now `throw`s `AggregatorError` on a 401. `RedditAggregator.fetchSourceData(...)` now `throw`s a descriptive `AggregatorError` instead of returning empty results, for any non-2xx response or transport failure.

- [ ] **Step 1: Write the failing comments test**

Create `src/lib/aggregators/sites/reddit/comments.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArticleSkipError } from "../../errors";
import { fetchPostComments } from "./comments";

describe("fetchPostComments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws ArticleSkipError when the post is private or removed (403)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));

    await expect(fetchPostComments("test", "abc123", 10)).rejects.toThrow(ArticleSkipError);
  });

  it("throws ArticleSkipError when the post is not found (404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));

    await expect(fetchPostComments("test", "abc123", 10)).rejects.toThrow(ArticleSkipError);
  });

  it("degrades to an empty list on a transport failure, without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const comments = await fetchPostComments("test", "abc123", 10);
    expect(comments).toEqual([]);
  });

  it("degrades to an empty list on a 500, without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 500 })));

    const comments = await fetchPostComments("test", "abc123", 10);
    expect(comments).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/aggregators/sites/reddit/comments.test.ts`
Expected: FAIL — the two 403/404 cases resolve to `[]` instead of rejecting.

- [ ] **Step 3: Fix `comments.ts`**

Replace `fetchPostComments` in `src/lib/aggregators/sites/reddit/comments.ts`:

```ts
import { ArticleSkipError } from "../../errors";
import { convertRedditMarkdown, escapeHtml, safeLinkHtml } from "./markdown";
import { RedditComment, RedditCommentRaw, RedditListing, RedditPostRaw } from "./types";

/** `/comments/{postId}.json?...` always answers `[postListing, commentsListing]`. */
type RedditCommentsPageResponse = [
  RedditListing<"t3", RedditPostRaw>,
  RedditListing<string, RedditCommentRaw>,
];

// ...formatCommentHtml/isBotAccount/isValidComment unchanged...

export async function fetchPostComments(
  subreddit: string,
  postId: string,
  commentLimit: number,
  _userId?: number | string | null,
  accessToken?: string | null,
): Promise<RedditComment[]> {
  if (!postId || commentLimit <= 0) return [];

  const url = accessToken
    ? `https://oauth.reddit.com/r/${subreddit || "all"}/comments/${postId}?sort=best&limit=${commentLimit}`
    : `https://www.reddit.com/r/${subreddit || "all"}/comments/${postId}.json?sort=best&limit=${commentLimit}`;

  const headers: Record<string, string> = { "User-Agent": "Yana/1.0" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    return [];
  }

  if (res.status === 403) {
    throw new ArticleSkipError("Post is private or removed", 403);
  }
  if (res.status === 404) {
    throw new ArticleSkipError("Post not found", 404);
  }
  if (!res.ok) return [];

  try {
    const data: unknown = await res.json();
    if (!Array.isArray(data) || data.length < 2) return [];

    const [, commentsListing] = data as RedditCommentsPageResponse;
    const commentListing = commentsListing?.data?.children || [];
    const comments: RedditComment[] = [];

    for (const item of commentListing) {
      if (item.kind === "t1" && item.data) {
        comments.push(new RedditComment(item.data));
      }
    }

    const filtered = comments.filter(isValidComment);
    filtered.sort((a, b) => (b.score || 0) - (a.score || 0));
    return filtered.slice(0, commentLimit);
  } catch {
    return [];
  }
}
```

(Keep `formatCommentHtml`, `isBotAccount`, `isValidComment` exactly as they are — only `fetchPostComments`'s body changes.)

- [ ] **Step 4: Run to verify the comments test passes**

Run: `npx vitest run src/lib/aggregators/sites/reddit/comments.test.ts`
Expected: PASS

- [ ] **Step 5: Make `enrichArticles` skip on `ArticleSkipError`, degrade on anything else**

In `src/lib/aggregators/sites/reddit/aggregator.ts`, add the import:

```ts
import { AggregatorError, ArticleSkipError } from "../../errors";
```

Replace the body of `enrichArticles`'s loop:

```ts
  override async enrichArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    const commentLimit = (this.feed.options?.comment_limit as number) ?? 10;
    const settings = getRedditUserSettings(this.feed.options);
    const accessToken = await getRedditAccessToken(
      settings.reddit_client_id,
      settings.reddit_client_secret,
      settings.reddit_user_agent,
    );

    const enriched: RawArticle[] = [];

    for (const article of articles) {
      try {
        const postDataDict = (article._reddit_post_data as RedditPostDataDict) || {};
        const postData = new RedditPostData(postDataDict);
        const subreddit = (article._reddit_subreddit as string) || "";
        const isCrossPost = (article._reddit_is_cross_post as boolean) || false;

        const comments = await fetchPostComments(
          subreddit,
          postData.id,
          commentLimit,
          this.feed.userId,
          accessToken,
        );

        const content = await buildPostContent(
          postData,
          commentLimit,
          subreddit,
          this.feed.userId,
          isCrossPost,
          comments,
        );

        article.raw_content = content;
        article.content = content;
      } catch (err) {
        if (err instanceof ArticleSkipError) {
          continue; // drop this article; it's private/removed, not empty-with-comments
        }
        article.raw_content = "";
        article.content = "";
      }

      enriched.push(article);
    }

    return enriched;
  }
```

- [ ] **Step 6: Write the failing posts test**

Create `src/lib/aggregators/sites/reddit/posts.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { AggregatorError } from "../../errors";
import { fetchRedditPost } from "./posts";

describe("fetchRedditPost", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws AggregatorError on a 401 instead of returning null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));

    await expect(fetchRedditPost("test", "abc123")).rejects.toThrow(AggregatorError);
  });

  it("returns null on a 404 (post genuinely gone)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));

    const post = await fetchRedditPost("test", "abc123");
    expect(post).toBeNull();
  });

  it("returns null on a transport failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const post = await fetchRedditPost("test", "abc123");
    expect(post).toBeNull();
  });
});
```

- [ ] **Step 7: Run to verify it fails**

Run: `npx vitest run src/lib/aggregators/sites/reddit/posts.test.ts`
Expected: FAIL — the 401 case resolves to `null` instead of rejecting.

- [ ] **Step 8: Fix `posts.ts`**

Replace the body of `fetchRedditPost` in `src/lib/aggregators/sites/reddit/posts.ts`:

```ts
import { AggregatorError } from "../../errors";
import { RedditListing, RedditPostData, RedditPostRaw } from "./types";

type RedditPostFetchResponse =
  RedditListing<"t3", RedditPostRaw> | RedditListing<"t3", RedditPostRaw>[];

export async function fetchRedditPost(
  subreddit: string,
  postId: string,
  _userId?: number | string | null,
  accessToken?: string | null,
): Promise<RedditPostData | null> {
  if (!postId) return null;

  const url = accessToken
    ? `https://oauth.reddit.com/r/${subreddit || "all"}/comments/${postId}`
    : `https://www.reddit.com/r/${subreddit || "all"}/comments/${postId}.json`;

  const headers: Record<string, string> = { "User-Agent": "Yana/1.0" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }

  if (res.status === 401) {
    throw new AggregatorError("Reddit authentication failed. Please check your API credentials.");
  }
  if (!res.ok) return null;

  try {
    const data = (await res.json()) as RedditPostFetchResponse;

    let postDict: RedditPostRaw | null = null;
    if (Array.isArray(data)) {
      if (data.length > 0 && data[0]?.data?.children?.[0]?.data) {
        postDict = data[0].data.children[0].data;
      }
    } else if (data?.data?.children?.[0]?.data) {
      postDict = data.data.children[0].data;
    }

    if (!postDict) return null;
    return new RedditPostData(postDict);
  } catch {
    return null;
  }
}
```

- [ ] **Step 9: Run to verify the posts test passes**

Run: `npx vitest run src/lib/aggregators/sites/reddit/posts.test.ts`
Expected: PASS

- [ ] **Step 10: Fix `fetchSourceData` in `aggregator.ts` to throw instead of swallowing**

Replace the `try { ... } catch { return { posts: [], subreddit }; }` block inside `fetchSourceData`:

```ts
  async fetchSourceData(limit?: number): Promise<RedditSourceData> {
    const subreddit = normalizeSubreddit(this.identifier);
    if (!subreddit) {
      throw new Error(`Could not extract subreddit from identifier: ${this.identifier}`);
    }

    const settings = getRedditUserSettings(this.feed.options);
    const accessToken = await getRedditAccessToken(
      settings.reddit_client_id,
      settings.reddit_client_secret,
      settings.reddit_user_agent,
    );

    const info = await fetchSubredditInfo(subreddit, this.feed.userId, accessToken);
    this._subredditIconUrl = info.iconUrl;

    const sort = (this.feed.options?.subreddit_sort as string) || "hot";
    const fetchLimit = Math.min((limit || 25) * 3, 100);

    const url = accessToken
      ? `https://oauth.reddit.com/r/${subreddit}/${sort}?limit=${fetchLimit}`
      : `https://www.reddit.com/r/${subreddit}/${sort}.json?limit=${fetchLimit}`;

    const headers: Record<string, string> = {
      "User-Agent": settings.reddit_user_agent || "Yana/1.0",
    };
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }

    let res: Response;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw new AggregatorError(`Failed to connect to Reddit: ${(err as Error).message}`);
    }

    if (res.status === 401) {
      throw new AggregatorError(
        "Reddit authentication failed. Please check your API credentials.",
      );
    }
    if (res.status === 403) {
      throw new AggregatorError(`Subreddit 'r/${subreddit}' is private or banned.`);
    }
    if (res.status === 404) {
      throw new AggregatorError(`Subreddit 'r/${subreddit}' does not exist.`);
    }
    if (res.status === 429) {
      throw new AggregatorError("Reddit rate limit exceeded.");
    }
    if (!res.ok) {
      throw new AggregatorError(`Reddit request failed with status ${res.status}.`);
    }

    const data = (await res.json()) as RedditListing<"t3", RedditPostRaw> | null;
    const children = data?.data?.children || [];
    const posts = children
      .filter((child) => child.kind === "t3" && child.data)
      .map((child) => ({ data: new RedditPostData(child.data) }));

    return { posts, subreddit };
  }
```

This is a deliberate behavior change: the job worker (`src/lib/jobs/worker.ts`) already catches and records handler failures on the job's `error` column — `BaseAggregator.aggregate()` (`src/lib/aggregators/base.ts:231-247`) has no try/catch around `fetchSourceData()`, so this propagates cleanly instead of the feed silently producing zero articles forever with no operator-visible signal.

- [ ] **Step 11: Run the full Reddit aggregator test suite**

Run: `npx vitest run src/lib/aggregators/sites/reddit src/lib/aggregators/errors.ts src/lib/parity`
Expected: PASS, including the existing `reddit/basic` golden-parity case in `src/lib/parity/corpus.test.ts` (that fixture exercises `extractContent`/`processContent`, not `fetchSourceData`, so it's unaffected).

- [ ] **Step 12: Commit**

```bash
git add src/lib/aggregators/sites/reddit/comments.ts src/lib/aggregators/sites/reddit/comments.test.ts \
        src/lib/aggregators/sites/reddit/posts.ts src/lib/aggregators/sites/reddit/posts.test.ts \
        src/lib/aggregators/sites/reddit/aggregator.ts
git commit -m "fix(aggregators): surface Reddit auth/forbidden/not-found failures instead of swallowing them"
```

---

### Task 4: Authenticate the subreddit-icon lookup with the OAuth token

**Problem:** `fetchSubredditInfo()` always calls the unauthenticated public `https://www.reddit.com/r/{sub}/about.json`, even when `fetchSourceData` already obtained an access token — so it can never see a private/gated subreddit the credentials actually have access to.

**Depends on:** Task 3 (both touch `fetchSourceData` in `aggregator.ts` — do this task after Task 3 lands).

**Files:**
- Modify: `src/lib/aggregators/sites/reddit/urls.ts`
- Modify: `src/lib/aggregators/sites/reddit/aggregator.ts` (one-line call-site change, already included in Task 3's Step 10 above via the `fetchSubredditInfo(subreddit, this.feed.userId, accessToken)` call)
- Test: `src/lib/aggregators/sites/reddit/urls.test.ts` (new)

**Interfaces:**
- Produces: `fetchSubredditInfo(subreddit: string, userId?, accessToken?: string | null): Promise<{ iconUrl: string | null }>` — now takes an optional access token and uses `https://oauth.reddit.com/...` when one is present.

- [ ] **Step 1: Write the failing test**

Create `src/lib/aggregators/sites/reddit/urls.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeHtmlEntitiesInUrl, fetchSubredditInfo } from "./urls";

describe("fetchSubredditInfo", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the authenticated oauth.reddit.com host and a Bearer header when given a token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { icon_img: "https://example.com/icon.png" } })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchSubredditInfo("privatesubreddit", null, "the-token");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("https://oauth.reddit.com/");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer the-token");
  });

  it("falls back to the public host when no token is available", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { icon_img: "https://example.com/icon.png" } })),
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchSubredditInfo("publicsubreddit", null, null);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("https://www.reddit.com/");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});

describe("decodeHtmlEntitiesInUrl", () => {
  it("decodes numeric decimal and hex entity refs, not just the five named ones", () => {
    expect(decodeHtmlEntitiesInUrl("https://x.test/a&#39;b")).toBe("https://x.test/a'b");
    expect(decodeHtmlEntitiesInUrl("https://x.test/a&#x27;b")).toBe("https://x.test/a'b");
    expect(decodeHtmlEntitiesInUrl("https://x.test/a&apos;b")).toBe("https://x.test/a'b");
    expect(decodeHtmlEntitiesInUrl("https://x.test/a&amp;b")).toBe("https://x.test/a&b");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/aggregators/sites/reddit/urls.test.ts`
Expected: FAIL — `fetchSubredditInfo` takes no third argument yet, and always hits `www.reddit.com`.

- [ ] **Step 3: Fix `urls.ts`**

Replace `fetchSubredditInfo` in `src/lib/aggregators/sites/reddit/urls.ts`:

```ts
export async function fetchSubredditInfo(
  subreddit: string,
  _userId?: number | string | null,
  accessToken?: string | null,
): Promise<{ iconUrl: string | null }> {
  if (!subreddit) return { iconUrl: null };
  try {
    const url = accessToken
      ? `https://oauth.reddit.com/r/${subreddit}/about.json`
      : `https://www.reddit.com/r/${subreddit}/about.json`;
    const headers: Record<string, string> = { "User-Agent": "Yana/1.0" };
    if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { iconUrl: null };
    const data = (await res.json()) as RedditSubredditAboutResponse;
    const rawIcon =
      data?.data?.icon_img || data?.data?.community_icon || data?.data?.header_img || null;
    return { iconUrl: fixRedditMediaUrl(rawIcon) };
  } catch {
    return { iconUrl: null };
  }
}
```

Also broaden `decodeHtmlEntitiesInUrl` in the same file (this is Task 6's fix, done here since it's the same file — see Task 6 below for the full rationale and test, already included above):

```ts
export function decodeHtmlEntitiesInUrl(url: string): string {
  if (!url) return "";
  return url
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)));
}
```

- [ ] **Step 4: Run to verify the tests pass**

Run: `npx vitest run src/lib/aggregators/sites/reddit/urls.test.ts`
Expected: PASS

- [ ] **Step 5: Run the whole Reddit suite (this file's callers include `fixRedditMediaUrl`, `aggregator.ts`)**

Run: `npx vitest run src/lib/aggregators/sites/reddit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/aggregators/sites/reddit/urls.ts src/lib/aggregators/sites/reddit/urls.test.ts
git commit -m "fix(aggregators): authenticate the subreddit-icon lookup and broaden URL entity decoding"
```

---

### Task 5: Complete the header-image priority chain (domain overrides, selftext og:image scrape, link-post og:image fallback)

**Problem:** Comparing `images.ts::extractHeaderImageUrl` against the Django oracle `images.py::extract_header_image_url` line-by-line (both are the reference iOS's `RedditAggregator.swift::headerImageURL` also implements):
- Priority -1 (domain image overrides, e.g. branded images for known link domains) exists in the codebase (`getOverrideImageUrl` in `src/lib/aggregators/images/extractor.ts`) but is never called from Reddit's own header-priority chain.
- The selftext image fallback doesn't skip Twitter/X URLs when picking its "first link" candidate, and never falls through to scraping that link's page for an `og:image`.
- Priority 5 — for a link post with no Reddit-supplied image at all, scrape the linked page's `og:image` — is missing entirely.

**Files:**
- Modify: `src/lib/aggregators/sites/reddit/images.ts`
- Modify: `src/lib/aggregators/sites/reddit/aggregator.ts` (one `await`)
- Test: `src/lib/aggregators/sites/reddit/images.test.ts` (new)

**Interfaces:**
- Produces: `extractHeaderImageUrl(post: RedditPostData): Promise<string | null>` — now **async** (was synchronous). `extractImageUrlFromSelftext` becomes an internal async helper.
- Consumes: `getOverrideImageUrl(url: string | null | undefined): string | null` and `extractImages(url: string, isHeaderImage?: boolean): Promise<{ imageUrl?: string } | null>`, both already exported from `src/lib/aggregators/images/extractor.ts`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/aggregators/sites/reddit/images.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedditPostData } from "./types";

vi.mock("../../images/extractor", async () => {
  const actual = await vi.importActual<typeof import("../../images/extractor")>(
    "../../images/extractor",
  );
  return { ...actual, extractImages: vi.fn() };
});

import { extractImages } from "../../images/extractor";
import { extractHeaderImageUrl } from "./images";

describe("extractHeaderImageUrl", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the domain-override image ahead of everything else", async () => {
    const post = new RedditPostData({
      url: "https://en-americas-support.nintendo.com/some/page",
    });

    const result = await extractHeaderImageUrl(post);
    expect(result).toBe(
      "https://upload.wikimedia.org/wikipedia/commons/0/0d/Nintendo.svg",
    );
    expect(extractImages).not.toHaveBeenCalled();
  });

  it("scrapes the linked page's og:image when a link post has no other image", async () => {
    vi.mocked(extractImages).mockResolvedValue({ imageUrl: "https://example.com/og.png" });
    const post = new RedditPostData({
      url: "https://example.com/article",
      is_self: false,
    });

    const result = await extractHeaderImageUrl(post);
    expect(result).toBe("https://example.com/og.png");
    expect(extractImages).toHaveBeenCalledWith("https://example.com/article", true);
  });

  it("scrapes the first selftext link's page when selftext has no direct image", async () => {
    // Deliberately no Twitter/X URL here: Priority 0.6 (above this one in the
    // chain) already intercepts *any* Twitter URL found in selftext and
    // returns it immediately, so a Twitter URL would never reach this branch
    // -- this test is about the plain "no direct image, scrape the page"
    // fallback, not the Twitter-skip inside it (which mirrors Django's own
    // redundant-but-parity-preserving check; see the comment in images.ts).
    vi.mocked(extractImages).mockResolvedValue({ imageUrl: "https://example.com/scraped.png" });
    const post = new RedditPostData({
      is_self: true,
      selftext: "check out https://example.com/thing for more",
    });

    const result = await extractHeaderImageUrl(post);
    expect(result).toBe("https://example.com/scraped.png");
    expect(extractImages).toHaveBeenCalledWith("https://example.com/thing", true);
  });

  it("returns null when nothing matches and the page scrape finds nothing", async () => {
    vi.mocked(extractImages).mockResolvedValue(null);
    const post = new RedditPostData({ url: "https://example.com/article", is_self: false });

    const result = await extractHeaderImageUrl(post);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/aggregators/sites/reddit/images.test.ts`
Expected: FAIL — `extractHeaderImageUrl` returns a plain value (not a Promise resolving as expected) and never calls `extractImages`; the domain-override case returns `null` instead of the Nintendo image.

- [ ] **Step 3: Fix `images.ts`**

Add the import:

```ts
import { extractImages, getOverrideImageUrl } from "../../images/extractor";
```

Replace `extractHeaderImageUrl` and `_extract_image_url_from_selftext`'s TS equivalent (`extractImageUrlFromSelftext`) with:

```ts
export async function extractHeaderImageUrl(post: RedditPostData): Promise<string | null> {
  try {
    // Priority -1: domain image overrides take precedence over everything else.
    if (post.url) {
      const overrideUrl = getOverrideImageUrl(decodeHtmlEntitiesInUrl(post.url));
      if (overrideUrl) return overrideUrl;
    }

    // Priority 0: Check for video embeds (YouTube / v.redd.it)
    const videoUrl = extractVideoEmbedUrl(post);
    if (videoUrl && !videoUrl.includes("vxreddit.com")) {
      return videoUrl;
    }

    // Priority 0.5: Twitter/X link posts
    if (post.url && isTwitterUrl(post.url)) {
      return decodeHtmlEntitiesInUrl(post.url);
    }

    // Priority 0.6: Twitter/X in selftext
    if (post.is_self && post.selftext) {
      const selftextUrls = extractUrlsFromText(post.selftext);
      for (const url of selftextUrls) {
        if (isTwitterUrl(url)) {
          return decodeHtmlEntitiesInUrl(url);
        }
      }
    }

    // Priority 1: Gallery posts
    const galleryUrl = extractGalleryImageUrl(post);
    if (galleryUrl) {
      return galleryUrl;
    }

    // Priority 2: Direct image posts
    if (post.url) {
      const decodedUrl = decodeHtmlEntitiesInUrl(post.url);
      const urlLower = decodedUrl.toLowerCase();

      if (!isRedditCommentsUrl(decodedUrl)) {
        const isDirectImage =
          [".jpg", ".jpeg", ".png", ".webp", ".gif", ".gifv"].some((ext) =>
            urlLower.includes(ext),
          ) ||
          urlLower.includes("i.redd.it") ||
          (urlLower.includes("preview.redd.it") && urlLower.includes(".gif"));

        if (isDirectImage) {
          return decodedUrl;
        }
      }
    }

    // Priority 3: extract an image URL from selftext, or scrape its first link's page.
    const selftextImage = await extractImageUrlFromSelftext(post);
    if (selftextImage) {
      return selftextImage;
    }

    // Priority 4: Thumbnail fallback
    const thumbnailUrl = extractThumbnailUrl(post);
    if (thumbnailUrl) {
      if (post.url && post.url.includes("v.redd.it")) {
        const previewUrl = extractRedditVideoPreview(post);
        if (previewUrl) return previewUrl;
      }
      return thumbnailUrl;
    }

    // Priority 5: link post with no Reddit-supplied image -- scrape the linked page's og:image.
    if (post.url && !post.is_self) {
      const decodedUrl = decodeHtmlEntitiesInUrl(post.url);
      if (!isRedditCommentsUrl(decodedUrl)) {
        const pageImage = await extractImages(decodedUrl, true);
        if (pageImage?.imageUrl) return pageImage.imageUrl;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** True for a Reddit post permalink -- an internal link, never a header image. */
function isRedditCommentsUrl(url: string): boolean {
  return /https?:\/\/[^\s]*reddit\.com\/r\/[^/\s]+\/comments\/[a-zA-Z0-9]+\/[^/\s]+\/?$/i.test(
    url,
  );
}

async function extractImageUrlFromSelftext(post: RedditPostData): Promise<string | null> {
  if (!post.is_self || !post.selftext) return null;

  let selftextToProcess = post.selftext;
  const commentUrlMatch = selftextToProcess.match(
    /https?:\/\/[^\s]*\/comments\/[a-zA-Z0-9]+\/[^/\s]+\/[a-zA-Z0-9]+/,
  );
  if (commentUrlMatch && commentUrlMatch.index !== undefined) {
    selftextToProcess = selftextToProcess.slice(0, commentUrlMatch.index);
  }

  const urls = extractUrlsFromText(selftextToProcess);
  if (urls.length === 0) return null;

  let firstLink: string | null = null;
  for (const url of urls) {
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
    const urlLower = url.toLowerCase();
    if (
      urlLower.includes("preview.redd.it") ||
      [".jpg", ".jpeg", ".png", ".webp", ".gif"].some((ext) => urlLower.includes(ext))
    ) {
      return url;
    }
    if (firstLink === null && !isTwitterUrl(url)) {
      firstLink = url;
    }
  }

  if (firstLink) {
    const pageImage = await extractImages(firstLink, true);
    if (pageImage?.imageUrl) return pageImage.imageUrl;
  }

  return null;
}
```

Delete the old inline regex literal that used to live directly in Priority 2 (now replaced by the `isRedditCommentsUrl` helper, used in both Priority 2 and Priority 5 — the plain function name also documents what the regex means, matching the Django/iOS comments).

- [ ] **Step 4: Update the one call site in `aggregator.ts`**

In `parseToRawArticles`, change:

```ts
      const headerImageUrl = extractHeaderImageUrl(originalPostData);
```

to:

```ts
      const headerImageUrl = await extractHeaderImageUrl(originalPostData);
```

(`parseToRawArticles` is already `async` and this is a plain `for...of` loop, so this is the only change needed at the call site.)

- [ ] **Step 5: Run to verify the images tests pass**

Run: `npx vitest run src/lib/aggregators/sites/reddit/images.test.ts`
Expected: PASS

- [ ] **Step 6: Run the whole Reddit suite plus the golden-parity test**

Run: `npx vitest run src/lib/aggregators/sites/reddit src/lib/parity`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/aggregators/sites/reddit/images.ts src/lib/aggregators/sites/reddit/images.test.ts \
        src/lib/aggregators/sites/reddit/aggregator.ts
git commit -m "feat(aggregators): complete the Reddit header-image priority chain (domain overrides, og:image scraping)"
```

---

### Task 6: (folded into Task 4, Step 3 above — no separate work)

Broadening `decodeHtmlEntitiesInUrl` was small enough to do in the same file/commit as Task 4's `fetchSubredditInfo` fix. No additional steps here.

---

### Task 7: Add Markdown table support

**Problem:** `markdownToHtml` in `markdown.ts` has no table parsing, unlike Django's `python-markdown` (configured with the `tables` extension in `markdown.py`) — a Reddit post body containing a GFM table renders as a wall of pipe characters instead of an HTML table. Notably, `markdownToHtml`'s own paragraph-merge step (line ~145) already allow-lists `<table` as HTML that should pass through unwrapped — the parser was written expecting tables to exist and never got them.

**Files:**
- Modify: `src/lib/aggregators/sites/reddit/markdown.ts`
- Test: `src/lib/aggregators/sites/reddit/markdown.test.ts` (new)

**Interfaces:**
- Produces: two new internal helpers, `isTableBlock(lines: string[]): boolean` and `tableBlockHtml(lines: string[]): string`, used only inside `markdownToHtml`'s block loop. No exported signatures change.

- [ ] **Step 1: Write the failing test**

Create `src/lib/aggregators/sites/reddit/markdown.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { markdownToHtml } from "./markdown";

describe("markdownToHtml tables", () => {
  it("converts a GFM table into an HTML table", () => {
    const md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
    const html = markdownToHtml(md);

    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<th>B</th>");
    expect(html).toContain("<td>1</td>");
    expect(html).toContain("<td>4</td>");
    expect(html).toContain("</table>");
  });

  it("applies inline emphasis inside table cells", () => {
    const md = "| A |\n| --- |\n| **bold** |";
    const html = markdownToHtml(md);
    expect(html).toContain("<strong>bold</strong>");
  });

  it("still renders a plain paragraph containing a pipe character as a paragraph", () => {
    const html = markdownToHtml("just a | pipe, not a table");
    expect(html).not.toContain("<table>");
    expect(html).toContain("<p>");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/aggregators/sites/reddit/markdown.test.ts`
Expected: FAIL — the table markdown currently renders as a `<p>` full of literal `|` characters.

- [ ] **Step 3: Add table parsing to `markdown.ts`**

Add these two helpers above `markdownToHtml`:

```ts
function isTableBlock(lines: string[]): boolean {
  if (lines.length < 2) return false;
  if (!lines[0]!.includes("|")) return false;
  const separator = lines[1]!.trim();
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(separator);
}

function splitTableRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
}

function tableBlockHtml(lines: string[]): string {
  const headerCells = splitTableRow(lines[0]!);
  const bodyRows = lines.slice(2).map((line) => splitTableRow(line));

  const headerHtml = headerCells.map((cell) => `<th>${parseInlineMarkdown(cell)}</th>`).join("");
  const bodyHtml = bodyRows
    .map((cells) => `<tr>${cells.map((cell) => `<td>${parseInlineMarkdown(cell)}</td>`).join("")}</tr>`)
    .join("");

  return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}
```

Then in `markdownToHtml`'s block loop, add a check right after the fenced-code-block check (`if (trimmed.startsWith("\`\`\`")) { ... }`) and before the heading check:

```ts
    const blockLines = trimmed.split("\n");
    if (isTableBlock(blockLines)) {
      intermediateBlocks.push({ type: "p", html: tableBlockHtml(blockLines) });
      continue;
    }
```

(Reusing `type: "p"` is deliberate: the existing merge step's regex on line ~145 already recognizes a `<table` prefix and emits it unwrapped rather than inside another `<p>`, so no changes to the `intermediateBlocks` type union or the merge step are needed. Rename the loop's existing `const lines = trimmed.split("\n");` below this new block to avoid a duplicate declaration — reuse `blockLines` in the list-detection checks that follow instead of re-declaring `lines`.)

- [ ] **Step 4: Run to verify the tests pass**

Run: `npx vitest run src/lib/aggregators/sites/reddit/markdown.test.ts`
Expected: PASS

- [ ] **Step 5: Run the whole Reddit suite plus golden parity**

Run: `npx vitest run src/lib/aggregators/sites/reddit src/lib/parity`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/aggregators/sites/reddit/markdown.ts src/lib/aggregators/sites/reddit/markdown.test.ts
git commit -m "feat(aggregators): render GFM tables in Reddit post/comment Markdown"
```

---

### Task 8: Native inline Reddit-video playback and Giphy link handling (iOS parity)

**Problem:** For a `v.redd.it` post, both the Django oracle and the current TS port deliberately avoid embedding a `vxreddit.com` HTML link as the header (it's filtered out on purpose) and fall back to a static preview image — so the video itself never plays anywhere in the web app; the body gets an unhelpful "▶ View Video" link pointing at a bare `v.redd.it` URL that generally isn't directly playable in a browser. The iOS app instead builds a real inline `<video>` player from Reddit's own hosted HLS/MP4 stream (`RedditAggregator.swift::makeVideoHTML`), with the preview image as a poster.

Separately: a Giphy *watch/embed* link post (`giphy.com/gifs/...` or `giphy.com/embed/...`, no file extension) falls through every image-detection branch in both `images.ts` and `content.ts` today, rendering as a dead/plain link. (Giphy's `giphy|<id>` **markdown embed** syntax inside post/comment bodies is already handled correctly in `markdown.ts::convertRedditMarkdown` — this task is only about the post's own submitted *link* URL.) iOS rewrites these to the direct media-CDN GIF (`EmbedRewriter.giphyGIFURL`); neither the Django oracle nor the current TS port do.

**Files:**
- Modify: `src/lib/aggregators/sites/reddit/types.ts` (typed video fields)
- Create: `src/lib/aggregators/sites/reddit/video.ts`
- Create: `src/lib/aggregators/sites/reddit/video.test.ts`
- Modify: `src/lib/aggregators/sites/reddit/images.ts` (Giphy header priority + `extractRedditVideo` re-export is unnecessary — `video.ts` reads `RedditPostData` directly)
- Modify: `src/lib/aggregators/sites/reddit/content.ts` (Giphy body handling)
- Modify: `src/lib/aggregators/sites/reddit/aggregator.ts` (wire the video header in, ahead of the image header)
- Test: extend `src/lib/aggregators/sites/reddit/images.test.ts` and add cases to `content.ts`'s test coverage (new `content.test.ts`)

**Interfaces:**
- Produces:
  - `extractRedditVideo(post: RedditPostData): { hlsUrl?: string; fallbackUrl?: string } | null` (in `video.ts`)
  - `buildVideoHeaderHtml(video: { hlsUrl?: string; fallbackUrl?: string }, posterUrl: string | null): Promise<string | null>` (in `video.ts`)
  - `extractGiphyGifUrl(url: string): string | null` (in `images.ts`)
- Consumes: `storeImageRefFromUrl` from `src/lib/aggregators/images/store.ts` (already imported in `aggregator.ts`).

- [ ] **Step 1: Add typed video fields to `types.ts`**

In `src/lib/aggregators/sites/reddit/types.ts`, add after `RedditPreview`:

```ts
/** `media`/`secure_media`/`preview.reddit_video_preview` -- Reddit's hosted-video payload. */
export interface RedditVideoInfo {
  hls_url?: string;
  fallback_url?: string;
  is_gif?: boolean;
}

export interface RedditMedia {
  reddit_video?: RedditVideoInfo;
}
```

Change `RedditPreview` to add the video-preview field:

```ts
export interface RedditPreview {
  images?: RedditPreviewImage[];
  reddit_video_preview?: RedditVideoInfo;
}
```

Change `media`'s type (and add `secure_media`) in **four** places -- `RedditPostRaw`, `RedditPostDataDict`, the `RedditPostData` class fields, and its constructor/`toDict()`:

In `RedditPostRaw`, replace `media?: Record<string, unknown> | null;` with:

```ts
  media?: RedditMedia | null;
  secure_media?: RedditMedia | null;
```

In `RedditPostDataDict`, replace `media: Record<string, unknown> | null;` with:

```ts
  media: RedditMedia | null;
  secure_media: RedditMedia | null;
```

In the `RedditPostData` class, replace `media: Record<string, unknown> | null;` with:

```ts
  media: RedditMedia | null;
  secure_media: RedditMedia | null;
```

In its constructor, replace `this.media = data.media ?? null;` and add the new line right after it:

```ts
    this.media = data.media ?? null;
    this.secure_media = data.secure_media ?? null;
```

In `toDict()`, replace `media: this.media,` and add the new line right after it:

```ts
      media: this.media,
      secure_media: this.secure_media,
```

- [ ] **Step 2: Write the failing video test**

Create `src/lib/aggregators/sites/reddit/video.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedditPostData } from "./types";

vi.mock("../../images/store", () => ({ storeImageRefFromUrl: vi.fn() }));

import { storeImageRefFromUrl } from "../../images/store";
import { buildVideoHeaderHtml, extractRedditVideo } from "./video";

describe("extractRedditVideo", () => {
  it("prefers media.reddit_video, then secure_media, then preview.reddit_video_preview", () => {
    const fromMedia = new RedditPostData({
      media: { reddit_video: { hls_url: "https://v.redd.it/a/HLSPlaylist.m3u8" } },
    });
    expect(extractRedditVideo(fromMedia)).toEqual({
      hlsUrl: "https://v.redd.it/a/HLSPlaylist.m3u8",
      fallbackUrl: undefined,
    });

    const fromSecureMedia = new RedditPostData({
      secure_media: { reddit_video: { fallback_url: "https://v.redd.it/b/DASH_480.mp4" } },
    });
    expect(extractRedditVideo(fromSecureMedia)).toEqual({
      hlsUrl: undefined,
      fallbackUrl: "https://v.redd.it/b/DASH_480.mp4",
    });

    const fromPreview = new RedditPostData({
      preview: { reddit_video_preview: { fallback_url: "https://v.redd.it/c/DASH_480.mp4" } },
    });
    expect(extractRedditVideo(fromPreview)).toEqual({
      hlsUrl: undefined,
      fallbackUrl: "https://v.redd.it/c/DASH_480.mp4",
    });
  });

  it("returns null when the post has no Reddit-hosted video", () => {
    expect(extractRedditVideo(new RedditPostData({}))).toBeNull();
  });
});

describe("buildVideoHeaderHtml", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the HLS source and includes a poster from the stored image ref", async () => {
    vi.mocked(storeImageRefFromUrl).mockResolvedValue("yana-img://abc123");

    const html = await buildVideoHeaderHtml(
      { hlsUrl: "https://v.redd.it/a/HLSPlaylist.m3u8", fallbackUrl: "https://v.redd.it/a/DASH.mp4" },
      "https://preview.redd.it/a/preview.jpg",
    );

    expect(html).toContain('<source src="https://v.redd.it/a/HLSPlaylist.m3u8"');
    expect(html).toContain('type="application/vnd.apple.mpegurl"');
    expect(html).toContain('poster="yana-img://abc123"');
  });

  it("falls back to the MP4 source with the correct type when there is no HLS URL", async () => {
    vi.mocked(storeImageRefFromUrl).mockResolvedValue(null);

    const html = await buildVideoHeaderHtml(
      { fallbackUrl: "https://v.redd.it/a/DASH_480.mp4" },
      null,
    );

    expect(html).toContain('<source src="https://v.redd.it/a/DASH_480.mp4" type="video/mp4">');
    expect(html).not.toContain("poster=");
  });

  it("returns null when there is no playable source", async () => {
    const html = await buildVideoHeaderHtml({}, "https://preview.redd.it/a/preview.jpg");
    expect(html).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/lib/aggregators/sites/reddit/video.test.ts`
Expected: FAIL with "Cannot find module './video'".

- [ ] **Step 4: Write `video.ts`**

Create `src/lib/aggregators/sites/reddit/video.ts`:

```ts
/**
 * Native inline playback for Reddit-hosted video, mirroring the iOS app's
 * `RedditAggregator.swift::makeVideoHTML` -- the Django oracle and the
 * original TS port both deliberately avoid embedding a `vxreddit.com` link
 * for `v.redd.it` posts and fall back to a static preview image instead, so
 * the video itself never plays in the web reader. This builds a real
 * `<video>` element from Reddit's own HLS/MP4 stream instead.
 */
import { storeImageRefFromUrl } from "../../images/store";
import type { RedditPostData, RedditVideoInfo } from "./types";

export interface RedditVideoSource {
  hlsUrl?: string;
  fallbackUrl?: string;
}

/**
 * Best available Reddit-hosted video for a post: `media`/`secure_media`
 * carry it for native `v.redd.it` posts; `preview.reddit_video_preview`
 * carries it for link posts whose target Reddit transcoded into a preview
 * video (e.g. a gfycat/imgur GIF).
 */
export function extractRedditVideo(post: RedditPostData): RedditVideoSource | null {
  const info: RedditVideoInfo | undefined =
    post.media?.reddit_video ?? post.secure_media?.reddit_video ?? post.preview?.reddit_video_preview;
  if (!info || (!info.hls_url && !info.fallback_url)) return null;
  return { hlsUrl: info.hls_url, fallbackUrl: info.fallback_url };
}

/**
 * Builds an inline HTML5 player. Prefers the HLS stream (muxes audio and
 * plays inline in every modern browser); falls back to the plain MP4 (often
 * video-only). Returns null when there is no playable source at all.
 */
export async function buildVideoHeaderHtml(
  video: RedditVideoSource,
  posterUrl: string | null,
): Promise<string | null> {
  const src = video.hlsUrl || video.fallbackUrl;
  if (!src) return null;

  const type = src.toLowerCase().includes(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4";

  let posterAttr = "";
  if (posterUrl) {
    const ref = await storeImageRefFromUrl(posterUrl, { isHeader: true });
    if (ref) posterAttr = ` poster="${ref}"`;
  }

  return (
    `<header style="margin-bottom: 1.5em;">` +
    `<video controls playsinline preload="metadata"${posterAttr} style="width: 100%; height: auto;">` +
    `<source src="${src}" type="${type}">` +
    `Your browser does not support the video element.</video></header>`
  );
}
```

- [ ] **Step 5: Run to verify the video tests pass**

Run: `npx vitest run src/lib/aggregators/sites/reddit/video.test.ts`
Expected: PASS

- [ ] **Step 6: Add `extractGiphyGifUrl` and wire it into the header-priority chain**

In `src/lib/aggregators/sites/reddit/images.ts`, add:

```ts
/**
 * Rewrites a Giphy watch/embed page link (`giphy.com/gifs/...`,
 * `giphy.com/embed/...`) -- which carries no file extension and would
 * otherwise fall through every image check -- to its direct media-CDN GIF.
 */
export function extractGiphyGifUrl(url: string): string | null {
  const match = url.match(/giphy\.com\/(?:gifs|embed)\/(?:[\w-]*-)?([a-zA-Z0-9]+)(?:[/?#]|$)/i);
  if (!match) return null;
  return `https://media.giphy.com/media/${match[1]}/giphy.gif`;
}
```

In `extractHeaderImageUrl` (from Task 5), add a check right after the video-embed Priority 0 check and before the Twitter Priority 0.5 check:

```ts
    // Priority 0.4: Giphy watch/embed link posts (no file extension; would
    // otherwise fall through to a frozen static preview image).
    if (post.url) {
      const giphyUrl = extractGiphyGifUrl(decodeHtmlEntitiesInUrl(post.url));
      if (giphyUrl) return giphyUrl;
    }
```

Add test cases to `images.test.ts`:

```ts
  it("rewrites a Giphy watch-page link post to the direct media-CDN GIF", async () => {
    const post = new RedditPostData({ url: "https://giphy.com/gifs/some-slug-AbC123xyz" });
    const result = await extractHeaderImageUrl(post);
    expect(result).toBe("https://media.giphy.com/media/AbC123xyz/giphy.gif");
  });
```

- [ ] **Step 7: Add Giphy handling to the post body in `content.ts`**

In `src/lib/aggregators/sites/reddit/content.ts`, add the import:

```ts
import { extractAnimatedGifUrl, extractGiphyGifUrl } from "./images";
```

In `processLinkMedia`, add a check before the `.gif`/`.gifv` suffix check:

```ts
function processLinkMedia(post: RedditPostData, url: string, contentParts: string[]): boolean {
  const urlLower = url.toLowerCase();

  const giphyUrl = extractGiphyGifUrl(url);
  if (giphyUrl) {
    const imgHtml = safeImgHtml(giphyUrl, "Giphy");
    if (imgHtml) contentParts.push(`<p>${imgHtml}</p>`);
    return true;
  }

  // GIF media
  if (urlLower.endsWith(".gif") || urlLower.endsWith(".gifv")) {
    // ...unchanged...
```

Create `src/lib/aggregators/sites/reddit/content.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { RedditPostData } from "./types";
import { buildPostContent } from "./content";

describe("buildPostContent Giphy link handling", () => {
  it("renders a Giphy watch-page link post as an inline GIF, not a dead link", async () => {
    const post = new RedditPostData({
      id: "abc123",
      permalink: "/r/test/comments/abc123/title/",
      url: "https://giphy.com/gifs/some-slug-AbC123xyz",
      is_self: false,
    });

    const html = await buildPostContent(post, 0, "test");

    expect(html).toContain('<img src="https://media.giphy.com/media/AbC123xyz/giphy.gif"');
    expect(html).not.toContain("giphy.com/gifs");
  });
});
```

- [ ] **Step 8: Run to verify the new tests pass**

Run: `npx vitest run src/lib/aggregators/sites/reddit/images.test.ts src/lib/aggregators/sites/reddit/content.test.ts`
Expected: PASS

- [ ] **Step 9: Wire the video header into `finalizeArticles`**

In `src/lib/aggregators/sites/reddit/aggregator.ts`, add the import:

```ts
import { buildVideoHeaderHtml, extractRedditVideo } from "./video";
```

In `parseToRawArticles`, store the video info alongside the other `_reddit_*` fields:

```ts
      const redditVideo = extractRedditVideo(originalPostData);
      // ...existing article object...
      const article: RawArticle = {
        // ...existing fields...
        _reddit_video_info: redditVideo,
      };
```

In `finalizeArticles`, change the header-building branch. Replace:

```ts
      let headerHtml: string | null = null;
      if (headerSourceUrl) {
        // ...existing image/YouTube/Twitter header logic...
      }
```

with:

```ts
      let headerHtml: string | null = null;
      const redditVideo = article._reddit_video_info as
        | { hlsUrl?: string; fallbackUrl?: string }
        | null
        | undefined;

      if (redditVideo) {
        headerHtml = await buildVideoHeaderHtml(redditVideo, headerSourceUrl);
        if (headerHtml && article.content) {
          article.content = this._stripImageFromContent(article.content, headerSourceUrl || "");
        }
      } else if (headerSourceUrl) {
        // ...existing image/YouTube/Twitter header logic, unchanged...
      }
```

Add `_reddit_video_info` to the cleanup block at the end of the loop, alongside the other deleted `_reddit_*` fields:

```ts
      delete article._reddit_post_data;
      delete article._reddit_subreddit;
      delete article._reddit_is_cross_post;
      delete article._reddit_num_comments;
      delete article._reddit_header_image_url;
      delete article._reddit_video_url;
      delete article._reddit_video_info;
      delete article.header_html;
```

- [ ] **Step 10: Run the whole Reddit suite plus golden parity**

Run: `npx vitest run src/lib/aggregators/sites/reddit src/lib/parity`
Expected: PASS

- [ ] **Step 11: Run the full project check**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: PASS

- [ ] **Step 12: Commit**

```bash
git add src/lib/aggregators/sites/reddit/types.ts src/lib/aggregators/sites/reddit/video.ts \
        src/lib/aggregators/sites/reddit/video.test.ts src/lib/aggregators/sites/reddit/images.ts \
        src/lib/aggregators/sites/reddit/images.test.ts src/lib/aggregators/sites/reddit/content.ts \
        src/lib/aggregators/sites/reddit/content.test.ts src/lib/aggregators/sites/reddit/aggregator.ts
git commit -m "feat(aggregators): play Reddit-hosted video inline and render Giphy link posts (iOS parity)"
```

---

## Execution order

Tasks 1 and 2 touch disjoint files and can run in either order. **Tasks 3, 4, 5, and 8 all modify `aggregator.ts` and must run strictly in the order written** (3 → 4 → 5 → 8) — each one's steps assume the previous task's edits to that file are already in place. Task 7 is independent (only touches `markdown.ts`) and can run any time after Task 3 (no real dependency, just keeps the branch history simple).
