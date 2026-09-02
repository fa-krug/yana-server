import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FeedLike, RawArticle } from "../../base";
import { ArticleSkipError } from "../../errors";
import { RedditAggregator } from "./aggregator";
import { fetchPostComments } from "./comments";
import { RedditPostData } from "./types";
import type { RedditPostDataDict } from "./types";

vi.mock("./comments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./comments")>()),
  fetchPostComments: vi.fn(),
}));

vi.mock("../../images/store", () => ({
  storeImageRefFromUrl: vi.fn(async () => "yana-img://abc123hash"),
}));

function article(overrides: Partial<RawArticle> = {}): RawArticle {
  return {
    name: "A video post",
    identifier: "https://reddit.com/r/test/comments/abc123/a_video_post/",
    raw_content: "",
    content: "<p>body</p>",
    date: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function aggregatorFor(options: Record<string, unknown>): RedditAggregator {
  const feed: FeedLike = { identifier: "test", dailyLimit: 20, options };
  return new RedditAggregator(feed);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postData(id: string): RedditPostDataDict {
  return {
    id,
    title: `post ${id}`,
    selftext: "",
    selftext_html: null,
    url: "",
    permalink: `/r/test/comments/${id}/post/`,
    created_utc: 0,
    author: "someone",
    score: 1,
    num_comments: 0,
    thumbnail: "",
    preview: null,
    media_metadata: null,
    gallery_data: null,
    is_gallery: false,
    is_self: true,
    is_video: false,
    media: null,
    secure_media: null,
    crosspost_parent_list: null,
  };
}

describe("RedditAggregator.logoImageUrl", () => {
  it("returns the subreddit's icon from Reddit's about.json, with no client credentials configured", async () => {
    const agg = aggregatorFor({});
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { icon_img: "https://styles.redditmedia.com/t5_x/icon.png" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(agg.logoImageUrl()).resolves.toBe("https://styles.redditmedia.com/t5_x/icon.png");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.reddit.com/r/test/about.json",
      expect.anything(),
    );

    vi.unstubAllGlobals();
  });

  it("returns null when the identifier has no subreddit", async () => {
    const feed: FeedLike = { identifier: "", dailyLimit: 20, options: {} };
    const agg = new RedditAggregator(feed);
    await expect(agg.logoImageUrl()).resolves.toBeNull();
  });

  it("returns null rather than throwing when the about.json request fails", async () => {
    const agg = aggregatorFor({});
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(agg.logoImageUrl()).resolves.toBeNull();

    vi.unstubAllGlobals();
  });
});

describe("RedditAggregator.finalizeArticles header gating", () => {
  it("emits no video header when include_header_image is false", async () => {
    const agg = aggregatorFor({ include_header_image: false });

    const [finalized] = await agg.finalizeArticles([
      article({
        _reddit_video_info: { fallbackUrl: "https://v.redd.it/a/DASH_480.mp4" },
        _reddit_header_image_url: "https://preview.redd.it/a/preview.jpg",
      }),
    ]);

    expect(finalized!.content).not.toContain("<video");
    expect(finalized!.content).not.toContain("<header");
  });

  it("emits the video header when include_header_image is left at its default", async () => {
    const agg = aggregatorFor({});

    const [finalized] = await agg.finalizeArticles([
      article({ _reddit_video_info: { fallbackUrl: "https://v.redd.it/a/DASH_480.mp4" } }),
    ]);

    expect(finalized!.content).toContain("<video");
    expect(finalized!.content).toContain("https://v.redd.it/a/DASH_480.mp4");
  });
});

describe("RedditAggregator.enrichArticles concurrency", () => {
  // No client id/secret in feed options, so `getRedditAccessToken` short-circuits
  // to `null` with no network call -- only `fetchPostComments` is mocked.
  const feed: FeedLike = { identifier: "test", dailyLimit: 20, options: { comment_limit: 5 } };

  function enrichmentArticle(id: string): RawArticle {
    return article({
      identifier: id,
      _reddit_post_data: postData(id),
      _reddit_subreddit: "test",
      _reddit_crosspost: null,
    });
  }

  it("skips articles whose comment fetch raises ArticleSkipError, keeps others on other errors", async () => {
    vi.mocked(fetchPostComments).mockImplementation(async (_subreddit, postId) => {
      if (postId === "skip") throw new ArticleSkipError("gone", 404);
      if (postId === "fail") throw new Error("network boom");
      return [];
    });

    const agg = new RedditAggregator(feed);
    const articles = [
      enrichmentArticle("ok"),
      enrichmentArticle("skip"),
      enrichmentArticle("fail"),
    ];

    const result = await agg.enrichArticles(articles);

    expect(result.map((a) => a.identifier)).toEqual(["ok", "fail"]);
    // The article that failed keeps blank content, exactly as before the
    // concurrency conversion.
    expect(result[1]!.content).toBe("");
  });

  it("preserves input order even when comment fetches finish out of completion order", async () => {
    vi.mocked(fetchPostComments).mockImplementation(async (_subreddit, postId) => {
      const delays: Record<string, number> = { "1": 30, "2": 15, "3": 0 };
      await delay(delays[postId] ?? 0);
      return [];
    });

    const agg = new RedditAggregator(feed);
    const articles = [enrichmentArticle("1"), enrichmentArticle("2"), enrichmentArticle("3")];

    const result = await agg.enrichArticles(articles);

    expect(result.map((a) => a.identifier)).toEqual(["1", "2", "3"]);
  });

  it("never runs more than the feed's concurrency comment fetches concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    vi.mocked(fetchPostComments).mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(10);
      inFlight--;
      return [];
    });

    const agg = new RedditAggregator(feed);
    const articleCount = agg.concurrency * 2 + 1;
    const articles = Array.from({ length: articleCount }, (_, i) => enrichmentArticle(`${i}`));

    const result = await agg.enrichArticles(articles);

    expect(result).toHaveLength(articleCount);
    expect(maxInFlight).toBeLessThanOrEqual(agg.concurrency);
    // Confirms the pool actually parallelizes rather than degenerating to
    // sequential execution.
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

describe("RedditAggregator.finalizeArticles header-image concurrency", () => {
  function headerImageArticle(id: string): RawArticle {
    return article({
      identifier: id,
      name: `post ${id}`,
      content: `<p>body ${id}</p>`,
      _reddit_header_image_url: `https://preview.redd.it/${id}/preview.jpg`,
    });
  }

  it("preserves input order even when image stores finish out of completion order", async () => {
    class OutOfOrderAggregator extends RedditAggregator {
      protected async _storeHeaderImage(headerImageUrl: string): Promise<string> {
        const delays: Record<string, number> = {
          "https://preview.redd.it/1/preview.jpg": 30,
          "https://preview.redd.it/2/preview.jpg": 15,
          "https://preview.redd.it/3/preview.jpg": 0,
        };
        await delay(delays[headerImageUrl] ?? 0);
        return headerImageUrl;
      }
    }

    const agg = new OutOfOrderAggregator({ identifier: "test", dailyLimit: 20 });
    const articles = [headerImageArticle("1"), headerImageArticle("2"), headerImageArticle("3")];

    const result = await agg.finalizeArticles(articles);

    expect(result.map((a) => a.identifier)).toEqual(["1", "2", "3"]);
  });

  it("never runs more than the feed's concurrency header-image stores concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    class CappedConcurrencyAggregator extends RedditAggregator {
      protected async _storeHeaderImage(headerImageUrl: string): Promise<string> {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(10);
        inFlight--;
        return headerImageUrl;
      }
    }

    const agg = new CappedConcurrencyAggregator({ identifier: "test", dailyLimit: 20 });
    const articleCount = agg.concurrency * 2 + 1;
    const articles = Array.from({ length: articleCount }, (_, i) => headerImageArticle(`${i}`));

    const result = await agg.finalizeArticles(articles);

    expect(result).toHaveLength(articleCount);
    expect(maxInFlight).toBeLessThanOrEqual(agg.concurrency);
    // Confirms the pool actually parallelizes rather than degenerating to
    // sequential execution.
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

describe("RedditAggregator.finalizeArticles video-link header caption", () => {
  it("renders the View Video caption", async () => {
    class StubHeaderImageAggregator extends RedditAggregator {
      protected async _storeHeaderImage(headerImageUrl: string): Promise<string> {
        return headerImageUrl;
      }
    }

    const feed: FeedLike = { identifier: "test", dailyLimit: 20, options: {} };
    const agg = new StubHeaderImageAggregator(feed);

    const [finalized] = await agg.finalizeArticles([
      article({
        _reddit_header_image_url: "https://preview.redd.it/a/preview.jpg",
        _reddit_video_url: "https://v.redd.it/a",
      }),
    ]);

    expect(finalized!.content).toContain("▶ View Video");
  });
});

describe("RedditAggregator.finalizeArticles YouTube-link header thumbnail", () => {
  it("localizes and embeds a thumbnail for a post linking to a YouTube video", async () => {
    const agg = aggregatorFor({});

    const [finalized] = await agg.finalizeArticles([
      article({
        _reddit_header_image_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    ]);

    expect(finalized!.content).toContain('data-embed="https://www.youtube.com/embed/dQw4w9WgXcQ"');
    expect(finalized!.content).toContain('<img src="yana-img://abc123hash"');
  });
});

describe("RedditAggregator.fetchArticleContent source title", () => {
  /**
   * The reload path's only way to reach the post's *current* title:
   * `reload.ts` reads `aggregator.sourceTitle` and hands that to the AI stage
   * instead of `articles.name`, which on a feed with an AI option on is the
   * model's own previous answer rather than source text. Left as the stored
   * name, a translate request arrived as "translate this to German" over a
   * title already in German beside an English document -- and an answer that
   * echoed the document back unchanged stored a translated title over an
   * untranslated body, silently.
   */
  function listing(post: RedditPostDataDict) {
    return [{ data: { children: [{ kind: "t3", data: post }] } }, { data: { children: [] } }];
  }

  beforeEach(() => {
    vi.mocked(fetchPostComments).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the post's own title", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => listing({ ...postData("abc123"), title: "The source's own title" }),
      }),
    );

    const agg = aggregatorFor({});
    expect(agg.sourceTitle).toBeNull();

    await agg.fetchArticleContent("https://reddit.com/r/test/comments/abc123/a_post/");

    expect(agg.sourceTitle).toBe("The source's own title");
  });

  it("reports the original post's title for a crosspost, as parseToRawArticles does", async () => {
    const original = { ...postData("orig1"), title: "The original post's title" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () =>
          listing({
            ...postData("abc123"),
            title: "The crosspost's title",
            crosspost_parent_list: [original],
          }),
      }),
    );

    const agg = aggregatorFor({});
    await agg.fetchArticleContent("https://reddit.com/r/test/comments/abc123/a_post/");

    expect(agg.sourceTitle).toBe("The original post's title");
  });
});

describe("RedditAggregator reload facade parity", () => {
  it("rebuilds the real YouTube-thumbnail facade, not the generic header, on reload's fetch/extractHeaderElement/extractContent/processContent sequence", async () => {
    vi.mocked(fetchPostComments).mockResolvedValue([]);

    const listingResponse = [
      {
        data: {
          children: [
            {
              kind: "t3",
              data: {
                ...postData("vid1"),
                url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                is_self: false,
              },
            },
          ],
        },
      },
      { data: { children: [] } },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => listingResponse,
      }),
    );

    const feed: FeedLike = { identifier: "test", dailyLimit: 20, options: {} };
    const agg = new RedditAggregator(feed);

    // This mirrors reload.ts's handleReloadJob() exactly: fetchArticleContent()
    // -> extractHeaderElement() -> extractContent() -> processContent(), with
    // no finalizeArticles() call anywhere in between -- reload never calls it.
    const identifier = "https://reddit.com/r/test/comments/vid1/a_video_post/";
    const freshHtml = await agg.fetchArticleContent(identifier);

    const rawArticle: RawArticle = article({ identifier, raw_content: freshHtml, content: "" });
    const headerData = await agg.extractHeaderElement(rawArticle);
    if (headerData) rawArticle.header_data = headerData;
    rawArticle.content = await agg.extractContent(freshHtml, rawArticle);
    const processed = await agg.processContent(rawArticle.content || "", rawArticle);

    expect(processed).toContain('data-embed="https://www.youtube.com/embed/dQw4w9WgXcQ"');
    expect(processed).toContain('<img src="yana-img://abc123hash"');

    vi.unstubAllGlobals();
  });
});

describe("RedditAggregator.extractContent legacy JSON locale", () => {
  let dbPath: string;
  let client: typeof import("../../../db/client");
  let schema: typeof import("../../../db/schema");
  let FreshRedditAggregator: typeof import("./aggregator").RedditAggregator;

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-reddit-locale-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    const { applyMigrationsAt } = await import("../../../db/test-support");
    applyMigrationsAt(dbPath);

    client = await import("../../../db/client");
    schema = await import("../../../db/schema");
    // `RedditAggregator` is imported statically at the top of this file, so
    // its transitive `chrome-labels.ts` -> `@/lib/db/client` dependency
    // captured `DB_PATH` (a module-load-time constant, see client.ts) before
    // this test ever set `DATABASE_PATH` -- resetting the module registry
    // does not retroactively change what an already-resolved module closed
    // over. A fresh dynamic import, after `vi.resetModules()`, is what makes
    // the aggregator's own `getDb()` resolve to this test's temp database.
    ({ RedditAggregator: FreshRedditAggregator } = await import("./aggregator"));
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("renders the Comments heading in the feed owner's language", async () => {
    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
      db.insert(schema.userSettings).values({ userId: "user1", language: "de" }).run();
    });

    const feed: FeedLike = { identifier: "test", dailyLimit: 20, userId: "user1" };
    const agg = new FreshRedditAggregator(feed);

    // The legacy JSON shape extractContent() falls back to parsing when its
    // input isn't already-built content HTML -- a raw post dict with at
    // least `id` and `title`. No network call happens on this path.
    const legacyJson = JSON.stringify({
      id: "abc123",
      title: "A post",
      permalink: "/r/test/comments/abc123/post/",
      is_self: true,
      selftext: "hello",
    });

    const html = await agg.extractContent(legacyJson, article());

    expect(html).toContain("Kommentare");
    expect(html).not.toContain(">Comments<");
  });
});

