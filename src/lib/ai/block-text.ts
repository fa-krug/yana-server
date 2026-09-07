/**
 * The block tree as text a model can rewrite, and back again.
 *
 * **Why this exists.** AI post-processing used to hand the provider the
 * article's HTML and parse HTML back out of the answer -- a round trip through
 * a format that is not even what gets stored. There is no `articles.content`
 * column: the block tree (`../aggregators/blocks/types`) is the stored
 * artifact, and `parseBlocks()` is a one-way HTML -> blocks conversion with no
 * inverse. So the HTML was pure transport, and an expensive one: every tag,
 * every `data-sanitized-*` attribute and every URL was billed on the way in
 * and, because the prompt demanded the document back verbatim, again on the way
 * out. Measured on real pages, this notation is 12-19% the size of the HTML it
 * replaces.
 *
 * **Two things the model never sees, and therefore cannot break.**
 * - **Every URL.** A link becomes `[text](L3)`, an index into `links`. The
 *   model cannot corrupt an href, invent a tracking parameter, or translate one
 *   -- and we do not pay for URLs, which on a link-dense page are a large share
 *   of the bytes.
 * - **Every non-prose block.** Images, embeds, code blocks and dividers become
 *   `[[M7]]` placeholders indexing `opaque`. They can be *moved* (the model is
 *   allowed to restructure) but never edited, so a `yana-img://` ref, an embed
 *   provider or a line of code cannot come back altered. Code is also simply
 *   not sent, which is both cheaper and the only correct answer for a
 *   translation request.
 *
 * An image's caption *is* prose, so it rides after its placeholder
 * (`[[M7]] The caption`) where a rewrite can reach it. An embed's `title` does
 * not: it is the provider's own title for someone else's video.
 *
 * **The parser is total.** Anything it does not recognise stays literal text
 * rather than throwing -- a model that mangles the notation degrades to plain
 * prose instead of failing the article. What it cannot do is invent structure
 * that was not asked for, because the only structural characters it honours are
 * the ones this module writes.
 *
 * **The contract that makes it safe is the round trip**, pinned in
 * `block-text.test.ts`: for any block tree this module can serialize,
 * `textToBlocks(blocksToText(b))` is `canonicalBlocks(b)` -- the exported
 * normal form, not `b` itself. That distinction is the specification rather
 * than a shortfall: the notation is line-oriented and cannot carry a newline
 * *inside* a paragraph, and `parseBlocks()` does emit those (HTML source line
 * breaks, and its own table flattening), so a run serialized raw came back as
 * two paragraphs. `canonicalBlocks()` collapses whitespace (except inside a
 * `code` run, where it is content), merges adjacent identically-styled runs,
 * trims paragraph edges, drops any block that canonicalizes to nothing (a
 * `textToBlocks` line-oriented parse never records one either) and clamps a
 * heading to the 1-6 levels the notation can write -- and is idempotent, which
 * is what lets the rewrite path trust a returned document it did not build.
 * `blocksToText()` canonicalizes the whole tree once, up front, rather than
 * per block: serializing a raw tree while writing a canonicalized caption or
 * heading marker into the text is how an image's stored placeholder and its
 * serialized caption used to disagree about the same block.
 */

import { clampHeadingLevel } from "@/lib/aggregators/blocks/types";
import type {
  Block,
  CodeBlock,
  Divider,
  EmbedBlock,
  ImageBlock,
  InlineRun,
  ListBlock,
} from "@/lib/aggregators/blocks/types";

/** What the model is shown, plus the two side tables it never sees. */
export interface BlockDocument {
  /** The prose, in the notation above. */
  text: string;
  /**
   * Blocks referenced as `[[M<n>]]`. Reorderable, never editable.
   *
   * Only ever read back out by index, so a placeholder the model drops simply
   * drops that block -- which is why `textToBlocks` reports what went missing
   * rather than silently losing an image.
   */
  opaque: Block[];
  /** Link targets referenced as `(L<n>)`. */
  links: string[];
}

/**
 * A block whose content is never shown to the model.
 *
 * A **type predicate**, not a boolean: it is what narrows `Block` down to the
 * prose kinds for `serializeBlocks`' switch, so that switch's `default` arm can
 * assert `never` and turn "a block kind was added and nobody taught this module
 * about it" into a compile error instead of silently deleted content.
 */
