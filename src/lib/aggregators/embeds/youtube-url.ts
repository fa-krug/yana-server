/**
 * Shared YouTube URL helpers: id extraction, domain detection and the
 * thumbnail-URL builder.
 *
 * **This module imports nothing, and must stay that way** -- the same rule
 * `src/lib/secrets.ts`, `src/lib/avatar.ts` and `src/lib/auth/roles.ts` live
 * under, for the same reason: `src/components/articles/block-node.tsx` is a
 * **client component** and needs `youtubeIdFrom()` to turn a stored embed's
 * `externalUrl` back into an iframe `src`. `embeds/youtube.ts` -- the rest of
 * the YouTube provider -- imports `storeImageRefFromUrl` (node fs, the image
 * store), so it drags server-only code into any bundle that imports it; a
 * client component structurally cannot import from it. This module is the
 * part with none of that, split out so `block-node.tsx` can import it
 * directly while every server-side caller keeps importing from
 * `embeds/youtube.ts`, which re-exports everything here unchanged.
 *
 * Before this module existed, six places extracted a YouTube video id from a
 * URL and disagreed on which forms they accepted -- see this module's test
 * file for the union that was found and the live bug that disagreement
 * caused (a privacy-embedded video, `youtube-nocookie.com`, and a livestream,
 * `youtube.com/live/<id>`, both passed `isYoutubeUrl()`'s domain check but
 * were not recognised by every extractor, so the embed fell through to a
 * site's `selectorsToRemove` rule and was deleted outright instead of
 * becoming a facade).
 */

/**
 * Domain alternation for `/embed/<id>` URLs.
 *
 * Shared by the two inline extractors that stay separate from
 * {@link youtubeIdFrom} on purpose -- `blocks/parser.ts`'s `YOUTUBE_PATTERNS`
 * and `sites/mein_mmo/embeds.ts`'s `extractVideoId` each apply a tighter,
 * deliberately different length constraint on the captured id (`{6,}` and
 * `{11}` respectively) than the permissive `[A-Za-z0-9_-]+` this module
 * uses. Neither should hand-maintain its own copy of which domains serve
 * `/embed/<id>` -- that was exactly the drift that let one of them fall
 * behind when `youtube-nocookie.com` was added to the other.
 */
export const YOUTUBE_EMBED_DOMAIN_ALTERNATION = "youtube\\.com|youtube-nocookie\\.com";

/** Domain fragments `isYoutubeUrl()` matches as a substring of the input URL. */
export const YOUTUBE_URL_DOMAINS = [
  "youtube.com",
  "youtu.be",
  "m.youtube.com",
  "youtube-nocookie.com",
];

/**
 * Patterns for extracting a YouTube video id from every URL form this
 * codebase is known to receive, in the order tried. This is the union of
 * what the six pre-consolidation copies accepted between them -- in
 * particular the privacy-embed domain (`youtube-nocookie.com/embed/<id>`)
 * and the `/live/<id>` livestream form, both of which `isYoutubeUrl()`
 * already accepted but not every extractor did.
 */
const YOUTUBE_ID_PATTERNS: RegExp[] = [
  /youtu\.be\/([A-Za-z0-9_-]+)/,
  /youtube\.com\/watch\?.*v=([A-Za-z0-9_-]+)/,
  /youtube\.com\/embed\/([A-Za-z0-9_-]+)/,
  /youtube-nocookie\.com\/embed\/([A-Za-z0-9_-]+)/,
  /youtube\.com\/v\/([A-Za-z0-9_-]+)/,
  /youtube\.com\/shorts\/([A-Za-z0-9_-]+)/,
  /youtube\.com\/live\/([A-Za-z0-9_-]+)/,
];

/**
 * Extract a YouTube video id from a URL string.
 *
 * Handles `watch?v=`, `youtu.be/`, `/embed/` (both `youtube.com` and the
 * privacy-embed `youtube-nocookie.com`), `/v/`, `/shorts/` and `/live/`.
 *
 * @returns The video id, or null if the URL matched none of the known forms.
 */
export function youtubeIdFrom(url: string): string | null {
  if (!url) return null;

  for (const pattern of YOUTUBE_ID_PATTERNS) {
    const match = pattern.exec(url);
    if (match) {
      const id = match[1]!;
      // Accept ids that are valid base64url characters.
      if (/^[A-Za-z0-9_-]+$/.test(id)) {
        return id;
      }
    }
  }
  return null;
}

/** Check whether a URL points at any recognised YouTube domain, embed or not. */
export function isYoutubeUrl(url: string): boolean {
  if (!url) return false;
  return YOUTUBE_URL_DOMAINS.some((domain) => url.includes(domain));
}

/** Build a thumbnail URL for a given video id and quality level. */
export function thumbnailUrlFor(id: string, quality: string = "maxresdefault"): string {
  return `https://img.youtube.com/vi/${id}/${quality}.jpg`;
}

/**
 * CSS `:not()` clauses that keep a YouTube iframe alive through a site
 * aggregator's `selectorsToRemove` pass.
 *
 * `extractContent()` (via `extractMainContent()`/`removeSelectors()`) runs
 * *before* `processContent()`'s `proxyYoutubeEmbeds()` ever sees an iframe --
 * so a bare `<iframe src="...">` that a site's own `selectorsToRemove` would
 * otherwise strip is gone before `youtubeIdFrom()` gets a chance to
 * recognise it, no matter how complete that extractor is. Heise, Merkur and
 * Mein-MMO all carry a copy of this selector precisely to keep a YouTube
 * embed's iframe from being swept up by their generic "drop stray iframes"
 * rule; each must list every domain a YouTube iframe can arrive with, or a
 * form `youtubeIdFrom()` accepts is deleted one stage before it is ever
 * consulted. This is that shared list, in CSS-selector form.
 *
 * Kept as a hand-written literal rather than derived from
 * `YOUTUBE_URL_DOMAINS` above: that array is JS string matching
 * (`url.includes(domain)`), this is a CSS attribute selector fed to cheerio
 * -- building one from the other needs a real selector-building helper for
 * exactly three call sites, which is more machinery than three call sites
 * warrant. `youtube-url.test.ts` pins that every domain
 * `YOUTUBE_URL_DOMAINS` lists is also named here, so the two cannot drift
 * silently.
 */
export const YOUTUBE_IFRAME_KEEP_SELECTOR =
  "iframe:not([src*='youtube.com']):not([src*='youtu.be']):not([src*='youtube-nocookie.com'])";
