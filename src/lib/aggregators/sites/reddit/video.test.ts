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
      {
        hlsUrl: "https://v.redd.it/a/HLSPlaylist.m3u8",
        fallbackUrl: "https://v.redd.it/a/DASH.mp4",
      },
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