function isOpaque(block: Block): block is ImageBlock | EmbedBlock | CodeBlock | Divider {
  return (
    block.kind === "image" ||
    block.kind === "embed" ||
    block.kind === "code_block" ||
    block.kind === "divider"
  );
}

/**
 * Characters that mean something in this notation, escaped with a backslash so
 * prose containing them survives the round trip.
 *
 * Just three: `<` opens an inline tag, `[`/`]` delimit a link or a `[[M0]]`
 * placeholder. A literal backslash is escaped first, or unescaping would
 * consume the wrong character.
 *
 * Note what is *not* here -- `*`, `` ` `` and `~` are ordinary text, because
 * inline styling is tags rather than Markdown emphasis. That is not a
 * cosmetic choice: `**bold***italic*` (two adjacent runs) serializes to a run
 * of five asterisks that no reader can split the same way twice, and prose is
 * full of asterisks and tildes that would otherwise each need a backslash.
 */
function escapeText(text: string): string {
  return text.replace(/([\\<[\]])/g, "\\$1");
}

/**
 * The line-start markers -- heading, list, blockquote -- only mean anything as
 * the first thing on a line, so they are escaped only there. Escaping them
 * everywhere would put backslashes through ordinary prose (`a - b`, `5. also`).
 */
function escapeLineStart(line: string): string {
  // `>` with **or without** a trailing space: the reader accepts a bare `>` as
  // an empty quoted line, so a paragraph whose entire text is `>` was escaped by
  // neither side and vanished into an empty blockquote the reader then dropped.
  return line.replace(/^(\s*)(#{1,6} |[-*+] |>|\d+\. )/, "$1\\$2");
}

/**
 * The form a block tree takes after a round trip through this notation.
 *
 * **This is the round trip's specification, not a tidy-up.** The notation is
 * line-oriented, so it cannot carry a newline *inside* a paragraph's text --
 * and `parseBlocks()` does emit those: HTML source line breaks and its own
 * table flattening both leave `\n` in run text. Serialized raw, such a run
 * came back as two paragraphs (measured on real pages: a 7-block article read
 * back as 9). Collapsing runs of whitespace to a single space is what makes the
 * notation total over real trees, and it changes nothing that renders or
 * searches: HTML collapses inter-word whitespace anyway, and `plainTextOf()`
 * feeds FTS5, which tokenizes on it.
 *
 * Three normalizations, each for its own reason:
 * - **Whitespace collapsed**, except inside a `code` run, where it is content.
 * - **Adjacent runs with identical styling merged.** The notation has no way to
 *   express a boundary between two identically-styled spans, and no reason to.
 *   `parseBlocks()` produces such pairs routinely: `<p>a<span>b</span>c</p>`
 *   yields three runs with identical styling, one per source node.
 * - **Edge whitespace trimmed** off a paragraph, heading or caption, and empty
 *   runs dropped, since a line's leading and trailing space cannot survive a
 *   line-oriented format and means nothing rendered.
 *
 * - **A heading's level clamped to 1-6**, via `clampHeadingLevel()`
 *   (`../aggregators/blocks/types` -- see its doc comment). The only range
 *   this notation can write (`"#".repeat(level)`) and `article_blocks.level`
 *   can be read back as; `../aggregators/blocks/storage`'s `rowForNode()` and
 *   `blockForRow()` call the same function, so there is exactly one
 *   implementation of this arithmetic rather than two that can drift.
 *   `serializeBlocks()` below relies on `canonicalBlocks()` having already
 *   applied it rather than repeating the call, which is what used to let a
 *   `level: 7` heading round-trip to 6 while `canonicalBlocks()` alone left it
 *   at 7.
 * - **A block that canonicalizes to nothing is dropped**, recursively --
 *   see `isEmptyBlock()`. `textToBlocks`'s line-oriented parse never records
 *   an empty paragraph, an empty heading, a quote with no surviving content or
 *   a list with no surviving items either (a blank line is skipped, and
 *   `parseLines` only ever pushes a quote or a list when something parsed
 *   inside it), so leaving one in `canonicalBlocks()`'s output was the source
 *   of three distinct failures: an empty paragraph made the round trip
 *   unstable, a `heading level:2 runs:[]` came back as the literal paragraph
 *   `"##"` (the serialized line lost its required trailing space to `.trim()`
 *   and stopped looking like a heading), and a list whose first item was empty
 *   came back as a stray one-word paragraph *plus* a shorter list, because the
 *   serialized marker line for that item was itself indistinguishable from
 *   plain text once trimmed. Dropping it here, before anything is serialized,
 *   is what stops all three at once.
 *
 * Idempotent, so it is a normal form rather than a transformation: the contract
 * pinned in `block-text.test.ts` is
 * `textToBlocks(blocksToText(b)) === canonicalBlocks(b)`.
 */
export function canonicalBlocks(blocks: Block[]): Block[] {
  return blocks
    .map((block): Block => {
      switch (block.kind) {
        case "paragraph":
          return { ...block, runs: canonicalRuns(block.runs) };
        case "heading":
          return {
            ...block,
            level: clampHeadingLevel(block.level),
            runs: canonicalRuns(block.runs),
          };
        case "image":
          return { ...block, caption: canonicalRuns(block.caption) };
        case "blockquote":
        case "summary":
          return { ...block, blocks: canonicalBlocks(block.blocks) };
        case "list":
          // An item that canonicalizes to nothing is dropped too -- not kept
          // as an empty `[]` entry -- for the same reason: nothing on the
          // `textToBlocks` side ever produces a list item with zero blocks.
          return {
            ...block,
            items: block.items.map(canonicalBlocks).filter((item) => item.length > 0),
          };
        default:
          return block;
      }
    })
    .filter((block) => !isEmptyBlock(block));
}

/**
 * Whether a block, once canonicalized, carries nothing a reader would ever
 * see -- see `canonicalBlocks()`'s doc comment for why this has to be checked
 * there rather than left for `textToBlocks` to disagree about later. An
 * image, embed, code block or divider is never empty by this measure: each
 * always carries a reference (a ref, a URL, code text) that no amount of
 * missing prose can take away.
 */
function isEmptyBlock(block: Block): boolean {
  switch (block.kind) {
    case "paragraph":
    case "heading":
      return block.runs.length === 0;
    case "blockquote":
    case "summary":
      return block.blocks.length === 0;
    case "list":
      return block.items.length === 0;
    default:
      return false;
  }
}

function sameStyle(a: InlineRun, b: InlineRun): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.code === !!b.code &&
    !!a.strikethrough === !!b.strikethrough &&
    (a.link ?? "") === (b.link ?? "")
  );
}

