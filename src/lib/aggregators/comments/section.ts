import { isSafeUrl } from "../blocks/parser";
import type { ChromeLabels } from "../chrome-labels";
import { sanitizeUntrustedFragment } from "../extract/clean";
import { escapeHtml } from "../extract/format";

/**
 * One declaration -> one rendered comments section, replacing four
 * hand-copied implementations of "emit a heading, then N `<blockquote>`s":
 * `sites/mactechnews/comments.ts`, `sites/mein_mmo/comments.ts`,
 * `sites/reddit/content.ts` and `sites/youtube/aggregator.ts`. Modeled on
 * `defineIntegration()`'s "one declaration, shared sequence" shape
 * (`src/lib/integrations/define.ts`): each site supplies only the parts that
 * genuinely differ -- where its comment list comes from and how one item's
 * author/timestamp/body/link are read -- and the sequence that turns those
 * into markup lives here once.
 *
 * Every comment body is routed through `sanitizeUntrustedFragment()`
 * unconditionally, by this module rather than by each call site -- the
 * structural point of putting the sanitizer call in the one builder instead
 * of in four separate callers, so a fifth comment source cannot forget it.
 * Reddit's `bodyHtml()` already runs its markdown through
 * `sanitizeUntrustedFragment()` on the way to HTML (see
 * `sites/reddit/markdown.ts`'s `convertRedditMarkdown()`); sanitizing that
 * output a second time here is a deliberate no-op, not a bug -- the pass is
 * idempotent (nothing left to rename to `data-sanitized-*`, nothing left to
 * strip, no unsafe `href`/`src` survives a first pass for a second to catch),
 * and keeping the call unconditional is what makes it impossible for a future
 * site to skip.
 *
 * The remaining per-site differences below are descriptor **data**, not
 * something this consolidation normalises away -- each one is a real,
 * observed difference between the four current call sites:
 *  - mactechnews/mein_mmo wrap the section in a bare `<section>`; YouTube in
 *    `<div class="youtube-comments">`; Reddit wraps in nothing at all --
 *    its heading and comments ride bare inside `formatArticleContent()`'s
 *    own `ARTICLE_COMMENTS_CLASS` wrapper, so nothing here should add a
 *    second one.
 *  - mactechnews/mein_mmo's per-comment source link is a bare `<a href>`;
 *    Reddit/YouTube's carries `target="_blank" rel="noopener"`.
 *  - An empty list is a silent `null` -- the whole section, heading
 *    included, is dropped -- for mactechnews/mein_mmo/YouTube, but Reddit
 *    always renders its heading and shows a status message
 *    ("No comments yet." / "Comments disabled." / "Comments unavailable.")
 *    even when there is nothing under it.
 *  - mactechnews/mein_mmo show a "(timestamp)" after the author; Reddit and
 *    YouTube show no timestamp at all.
 *  - YouTube's per-comment link is built from an already-escaped video/comment
 *    id and must not be run through `escapeHtml()` a second time, or its
 *    literal "&" between query parameters would be double-escaped.
 */
export interface CommentSpec<S, T> {
  /**
   * Extract the (already validity-filtered, already `max`-limited) list of
   * comment-like items from `source` -- a DOM scrape of a fetched page for
   * mactechnews/mein_mmo, or the already-fetched array itself for
   * Reddit/YouTube, whose list comes from an API rather than a scrape. Doing
   * the slicing here (not after) matters when a source can contain more
   * elements than are valid comments: mactechnews/mein_mmo slice the *raw*
   * DOM matches to `max` and only then discard the ones with no body, which
   * can leave fewer than `max` items -- never more than `max` raw elements
   * considered in the first place.
   */
  list(source: S): T[];
  author(comment: T): string;
  /**
   * Set when `author()` already returns safe markup of its own (YouTube's
   * author can itself be a link to the commenter's channel) rather than
   * plain text this builder must `escapeHtml()`. Defaults to `false`.
   */
  authorIsHtml?: boolean;
  timestamp?(comment: T): string;
  /** The comment's own body, as untrusted HTML. */
  bodyHtml(comment: T): string;
  anchorUrl(comment: T): string;
  /**
   * Set when `anchorUrl()` is already a well-formed `href` value (YouTube
   * bakes an already-`escapeHtml()`'d comment id into its comment permalink)
   * and must not be escaped a second time. Defaults to `false`. The
   * `isSafeUrl()` gate applies either way.
   */
  rawAnchorHref?: boolean;
  /**
   * Extra attributes on the heading link and every comment's source link --
   * Reddit and YouTube add `target="_blank" rel="noopener"`,
   * mactechnews/mein_mmo do not.
   */
  linkAttrs?: string;
  /** Reddit/YouTube's per-comment template has a leading/trailing newline
   * around each tag; mactechnews/mein_mmo's has none. */
  multiline?: boolean;
  /**
   * Wraps the whole section in this tag. Omitted (Reddit) means the heading
   * and comments are handed back bare, for the caller's own wrapper
   * (`formatArticleContent()`'s `ARTICLE_COMMENTS_CLASS` section) to be the
   * only one -- adding a second wrapper here would be a new, unrequested
   * nesting level, not a preserved one.
   */
  wrapTag?: "section" | "div";
  wrapClass?: string;
  /**
   * Catalog key to show, alongside the heading, when the list is empty.
   * Omitted means: drop the whole section, heading included, exactly as
   * mactechnews/mein_mmo/YouTube do when nothing could be extracted. Set
   * means: still render the heading, with this message under it -- Reddit's
   * three empty states (disabled/unavailable/no comments yet) are three
   * calls with three different `emptyLabel`s, decided by the caller before
   * it ever reaches this function.
   */
  emptyLabel?: keyof ChromeLabels;
}

