/**
 * The tags every stage of this pipeline agrees are never article content:
 * `content.ts`'s pre-content-selection cleanup, `clean.ts`'s
 * untrusted-fragment sanitizer, and `blocks/parser.ts`'s block-tree builder
 * each drop `script` and `style` unconditionally, for the same reason --
 * neither is ever prose, in any context.
 *
 * Past this pair the three lists are genuinely different, not merely
 * inconsistent with each other, and were deliberately **not** unioned into
 * one list:
 *  - `iframe` is dropped by `clean.ts`'s sanitizer and, separately, by the
 *    parser's own drop list -- but the parser only reaches that fallback
 *    when embeds are disallowed; when they are allowed, the very same tag
 *    becomes a real embed block instead (`iframeEmbed()` in
 *    `blocks/parser.ts`), and `YOUTUBE_IFRAME_KEEP_SELECTOR`
 *    (`embeds/youtube-url.ts`) deliberately preserves some iframes before
 *    they'd otherwise be stripped. Adding `iframe` here would blanket-drop
 *    it in `content.ts`'s pre-selection pass too, before any of that keep
 *    logic ever runs.
 *  - `audio` is in the parser's drop list only as that same kind of
 *    fallback -- an `<audio>` becomes a real embed block when embeds are
 *    allowed. It is legitimate media on a podcast article and must never be
 *    dropped unconditionally.
 *  - `noscript`/`template` (content.ts) and `object`/`embed` (clean.ts) are
 *    each meaningful only where they're checked: `template` can hide
 *    unrendered markup that would confuse content *selection*, before any
 *    content exists to sanitize yet; `object`/`embed` are legacy plugin
 *    embeds worth stripping from *untrusted* fragments (comments, converted
 *    Markdown) specifically.
 *  - `form`/`input`/`button`/`select`/`textarea`/`svg`/`canvas` are
 *    parser-only: never valid block content once HTML has already been
 *    reduced to an article body, but not a sanitization concern for an
 *    arbitrary untrusted fragment the way script/style/object/embed/iframe
 *    are.
 */
export const NEVER_CONTENT_TAGS = ["script", "style"];