function canonicalRuns(runs: InlineRun[]): InlineRun[] {
  // Dropped *before* the merge, not after: an empty run sitting between two
  // identically-styled runs would otherwise keep them apart on the first pass
  // and let them merge on the second, which is not a normal form.
  //
  // Merged *before* whitespace is collapsed, not after -- collapsing each run
  // on its own first and merging the (already-collapsed) results left a
  // boundary uncollapsed: two adjacent same-style runs each ending/starting
  // with a single space collapsed fine individually, but concatenating them
  // produced a run of two spaces that only the *next* `canonicalRuns()` call
  // collapsed to one. Found by the fuzz test in `block-text.test.ts`: an
  // italic run of trailing spaces merging with an adjacent italic run was
  // enough to make `canonicalRuns(canonicalRuns(x))` differ from
  // `canonicalRuns(x)`. Collapsing the merged text instead sees the true
  // boundary, so there is nothing left for a second pass to find.
  const merged = runs
    .filter((run) => run.text !== "")
    .reduce<InlineRun[]>((acc, run) => {
      const previous = acc[acc.length - 1];
      if (previous && sameStyle(previous, run)) {
        acc[acc.length - 1] = { ...previous, text: previous.text + run.text };
        return acc;
      }
      acc.push({ ...run });
      return acc;
    }, [])
    .map((run) =>
      run.code
        ? // A code run keeps its spaces and tabs -- they are content -- but
          // **not its line breaks**, which this notation structurally cannot
          // carry. `inlineRuns()` emits a `"\n"` run for a `<br>`, and inside
          // `<code>` that run is `code: true`: written raw it put a bare
          // newline *inside a line*, so
          // `<p>Run <code>npm i<br>npm test</code> now.</p>` reached the model
          // as an unbalanced `<code>` split across two lines -- unanswerable
          // by construction -- and came back as two paragraphs with the
          // literal tags stored as prose. Spaces-only code (the case the test
          // covered) never showed it.
          { ...run, text: run.text.replace(/[\r\n]+/g, " ") }
        : { ...run, text: run.text.replace(/\s+/g, " ") },
    );

  // Trimmed *after* collapsing and merging, and by a loop rather than a
  // single pass on each edge: a run of pure whitespace sitting at the
  // boundary (its own run, because it differs in style from its neighbour)
  // trims to empty and has to be dropped, which exposes a *new* edge run that
  // itself may still carry untrimmed boundary whitespace. A single
  // trim-then-filter pass trimmed only the original edge and left that
  // newly-exposed one untouched -- the exact non-idempotence this loop exists
  // to close: run it once more and the now-untrimmed edge trims further, so
  // `canonicalRuns(canonicalRuns(x))` was not `canonicalRuns(x)`.
  trimEdge(merged, "start");
  trimEdge(merged, "end");

  return merged;
}