describe("RedditAggregator crosspost recognition", () => {
  function crosspostListing() {
    return {
      subreddit: "de",
      posts: [
        {
          data: new RedditPostData({
            id: "abc123",
            title: "the crosspost's own title",
            permalink: "/r/de/comments/abc123/title/",
            created_utc: 1,
            author: "crossposter",
            crosspost_parent_list: [
              {
                id: "xyz789",
                title: "the original title",
                permalink: "/r/ich_iel/comments/xyz789/title/",
                subreddit: "ich_iel",
                created_utc: 2,
                author: "original_author",
                num_comments: 12,
              },
            ],
          }),
        },
      ],
    };
  }

  it("captures the origin subreddit, which _getOriginalPostData() drops", async () => {
    const agg = aggregatorFor({});

    const [raw] = await agg.parseToRawArticles(crosspostListing());

    // Unchanged: the article itself is still the original post.
    expect(raw!.name).toBe("the original title");
    expect(raw!.identifier).toBe("https://reddit.com/r/ich_iel/comments/xyz789/title/");
    // New: what makes that recognizable as a crosspost downstream. The feed's
    // own subreddit is not part of it -- the reader already knows that one.
    expect(raw!._reddit_crosspost).toEqual({ originalSubreddit: "ich_iel" });
  });

  it("leaves the attribution null for an ordinary post", async () => {
    const agg = aggregatorFor({});

    const [raw] = await agg.parseToRawArticles({
      subreddit: "de",
      posts: [
        {
          data: new RedditPostData({
            id: "abc123",
            title: "an ordinary post",
            permalink: "/r/de/comments/abc123/title/",
            created_utc: 1,
            author: "someone",
          }),
        },
      ],
    });

    expect(raw!._reddit_crosspost).toBeNull();
  });

  it("carries the notice into the finished body, naming the origin subreddit", async () => {
    vi.mocked(fetchPostComments).mockResolvedValue([]);
    const agg = aggregatorFor({ comment_limit: 5 });

    const [enriched] = await agg.enrichArticles(await agg.parseToRawArticles(crosspostListing()));

    expect(enriched!.content).toContain("Crosspost: ");
    expect(enriched!.content).toContain(">r/ich_iel<");
    expect(enriched!.content).toContain('href="https://reddit.com/r/ich_iel"');
    expect(enriched!.content).not.toContain("r/de");
  });
});