function renderLink(
  url: string,
  label: string,
  attrs: string | undefined,
  rawHref: boolean,
): string {
  if (!isSafeUrl(url)) {
    return escapeHtml(label);
  }
  const href = rawHref ? url : escapeHtml(url);
  const attrPart = attrs ? ` ${attrs}` : "";
  return `<a href="${href}"${attrPart}>${escapeHtml(label)}</a>`;
}

function renderHeading<S, T>(
  sectionUrl: string | null,
  spec: CommentSpec<S, T>,
  labels: ChromeLabels,
): string {
  const label = labels.comments;
  // Catalog values in the `aggregatorChrome` namespace are guaranteed never
  // to contain HTML special characters (see chrome-labels.ts), so this plain
  // interpolation on the no-link branch matches every site's current output
  // exactly -- there is nothing for escapeHtml() to change.
  const inner = sectionUrl ? renderLink(sectionUrl, label, spec.linkAttrs, false) : label;
  return `<h3>${inner}</h3>`;
}

function renderComment<S, T>(spec: CommentSpec<S, T>, comment: T, labels: ChromeLabels): string {
  const authorRaw = spec.author(comment);
  const authorHtml = spec.authorIsHtml ? authorRaw : escapeHtml(authorRaw);
  const timestamp = spec.timestamp?.(comment);
  const tsDisplay = timestamp ? ` (${escapeHtml(timestamp)})` : "";
  const sourceLink = renderLink(
    spec.anchorUrl(comment),
    labels.source,
    spec.linkAttrs,
    Boolean(spec.rawAnchorHref),
  );
  const body = sanitizeUntrustedFragment(spec.bodyHtml(comment));
  const nl = spec.multiline ? "\n" : "";
  return (
    `${nl}<blockquote>${nl}<p><strong>${authorHtml}</strong>${tsDisplay} | ${sourceLink}</p>` +
    `${nl}<div>${body}</div>${nl}</blockquote>${nl}`
  );
}

function wrap<S, T>(spec: CommentSpec<S, T>, inner: string): string {
  if (!spec.wrapTag) {
    return inner;
  }
  const cls = spec.wrapClass ? ` class="${escapeHtml(spec.wrapClass)}"` : "";
  return `<${spec.wrapTag}${cls}>${inner}</${spec.wrapTag}>`;
}

function logFailure(
  sectionUrl: string | null,
  err: unknown,
  onLog?: (message: string) => void,
): void {
  const where = sectionUrl ? ` for ${sectionUrl}` : "";
  const reason = err instanceof Error ? err.message : String(err);
  // Mirrors website.ts's onLog convention (see its "no body extracted"
  // log): this is the most selector-fragile code in the tree, and until now
  // a failure here was a bare `catch { /* ignore */ }` with no signal at
  // all, anywhere.
  const message = `[comments] failed to extract comments${where}: ${reason}`;
  console.warn(message);
  onLog?.(message);
}

/**
 * Build a comments section from `spec`, or `null` when there is nothing to
 * show (see `CommentSpec.emptyLabel` for when "nothing" still means a
 * heading and a status message). Never throws: a failure inside `spec.list()`
 * or while rendering an individual comment is caught, logged via `onLog`, and
 * degrades to `null` -- the same "skip rather than break the article" shape
 * `catch { /* ignore *\/ }` used to have, minus the silence.
 */
export function buildCommentsSection<S, T>(
  spec: CommentSpec<S, T>,
  source: S,
  sectionUrl: string | null,
  max: number,
  labels: ChromeLabels,
  onLog?: (message: string) => void,
): string | null {
  let items: T[];
  let parts: string;
  try {
    items = spec.list(source).slice(0, max);
    parts = items.map((item) => renderComment(spec, item, labels)).join("");
  } catch (err) {
    logFailure(sectionUrl, err, onLog);
    return null;
  }

  if (items.length === 0) {
    if (!spec.emptyLabel) {
      return null;
    }
    const heading = renderHeading(sectionUrl, spec, labels);
    const empty = `<p><em>${labels[spec.emptyLabel]}</em></p>`;
    return wrap(spec, `${heading}${empty}`);
  }

  const heading = renderHeading(sectionUrl, spec, labels);
  return wrap(spec, `${heading}${parts}`);
}