/**
 * Trim leading (`"start"`) or trailing (`"end"`) whitespace off the run at the
 * given edge of `runs`, mutating it in place, dropping the run entirely if the
 * trim empties it and then re-checking the run newly exposed at that edge --
 * see the comment above this call for why one trim-then-filter pass is not
 * enough.
 */
function trimEdge(runs: InlineRun[], edge: "start" | "end"): void {
  while (runs.length > 0) {
    const index = edge === "start" ? 0 : runs.length - 1;
    const run = runs[index];
    if (run.code) return;

    const trimmed = edge === "start" ? run.text.replace(/^ +/, "") : run.text.replace(/ +$/, "");
    if (trimmed === run.text) return; // nothing to trim, and nothing exposed
    if (trimmed === "") {
      runs.splice(index, 1);
      continue; // the run now at this edge may itself need trimming
    }
    runs[index] = { ...run, text: trimmed };
    return;
  }
}

/**
 * The inline style tags, innermost first.
 *
 * Deliberately HTML's own names for the four styles: a model handles `<b>` and
 * `<i>` more reliably than any notation invented here, and unlike Markdown
 * emphasis they cannot run together ambiguously when two styled runs are
 * adjacent. They carry no attributes, so none of the bloat this whole module
 * exists to remove comes back with them.
 */
const STYLE_TAGS = [
  ["code", "code"],
  ["strikethrough", "s"],
  ["italic", "i"],
  ["bold", "b"],
] as const;

/**
 * A link's index into `links`, resolved through `linkIndex` instead of
 * `links.indexOf()` -- an O(1) lookup rather than an O(n) scan repeated once
 * per run, which made a link-dense article's serialization quadratic in its
 * link count. `linkIndex` is a side table kept in step with `links` by every
 * caller that adds to it; there is exactly one, built in `blocksToText()`.
 */
function serializeRun(run: InlineRun, links: string[], linkIndex: Map<string, number>): string {
  // A code run's text is still escaped: it has to survive a `</code>` inside
  // it, and unescaping on the way back restores it exactly.
  let out = escapeText(run.text);

  for (const [flag, tag] of STYLE_TAGS) {
    if (run[flag]) out = `<${tag}>${out}</${tag}>`;
  }

  if (run.link) {
    let index = linkIndex.get(run.link);
    if (index === undefined) {
      index = links.length;
      links.push(run.link);
      linkIndex.set(run.link, index);
    }
    out = `[${out}](L${index})`;
  }

  return out;
}

function serializeRuns(runs: InlineRun[], links: string[], linkIndex: Map<string, number>): string {
  // Not canonicalized here: `blocksToText()` canonicalizes the whole tree once,
  // up front, so every run this function is ever handed already is. Doing it
  // again here, per run list, is what let an image's raw block land in
  // `doc.opaque` while its *canonicalized* caption landed in the text -- two
  // views of the same block that had each been canonicalized on its own.
  return runs.map((run) => serializeRun(run, links, linkIndex)).join("");
}

