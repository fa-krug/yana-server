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

  it("decodes HTML entities Reddit escapes into hls_url/fallback_url", () => {
    const post = new RedditPostData({
      media: {
        reddit_video: {
          hls_url: "https://v.redd.it/a/HLSPlaylist.m3u8?a=1&amp;v=1",
          fallback_url: "https://v.redd.it/a/DASH_480.mp4?a=1&amp;v=1",
        },
      },
    });
    expect(extractRedditVideo(post)).toEqual({
      hlsUrl: "https://v.redd.it/a/HLSPlaylist.m3u8?a=1&v=1",
      fallbackUrl: "https://v.redd.it/a/DASH_480.mp4?a=1&v=1",
    });
  });
});

describe("buildVideoHeaderHtml", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("prefers the MP4 source and includes a poster from the stored image ref", async () => {
    vi.mocked(storeImageRefFromUrl).mockResolvedValue("yana-img://abc123");

    const html = await buildVideoHeaderHtml(
      {
        hlsUrl: "https://v.redd.it/a/HLSPlaylist.m3u8",
        fallbackUrl: "https://v.redd.it/a/DASH.mp4",
      },
      "https://preview.redd.it/a/preview.jpg",
    );

    // The block parser reads only the first <source>, and the card it renders
    // is a link-out -- an .m3u8 there downloads as text in Chrome/Firefox.
    expect(html).toContain(
      '<video controls playsinline preload="metadata" poster="yana-img://abc123"',
    );
    expect(html).toContain('<source src="https://v.redd.it/a/DASH.mp4" type="video/mp4">');
    expect(html!.indexOf("DASH.mp4")).toBeLessThan(html!.indexOf("HLSPlaylist.m3u8"));
  });

  it("emits both sources, MP4 first then HLS, when both URLs exist", async () => {
    vi.mocked(storeImageRefFromUrl).mockResolvedValue(null);

    const html = await buildVideoHeaderHtml(
      {
        hlsUrl: "https://v.redd.it/a/HLSPlaylist.m3u8",
        fallbackUrl: "https://v.redd.it/a/DASH.mp4",
      },
      null,
    );

    expect(html).toContain(
      '<source src="https://v.redd.it/a/DASH.mp4" type="video/mp4">' +
        '<source src="https://v.redd.it/a/HLSPlaylist.m3u8" ' +
        'type="application/vnd.apple.mpegurl">',
    );
  });

  it("emits only the HLS source when there is no MP4 fallback", async () => {
    vi.mocked(storeImageRefFromUrl).mockResolvedValue(null);

    const html = await buildVideoHeaderHtml(
      { hlsUrl: "https://v.redd.it/a/HLSPlaylist.m3u8" },
      null,
    );

    expect(html).toContain(
      '<source src="https://v.redd.it/a/HLSPlaylist.m3u8" type="application/vnd.apple.mpegurl">',
    );
    expect(html).not.toContain(".mp4");
  });

  it("degrades to no poster when storing the poster image throws", async () => {
    vi.mocked(storeImageRefFromUrl).mockRejectedValue(new Error("hash collision"));

    const html = await buildVideoHeaderHtml(
      { fallbackUrl: "https://v.redd.it/a/DASH_480.mp4" },
      "https://preview.redd.it/a/preview.jpg",
    );

    expect(html).toContain('<source src="https://v.redd.it/a/DASH_480.mp4" type="video/mp4">');
    expect(html).not.toContain("poster=");
    expect(html).toContain("</video></header>");
  });

  it("returns null when the only source carries an unsafe scheme", async () => {
    const html = await buildVideoHeaderHtml({ fallbackUrl: "javascript:alert(1)" }, null);
    expect(html).toBeNull();
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

  it("emits a single, correctly-decoded ampersand for an already-decoded URL", async () => {
    vi.mocked(storeImageRefFromUrl).mockResolvedValue(null);

    // Mirrors what extractRedditVideo() now hands to this function: decoded
    // once already, so escapeHtml() must be the only re-encoding step.
    const html = await buildVideoHeaderHtml(
      {
        hlsUrl: "https://v.redd.it/a/HLSPlaylist.m3u8?a=1&v=1",
        fallbackUrl: "https://v.redd.it/a/DASH_480.mp4?a=1&v=1",
      },
      null,
    );

    expect(html).toContain(
      '<source src="https://v.redd.it/a/DASH_480.mp4?a=1&amp;v=1" type="video/mp4">',
    );
    expect(html).toContain(
      '<source src="https://v.redd.it/a/HLSPlaylist.m3u8?a=1&amp;v=1" ' +
        'type="application/vnd.apple.mpegurl">',
    );
    expect(html).not.toContain("&amp;amp;");
  });
});
