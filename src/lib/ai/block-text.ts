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
 * `textToBlocks(blocksToText(b))` is `b`. That property is what lets the
 * rewrite path trust a returned document it did not build.
 */

import type { Block, InlineRun, ListBlock } from "@/lib/aggregators/blocks/types";

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

/** A block kind whose content is never shown to the model. */
function isOpaque(block: Block): boolean {
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
  return line.replace(/^(\s*)(#{1,6} |[-*+] |> |\d+\. )/, "$1\\$2");
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
 * Idempotent, so it is a normal form rather than a transformation: the contract
 * pinned in `block-text.test.ts` is
 * `textToBlocks(blocksToText(b)) === canonicalBlocks(b)`.
 */
export function canonicalBlocks(blocks: Block[]): Block[] {
  return blocks.map((block) => {
    switch (block.kind) {
      case "paragraph":
      case "heading":
        return { ...block, runs: canonicalRuns(block.runs) };
      case "image":
        return { ...block, caption: canonicalRuns(block.caption) };
      case "blockquote":
      case "summary":
        return { ...block, blocks: canonicalBlocks(block.blocks) };
      case "list":
        return { ...block, items: block.items.map(canonicalBlocks) };
      default:
        return block;
    }
  });
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
  const collapsed = runs.map((run) =>
    run.code ? run : { ...run, text: run.text.replace(/\s+/g, " ") },
  );

  const merged = collapsed.reduce<InlineRun[]>((acc, run) => {
    const previous = acc[acc.length - 1];
    if (previous && sameStyle(previous, run)) {
      acc[acc.length - 1] = { ...previous, text: previous.text + run.text };
      return acc;
    }
    acc.push({ ...run });
    return acc;
  }, []);

  if (merged.length > 0) {
    const first = merged[0];
    if (!first.code) first.text = first.text.replace(/^ +/, "");
    const last = merged[merged.length - 1];
    if (!last.code) last.text = last.text.replace(/ +$/, "");
  }

  return merged.filter((run) => run.text !== "");
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

function serializeRun(run: InlineRun, links: string[]): string {
  // A code run's text is still escaped: it has to survive a `</code>` inside
  // it, and unescaping on the way back restores it exactly.
  let out = escapeText(run.text);

  for (const [flag, tag] of STYLE_TAGS) {
    if (run[flag]) out = `<${tag}>${out}</${tag}>`;
  }

  if (run.link) {
    let index = links.indexOf(run.link);
    if (index === -1) {
      index = links.length;
      links.push(run.link);
    }
    out = `[${out}](L${index})`;
  }

  return out;
}

function serializeRuns(runs: InlineRun[], links: string[]): string {
  // Canonicalized first: the notation cannot carry a newline inside a
  // paragraph, so a run holding one has to be collapsed before it is written,
  // not after it comes back wrong. See `canonicalBlocks()`.
  return canonicalRuns(runs)
    .map((run) => serializeRun(run, links))
    .join("");
}

function serializeBlocks(blocks: Block[], doc: BlockDocument, indent: string): string[] {
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
      // placeholder alone.
      const caption =
        block.kind === "image" && block.caption.length > 0
          ? " " + serializeRuns(block.caption, doc.links)
          : "";
      push(`[[M${index}]]${caption}`);
      continue;
    }

    switch (block.kind) {
      case "paragraph":
        push(escapeLineStart(serializeRuns(block.runs, doc.links)));
        break;

      case "heading":
        push(
          `${"#".repeat(Math.min(Math.max(block.level, 1), 6))} ${serializeRuns(block.runs, doc.links)}`,
        );
        break;

      case "list": {
        // One blank line before the list, none between its items: a list is a
        // single block, and blank-separated items would parse back as several.
        if (lines.length > 0) lines.push("");
        block.items.forEach((item, i) => {
          const marker = block.ordered ? `${i + 1}. ` : "- ";
          const inner = serializeBlocks(item, doc, "");
          const body = inner.filter((line) => line !== "");
          // The item's first block sits on the marker line; any further block
          // is a continuation line, indented so it rejoins this item rather
          // than becoming a paragraph after the list.
          lines.push(indent + marker + (body[0] ?? ""));
          for (const extra of body.slice(1)) {
            lines.push(indent + "  " + extra);
          }
        });
        break;
      }

      case "blockquote":
      case "summary": {
        // `summary` is serialized like a blockquote and comes back as a
        // blockquote, which is correct for the one direction that matters: a
        // summary only ever exists as *output* of a previous AI run, and the
        // input to this one is always freshly parsed from the source. Nothing
        // asks this module to preserve one.
        for (const line of serializeBlocks(block.blocks, doc, "")) {
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
  doc.text = serializeBlocks(blocks, doc, "").join("\n");
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
  /** Placeholder indices the returned document referenced. */
  seen: Set<number>;
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
        state.seen.add(index);
        if (block.kind === "image") {
          // The caption is prose and may have been rewritten; the ref is not
          // and comes from the table.
          const caption = opaqueMatch[2] ? parseInline(opaqueMatch[2], state.links) : [];
          blocks.push({ ...block, caption });
        } else {
          blocks.push(block);
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
      while (i < lines.length && (lines[i].trimStart().startsWith(">") || lines[i].trim() === "")) {
        if (lines[i].trim() === "") {
          // A blank line ends the quote unless the next line continues it.
          if (!lines[i + 1]?.trimStart().startsWith(">")) break;
          inner.push("");
          i += 1;
          continue;
        }
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
          while (i < lines.length && /^\s{2,}\S/.test(lines[i])) {
            body.push(lines[i].trim());
            i += 1;
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
}

export function textToBlocks(
  text: string,
  document: Pick<BlockDocument, "opaque" | "links">,
): TextToBlocksResult {
  const state: ParseState = {
    opaque: document.opaque,
    links: document.links,
    seen: new Set(),
  };
  const blocks = parseLines(text.replace(/\r\n?/g, "\n").split("\n"), state);
  const droppedOpaque = document.opaque
    .map((_, index) => index)
    .filter((index) => !state.seen.has(index));
  return { blocks, droppedOpaque };
}