function serializeBlocks(
  blocks: Block[],
  doc: BlockDocument,
  indent: string,
  linkIndex: Map<string, number>,
): string[] {
  const lines: string[] = [];

  const push = (body: string) => {
    if (lines.length > 0) lines.push("");
    lines.push(indent + body);
  };

  for (const block of blocks) {
    if (isOpaque(block)) {
      const index = doc.opaque.length;
      doc.opaque.push(block);
      // An image's caption is prose and rides along; everything else is the
      // placeholder alone. `block` (and so its caption) is already the
      // canonical form -- see the note on `serializeRuns()` -- so what lands
      // in `doc.opaque` here and what serializes into the text below can no
      // longer disagree about the same image.
      const caption =
        block.kind === "image" && block.caption.length > 0
          ? " " + serializeRuns(block.caption, doc.links, linkIndex)
          : "";
      push(`[[M${index}]]${caption}`);
      continue;
    }

    switch (block.kind) {
      case "paragraph":
        push(escapeLineStart(serializeRuns(block.runs, doc.links, linkIndex)));
        break;

      case "heading":
        // `block.level` is already clamped to 1-6 -- `blocksToText()` ran the
        // whole tree through `canonicalBlocks()` first, and that is the one
        // place this clamps. See the note there.
        push(`${"#".repeat(block.level)} ${serializeRuns(block.runs, doc.links, linkIndex)}`);
        break;

      case "list": {
        // One blank line before the list, none between its items: a list is a
        // single block, and blank-separated items would parse back as several.
        if (lines.length > 0) lines.push("");
        block.items.forEach((item, i) => {
          const marker = block.ordered ? `${i + 1}. ` : "- ";
          const inner = serializeBlocks(item, doc, "", linkIndex);
          // The item's first block sits on the marker line; any further block is
          // a continuation line, indented so it rejoins this item rather than
          // becoming a paragraph after the list.
          //
          // **A blank line inside the item is kept, and kept truly blank.** It
          // used to be filtered out, which silently undid the separator that
          // tells two adjacent blocks apart -- two blockquotes in one item came
          // back as one. Indenting it instead would not work either: the reader
          // recognises a continuation by its indent, and `"  "` alone has none
          // to find.
          lines.push(indent + marker + (inner[0] ?? ""));
          for (const extra of inner.slice(1)) {
            lines.push(extra === "" ? "" : indent + "  " + extra);
          }
        });
        break;
      }

      // `image`/`embed`/`code_block`/`divider` never reach here -- `isOpaque()`
      // took them above. The `default` arm is what makes that a *checked*
      // claim: without it a block kind added later fell through this switch,
      // serialized to nothing, came back as nothing, and was written over the
      // article -- every block of that kind deleted from every AI-processed
      // article, with `tsc` silent and no test failing. Failing closed (throw,
      // and the caller keeps the article untouched) beats deleting content.
      // `storage.ts`'s `writeBlocks` has had this guard all along.
      default: {
        const unreachable: never = block;
        throw new TypeError(`block kind not serializable: ${JSON.stringify(unreachable)}`);
      }

      case "blockquote":
      case "summary": {
        // A blank line before, like every other block gets from `push()`.
        // Without it two adjacent blockquotes serialized to consecutive `>`
        // lines and the reader -- which consumes a run of them as one quote --
        // merged them, so three quotes came back as one.
        if (lines.length > 0) lines.push("");
        // `summary` is serialized like a blockquote and comes back as a
        // blockquote, which is correct for the one direction that matters: a
        // summary only ever exists as *output* of a previous AI run, and the
        // input to this one is always freshly parsed from the source. Nothing
        // asks this module to preserve one.
        for (const line of serializeBlocks(block.blocks, doc, "", linkIndex)) {
          lines.push(indent + (line === "" ? ">" : "> " + line));
        }
        break;
      }
    }
  }

  return lines;
}

/**
 * Serialize a block tree for a provider request.
 *
 * `summary` blocks are written as blockquotes rather than preserved -- see the
 * note at that case. Everything else round-trips exactly, which
 * `block-text.test.ts` asserts against this repo's own parser output.
 */
