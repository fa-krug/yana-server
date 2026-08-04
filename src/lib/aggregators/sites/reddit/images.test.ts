import { afterEach, describe, expect, it, vi } from "vitest";
import { RedditPostData } from "./types";

vi.mock("../../images/extractor", async () => {
  const actual =
    await vi.importActual<typeof import("../../images/extractor")>("../../images/extractor");
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
    expect(result).toBe("https://upload.wikimedia.org/wikipedia/commons/0/0d/Nintendo.svg");
    expect(extractImages).not.toHaveBeenCalled();
  });

  it("scrapes the linked page's og:image when a link post has no other image", async () => {
    vi.mocked(extractImages).mockResolvedValue({
      imageUrl: "https://example.com/og.png",
      imageData: Buffer.from(""),
      contentType: "image/png",
    });
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
    vi.mocked(extractImages).mockResolvedValue({
      imageUrl: "https://example.com/scraped.png",
      imageData: Buffer.from(""),
      contentType: "image/png",
    });
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