export function blocksToText(blocks: Block[]): BlockDocument {
  const doc: BlockDocument = { text: "", opaque: [], links: [] };
  // Canonicalized once, here, for the whole tree -- not per block inside
  // `serializeBlocks()`. See `canonicalBlocks()`'s doc comment for the two
  // things that requires: a heading's level clamped before `"#".repeat()`
  // ever reads it, and an opaque block (an image, with its caption) pushed
  // into `doc.opaque` in the same canonical form its caption serializes as.
  const linkIndex = new Map<string, number>();
  doc.text = serializeBlocks(canonicalBlocks(blocks), doc, "", linkIndex).join("\n");
  return doc;
}

/** A fully-populated run, matching what `parseBlocks()` itself emits. */
function makeRun(
  text: string,
  style: { bold: boolean; italic: boolean; code: boolean; strikethrough: boolean; link: string },
): InlineRun {
  return {
    text,
    bold: style.bold,
    italic: style.italic,
    code: style.code,
    strikethrough: style.strikethrough,
    link: style.link,
  };
}

type Style = {
  bold: boolean;
  italic: boolean;
  code: boolean;
  strikethrough: boolean;
  link: string;
};

const NO_STYLE: Style = { bold: false, italic: false, code: false, strikethrough: false, link: "" };

/** A `[[Mn]]` placeholder found anywhere, not just anchored to a whole line -- see `parseInline()`. */
const STRAY_OPAQUE_TOKEN = /^\[\[M\d+\]\]/;

/**
 * Turn one line of inline notation back into runs.
 *
 * Recursive descent over the delimiters this module writes, and nothing else.
 * An unmatched delimiter is literal text -- the total-parser rule -- so a model
 * that emits a stray `**` produces two asterisks rather than losing the rest of
 * the paragraph.
 */
function parseInline(source: string, links: string[], style: Style = NO_STYLE): InlineRun[] {
  const runs: InlineRun[] = [];
  let plain = "";

  const flush = () => {
    if (plain) {
      runs.push(makeRun(plain, style));
      plain = "";
    }
  };

  let i = 0;
  while (i < source.length) {
    // A `[[Mn]]` placeholder that survives to here is not on its own line --
    // `parseLines()` only ever hands a whole placeholder line to `OPAQUE_LINE`
    // before reaching inline parsing, so one found mid-run is a token the
    // model embedded in running prose (`As shown in [[M0]] the sales rose.`).
    // The referenced block is already correctly reported as dropped (it never
    // reaches `state.seen`), so this is purely about not also storing the
    // literal `[[M0]]` as visible article text. Stripped, never refused: the
    // parser is total, and failing an otherwise-fine paragraph over a stray
    // token the model left behind would be a worse answer than losing the
    // eight characters of markup.
    const stray = STRAY_OPAQUE_TOKEN.exec(source.slice(i));
    if (stray) {
      i += stray[0].length;
      // Swallow one adjacent space so the removal doesn't leave a double
      // space behind; the plain text before and after is otherwise untouched.
      if (source[i] === " " && (plain === "" || plain.endsWith(" "))) {
        i += 1;
      }
      continue;
    }

    const consumed = tryDelimiter(source, i, links, style);
    if (consumed) {
      flush();
      runs.push(...consumed.runs);
      i = consumed.next;
      continue;
    }

    if (source[i] === "\\" && i + 1 < source.length) {
      plain += source[i + 1];
      i += 2;
      continue;
    }

    // Either an ordinary character, or a delimiter that found no partner --
    // which is literal text, per the total-parser rule.
    plain += source[i];
    i += 1;
  }

  flush();
  return runs;
}

/**
 * Try to consume an inline tag or a link starting at `index`.
 *
 * Returns the runs it produced and where to resume, or `null` when nothing
 * starts here -- which is what makes an unrecognised `<` or `[` fall through to
 * literal text in the caller.
 */
function tryDelimiter(
  source: string,
  index: number,
  links: string[],
  style: Style,
): { runs: InlineRun[]; next: number } | null {
  const ch = source[index];

  if (ch === "<") {
    for (const [flag, tag] of STYLE_TAGS) {
      const open = `<${tag}>`;
      if (!source.startsWith(open, index)) continue;
      const close = findClosing(source, index + open.length, `</${tag}>`);
      if (close === -1) continue;
      return {
        runs: parseInline(source.slice(index + open.length, close), links, {
          ...style,
          [flag]: true,
        }),
        next: close + tag.length + 3,
      };
    }
    return null;
  }

  if (ch === "[") {
    const close = matchingBracket(source, index);
    if (close !== -1) {
      const target = /^\(L(\d+)\)/.exec(source.slice(close + 1));
      const href = target ? links[Number(target[1])] : undefined;
      if (target && href !== undefined) {
        return {
          runs: parseInline(source.slice(index + 1, close), links, { ...style, link: href }),
          next: close + 1 + target[0].length,
        };
      }
    }
    return null;
  }

  return null;
}

/** Index of the `]` matching the `[` at `open`, honouring escapes and nesting. */
function matchingBracket(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "\\") {
      i += 1;
      continue;
    }
    if (source[i] === "[") depth += 1;
    else if (source[i] === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the next unescaped `delim` at or after `from`. */
function findClosing(source: string, from: number, delim: string): number {
  for (let i = from; i < source.length; i++) {
    if (source[i] === "\\") {
      i += 1;
      continue;
    }
    if (source.startsWith(delim, i)) return i;
  }
  return -1;
}

interface ParseState {
  opaque: Block[];
  links: string[];
  /**
   * Placeholder indices the returned document referenced, and how many times
   * each appeared as its own line. A `Set` here used to mean a model that
   * emitted `[[M0]]` twice stored the block twice while the *other* image went
   * unreferenced and unreported -- `pinLeadMedia()` in `./run` only
   * deduplicates the lead block, so every other placeholder was exposed to
   * this. A count is what lets `textToBlocks()` keep the first occurrence only
   * and report the rest as `duplicatedOpaque`, rather than trusting a boolean
   * that could not tell "seen" from "seen again."
   */
  seen: Map<number, number>;
  /**
   * Indices whose block carried a non-empty caption in the input and came
   * back with an empty one -- the model reproduced `[[M0]]` on its own line
   * but omitted the trailing caption text. `parseLines()` reads that silently
   * as "no caption" (a placeholder's caption is genuinely optional coming out
   * of `blocksToText()`, e.g. an image that never had one), so the only way to
   * tell "never had a caption" from "had one and lost it" is to compare
   * against the input here, at the point the loss can still be seen.
   */
  clearedCaptions: Set<number>;
}

const OPAQUE_LINE = /^\[\[M(\d+)\]\](?:\s+(.*))?$/;
const HEADING_LINE = /^(#{1,6})\s+(.*)$/;
const UNORDERED_ITEM = /^[-*+]\s+(.*)$/;
const ORDERED_ITEM = /^\d+\.\s+(.*)$/;

/**
 * Parse the notation back into blocks.
 *
 * Line-oriented, so restructuring by the model is free: it may merge, split,
 * reorder or drop blocks, and whatever it returns is read on its own terms
 * rather than checked against the shape that went out.
 */
function parseLines(lines: string[], state: ParseState): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const opaqueMatch = OPAQUE_LINE.exec(line.trim());
    if (opaqueMatch) {
      const index = Number(opaqueMatch[1]);
      const block = state.opaque[index];
      if (block) {
        const priorCount = state.seen.get(index) ?? 0;
        state.seen.set(index, priorCount + 1);
        // Only the first occurrence is ever stored. A repeat is the model
        // reproducing the same placeholder more than once -- reported via
        // `duplicatedOpaque` below rather than pushed again, or the block
        // would be stored twice while whatever the model dropped *instead*
        // stayed the only visible loss.
        if (priorCount === 0) {
          if (block.kind === "image") {
            // The caption is prose and may have been rewritten; the ref is not
            // and comes from the table.
            const caption = opaqueMatch[2] ? parseInline(opaqueMatch[2], state.links) : [];
            if (caption.length === 0 && block.caption.length > 0) {
              // Had a caption on the way out, none on the way back -- distinct
              // from an image that never had one, which this same branch
              // handles identically otherwise. Reported, not silently applied,
              // for the same reason a dropped placeholder is: losing prose
              // nobody asked to lose looks exactly like prose that was never
              // there.
              state.clearedCaptions.add(index);
            }
            blocks.push({ ...block, caption });
          } else {
            blocks.push(block);
          }
        }
      }
      // An index with no entry is dropped: the model invented a placeholder.
      i += 1;
      continue;
    }

    const heading = HEADING_LINE.exec(line.trim());
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        runs: parseInline(heading[2], state.links),
      });
      i += 1;
      continue;
    }

    if (line.trimStart().startsWith("> ") || line.trim() === ">") {
      const inner: string[] = [];
      // **A truly empty line ends the quote; a bare `>` is a paragraph break
      // inside it.** That is the whole distinction between "one quote of two
      // paragraphs" and "two adjacent quotes", and it is why this does not look
      // ahead past a blank line: doing so merged every run of quotes into one.
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        inner.push(lines[i].trimStart().replace(/^>\s?/, ""));
        i += 1;
      }
      const quoted = parseLines(inner, state);
      if (quoted.length > 0) blocks.push({ kind: "blockquote", blocks: quoted });
      continue;
    }

    const ordered = ORDERED_ITEM.test(line.trim());
    if (ordered || UNORDERED_ITEM.test(line.trim())) {
      const items: Block[][] = [];
      while (i < lines.length) {
        const current = lines[i];
        const trimmed = current.trim();
        const match = ordered ? ORDERED_ITEM.exec(trimmed) : UNORDERED_ITEM.exec(trimmed);
        if (match) {
          // Gather this item's continuation lines: indented, no marker of
          // their own at this level.
          const body = [match[1]];
          i += 1;
          const indented = (line: string | undefined) => /^\s{2,}\S/.test(line ?? "");
          while (i < lines.length) {
            if (indented(lines[i])) {
              // `slice(2)`, not `trim()`. Trimming discarded the indentation
              // that *is* the nesting, so a three-level list came back two
              // levels deep: `    - c` became `- c` and was read as a sibling
              // of `- b` instead of its child. Removing exactly one level hands
              // the remainder to the recursive parse with its own depth intact.
              body.push(lines[i].slice(2));
              i += 1;
              continue;
            }
            // A blank line belongs to this item only while the item continues
            // after it -- which is the one place a lookahead is right, because
            // a blank followed by an indented line and a blank ending the list
            // are otherwise the same character.
            if (lines[i].trim() === "" && indented(lines[i + 1])) {
              body.push("");
              i += 1;
              continue;
            }
            break;
          }
          items.push(parseLines(body, state));
          continue;
        }
        break;
      }
      if (items.length > 0) blocks.push({ kind: "list", ordered, items } satisfies ListBlock);
      continue;
    }

    blocks.push({ kind: "paragraph", runs: parseInline(line.trim(), state.links) });
    i += 1;
  }

  return blocks;
}

/** What `textToBlocks` produces, plus what the document failed to carry back. */
export interface TextToBlocksResult {
  blocks: Block[];
  /**
   * Placeholder indices that were sent but did not come back -- an image,
   * embed, code block or divider the model dropped. Reported rather than
   * ignored: silently losing an article's lead image looks exactly like an
   * article that never had one.
   */
  droppedOpaque: number[];
  /**
   * Placeholder indices that came back more than once as their own line. Only
   * the first occurrence is kept in `blocks` (see `parseLines()`); this is
   * what tells a caller the model duplicated a media/code block rather than
   * moved it.
   */
  duplicatedOpaque: number[];
  /**
   * Indices of image placeholders whose caption was non-empty in the input
   * and came back empty. The image itself is kept -- only the caption text
   * was lost.
   */
  clearedCaptions: number[];
}

export function textToBlocks(
  text: string,
  document: Pick<BlockDocument, "opaque" | "links">,
): TextToBlocksResult {
  const state: ParseState = {
    opaque: document.opaque,
    links: document.links,
    seen: new Map(),
    clearedCaptions: new Set(),
  };
  const blocks = parseLines(text.replace(/\r\n?/g, "\n").split("\n"), state);
  const droppedOpaque = document.opaque
    .map((_, index) => index)
    .filter((index) => !state.seen.has(index));
  const duplicatedOpaque = [...state.seen.entries()]
    .filter(([, occurrences]) => occurrences > 1)
    .map(([index]) => index)
    .sort((a, b) => a - b);
  return {
    blocks,
    droppedOpaque,
    duplicatedOpaque,
    clearedCaptions: [...state.clearedCaptions].sort((a, b) => a - b),
  };
}
