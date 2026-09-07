/**
 * Reddit markdown conversion utilities.
 *
 * Ported from old/core/aggregators/reddit/markdown.py.
 */

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { isSafeUrl } from "../../blocks/parser";
import { sanitizeUntrustedFragment } from "../../extract/clean";
import { escapeHtml } from "../../extract/format";
import { decodeHtmlEntitiesInUrl } from "./urls";

export { escapeHtml };

export function safeLinkHtml(url: string | null | undefined, text: string): string {
  const escapedText = escapeHtml(text);
  if (!url) return escapedText;
  if (!isSafeUrl(url)) return escapedText;
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapedText}</a>`;
}

export function safeImgHtml(url: string | null | undefined, alt: string): string {
  if (!url) return "";
  if (!isSafeUrl(url)) return "";
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}">`;
}

/**
 * Reddit's editor escapes markdown punctuation on its way into the API, so a
 * comment whose author typed a literal "- item" arrives as "\- item", and one
 * mentioning C++ as "C\+\+". Any of CommonMark's escapable characters can turn
 * up this way and none of them was being unescaped: the backslash printed
 * verbatim, and the character behind it was still read as syntax on top of
 * that -- "\^caret" rendered a literal backslash followed by a superscript.
 *
 * The escape is resolved in two halves, because it has to survive the whole
 * pipeline. protectBackslashEscapes() runs before anything reads the text as
 * syntax and replaces `\x` with a single Private Use Area character carrying
 * x's own code point; restoreBackslashEscapes() turns that back into x,
 * HTML-escaped, once the markup is built. In between, nothing -- the inline
 * emphasis regexes, the list and quote detection, cheerio's parse and
 * re-serialization -- can read the escaped character as syntax or split the
 * marker in half.
 */
const ESCAPE_PLACEHOLDER_BASE = 0xe000;

/** U+E021..U+E07E: one placeholder per escapable ASCII punctuation character. */
const ESCAPE_PLACEHOLDER_PATTERN = /[\uE021-\uE07E]/g;

/**
 * Reddit's JSON `body` is HTML-escaped markdown, so an escaped `<` arrives as
 * `\&lt;` rather than `\<`. The entity forms have to be recognised here, or
 * the backslash reads as escaping the ampersand and the entity's own name
 * prints as text.
 */
const ESCAPED_ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&#39;": "'",
};

/**
 * A backslash followed by one escapable character: CommonMark's set is every
 * ASCII punctuation character, and nothing else -- `\d` keeps its backslash.
 * The entity alternatives come first so `\&lt;` is not read as `\&` plus the
 * text `lt;`.
 */
const BACKSLASH_ESCAPE = /\\(&lt;|&gt;|&amp;|&quot;|&#39;|[!"#$%&'()*+,./:;<=>?@[\]^_`{|}~\\-])/g;

/**
 * A fenced block or a code span. Backslash escapes are not processed inside
 * either one (CommonMark, and Reddit's own renderer), so a code span holding
 * `\d+` or `\.` keeps every backslash it was given. An unclosed fence ends at
 * the blank line that ends its block, which is where markdownToHtml() ends it
 * too.
 */
const CODE_RUN = /(```[\s\S]*?```|```(?:[^\n]|\n(?!\n))*|`[^`\n]+`)/;

function protectEscapesOutsideCode(text: string): string {
  return (
    text
      .replace(BACKSLASH_ESCAPE, (_, escaped: string) => {
        const char = ESCAPED_ENTITIES[escaped] ?? escaped;
        return String.fromCharCode(ESCAPE_PLACEHOLDER_BASE + char.charCodeAt(0));
      })
      // A trailing backslash is CommonMark's hard line break. Every line inside
      // a block is already joined with <br>, so the marker has nothing left to
      // do but disappear -- left in place it prints.
      .replace(/\\(?=\n)/g, "")
  );
}

function protectBackslashEscapes(md: string): string {
  if (!md.includes("\\")) return md;
  return md
    .split(CODE_RUN)
    .map((part, index) => (index % 2 === 1 ? part : protectEscapesOutsideCode(part)))
    .join("");
}

function restoreBackslashEscapes(html: string): string {
  return html.replace(ESCAPE_PLACEHOLDER_PATTERN, (placeholder) =>
    escapeHtml(String.fromCharCode(placeholder.charCodeAt(0) - ESCAPE_PLACEHOLDER_BASE)),
  );
}

function parseInlineMarkdown(text: string): string {
  if (!text) return "";
  let s = text;
  s = s.replace(/`([^`\n]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?:^|[\s(])__([^_\n]+)__(?=$|[\s.,!?;:)]|\*)/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  s = s.replace(/(?:^|[\s(])_([^\s_\n](?:[^_\n]*[^\s_\n])?)_(?=$|[\s.,!?;:)]|\*)/g, "<em>$1</em>");
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  s = s.replace(/\^\(([^)\n]+)\)/g, "<sup>$1</sup>");
  s = s.replace(/\^(\w+)/g, "<sup>$1</sup>");
  s = s.replace(
    />!([^!\n]+)!</g,
    '<span class="spoiler" style="background: #000; color: #000;">$1</span>',
  );
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

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
    .map(
      (cells) =>
        `<tr>${cells.map((cell) => `<td>${parseInlineMarkdown(cell)}</td>`).join("")}</tr>`,
    )
    .join("");

  return `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

/**
 * A line that opens or continues a block quote. `>!` is Reddit's spoiler
 * marker, not a quote, and the space after the marker is optional — plenty of
 * commenters type `>quoted` and every Reddit renderer treats that as a quote.
 */
function isQuoteLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith(">") && !trimmed.startsWith(">!");
}

/** Removes exactly one level of quote marker, so `>>inner` becomes `>inner`. */
function stripQuoteMarker(line: string): string {
  return line.replace(/^\s*>\s?/, "");
}

/**
 * Quotes nest by recursion, so a hand-crafted `>>>>>…` would otherwise recurse
 * once per marker. Past this depth the markers are left as text.
 */
const MAX_QUOTE_DEPTH = 8;

export function markdownToHtml(md: string, depth = 0): string {
  if (!md) return "";

  // Only at the top: a recursive call is handed text that is already protected,
  // and its result is restored by the outermost frame.
  const source = depth === 0 ? protectBackslashEscapes(md) : md;

  const rawBlocks = source.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const intermediateBlocks: Array<{
    type: "p" | "quote" | "ul" | "ol" | "h" | "code";
    html: string;
    items?: string[];
  }> = [];

  for (const block of rawBlocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("```")) {
      const lines = trimmed.split("\n");
      const firstLine = lines[0]!.trim();
      const lastLine = lines[lines.length - 1]!.trim();
      const codeLanguage = firstLine.slice(3).trim();
      const codeLines = lastLine.endsWith("```") ? lines.slice(1, -1) : lines.slice(1);
      const codeText = escapeHtml(codeLines.join("\n"));
      const langAttr = codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : "";
      intermediateBlocks.push({
        type: "code",
        html: `<pre><code${langAttr}>${codeText}\n</code></pre>`,
      });
      continue;
    }

    const blockLines = trimmed.split("\n");
    if (isTableBlock(blockLines)) {
      intermediateBlocks.push({ type: "p", html: tableBlockHtml(blockLines) });
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+([\s\S]*)$/);
    if (headingMatch && !headingMatch[2]!.includes("\n")) {
      const level = headingMatch[1]!.length;
      const title = parseInlineMarkdown(headingMatch[2]!.trim());
      intermediateBlocks.push({
        type: "h",
        html: `<h${level}>${title}</h${level}>`,
      });
      continue;
    }

    const quoteStart = blockLines.findIndex(isQuoteLine);
    if (quoteStart !== -1 && depth < MAX_QUOTE_DEPTH) {
      // A quote may open partway through a block ("Look at this:\n>quoted"),
      // and everything from there on belongs to it — a line without a marker
      // after one that has it is a lazy continuation, which is how both
      // CommonMark and Reddit read it.
      const lead = blockLines.slice(0, quoteStart);
      if (lead.length > 0) {
        intermediateBlocks.push({
          type: "p",
          html: lead.map((l) => parseInlineMarkdown(l)).join("<br>\n"),
        });
      }
      const quoted = blockLines.slice(quoteStart).map(stripQuoteMarker).join("\n");
      intermediateBlocks.push({
        type: "quote",
        html: `<blockquote>${markdownToHtml(quoted, depth + 1)}</blockquote>`,
      });
      continue;
    }

    if (blockLines.every((l) => /^[\*\-]\s+/.test(l.trim()))) {
      const items = blockLines.map((l) => parseInlineMarkdown(l.trim().replace(/^[\*\-]\s+/, "")));
      intermediateBlocks.push({
        type: "ul",
        html: "",
        items,
      });
      continue;
    }

    if (blockLines.every((l) => /^\d+\.\s+/.test(l.trim()))) {
      const items = blockLines.map((l) => parseInlineMarkdown(l.trim().replace(/^\d+\.\s+/, "")));
      intermediateBlocks.push({
        type: "ol",
        html: "",
        items,
      });
      continue;
    }

    const formattedLines = blockLines.map((l) => parseInlineMarkdown(l)).join("<br>\n");
    intermediateBlocks.push({
      type: "p",
      html: formattedLines,
    });
  }

  const mergedBlocks: string[] = [];
  for (let i = 0; i < intermediateBlocks.length; i++) {
    const curr = intermediateBlocks[i]!;

    if (curr.type === "ul" || curr.type === "ol") {
      const tag = curr.type;
      const allItems: string[] = [...(curr.items || [])];

      while (i + 1 < intermediateBlocks.length && intermediateBlocks[i + 1]!.type === tag) {
        i++;
        allItems.push(...(intermediateBlocks[i]!.items || []));
      }

      const itemsHtml = allItems.map((item) => `<li>${item}</li>`).join("");
      mergedBlocks.push(`<${tag}>${itemsHtml}</${tag}>`);
    } else if (curr.type === "p") {
      const text = curr.html;
      if (/^\s*<(?:img|figure|p|div|blockquote|pre|table|ul|ol|h[1-6])[\s>]/i.test(text)) {
        mergedBlocks.push(text);
      } else {
        mergedBlocks.push(`<p>${text}</p>`);
      }
    } else {
      mergedBlocks.push(curr.html);
    }
  }

  const html = mergedBlocks.join("\n");
  return depth === 0 ? restoreBackslashEscapes(html) : html;
}

export function linkifyHtml(htmlContent: string): string {
  if (!htmlContent) return "";

  try {
    const $ = cheerio.load(htmlContent);
    const urlPattern = /(https?:\/\/[^\s<"]+)/g;

    const processTextNode = (node: AnyNode) => {
      const parent = node.parent;
      if (node.type === "text" && parent && (!("name" in parent) || parent.name !== "a")) {
        const text = node.data || "";
        if (urlPattern.test(text)) {
          urlPattern.lastIndex = 0;
          let match: RegExpExecArray | null;
          let lastIdx = 0;
          const newNodes: string[] = [];

          while ((match = urlPattern.exec(text)) !== null) {
            const fullUrl = match[0]!;
            const cleanUrl = fullUrl.replace(/[.,;:!?)]+$/, "");
            const start = match.index;

            if (start > lastIdx) {
              newNodes.push(escapeHtml(text.slice(lastIdx, start)));
            }

            newNodes.push(
              `<a href="${escapeHtml(cleanUrl)}" target="_blank" rel="noopener">${escapeHtml(
                cleanUrl,
              )}</a>`,
            );

            const trailing = fullUrl.slice(cleanUrl.length);
            if (trailing) {
              newNodes.push(escapeHtml(trailing));
            }

            lastIdx = start + fullUrl.length;
          }

          if (lastIdx < text.length) {
            newNodes.push(escapeHtml(text.slice(lastIdx)));
          }

          $(node).replaceWith(newNodes.join(""));
        }
      }
    };

    $("*")
      .contents()
      .each((_, node) => {
        processTextNode(node);
      });

    $("a").each((_, a) => {
      $(a).attr("target", "_blank");
      $(a).attr("rel", "noopener");
    });

    const body = $("body");
    return body.length > 0 ? body.html() || "" : $.html();
  } catch {
    return htmlContent;
  }
}

export function convertRedditMarkdown(text: string): string {
  if (!text) return "";

  const MAX_TEXT_LENGTH = 100000;
  let input = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;

  // Reddit's "invisible paragraph spacer" idiom. Left in place, it round-trips
  // through escapeHtml() inside a code span/block (below) as a double-escaped
  // entity that decodes only one level in the browser, printing the literal
  // text "&#x200B;" instead of vanishing. It adds no visual value either way,
  // so it's removed outright rather than decoded.
  input = input.replace(/&#x200[Bb];|\u200B/g, "");

  // A Private Use Area character in the source would be indistinguishable from
  // the placeholder protectBackslashEscapes() writes below, so it goes for the
  // same reason the spacer above does: it renders as nothing anyone typed on
  // purpose, and leaving it in would let a commenter forge an escape. Nothing
  // can be injected that way -- restoreBackslashEscapes() writes the character
  // back through escapeHtml() -- but the text would still read as something
  // its author never wrote.
  input = input.replace(ESCAPE_PLACEHOLDER_PATTERN, "");

  // Escapes are resolved before anything else reads the text as syntax. The
  // superscript, strikethrough and spoiler passes below run on raw markdown,
  // so `\^caret` has to be neutralised before they see it -- markdownToHtml()
  // protecting its own input would be far too late for those three.
  input = protectBackslashEscapes(input);

  // Reddit's JSON `body` is HTML-escaped markdown, so a quote typed as
  // `>text` arrives as `&gt;text` and never reaches markdownToHtml() as a
  // quote at all \u2014 it renders as a paragraph with a literal `>` in front of
  // it. Only the leading run of markers is decoded: `&lt;` and `&amp;` are
  // left alone, because cheerio decodes them correctly further down this
  // pipeline while turning them back into markup here would let a commenter
  // inject tags.
  input = input.replace(/^[ \t]*(?:&gt;[ \t]*)+/gm, (markers) => markers.replace(/&gt;/g, ">"));

  input = input.replace(
    /\[([^\]]{0,200})\]\((https?:\/\/preview\.redd\.it\/[^\s)]{1,500})\)/g,
    (_, caption, url) =>
      safeImgHtml(decodeHtmlEntitiesInUrl(url), caption || "Reddit preview image"),
  );

  input = input.replace(/(?<!\[\(])https?:\/\/preview\.redd\.it\/[^\s)]+/g, (match) =>
    safeImgHtml(decodeHtmlEntitiesInUrl(match), "Reddit preview image"),
  );

  input = input.replace(
    /!\[([^\]]*)\]\(giphy\|([a-z0-9]+)(?:\|[^)]+)?\)/gi,
    (_, __, id) => `<img src="https://media.giphy.com/media/${id}/giphy.gif" alt="Giphy GIF">`,
  );

  input = input.replace(
    /<img\s+[^>]{0,200}src\s*=\s*["']giphy\|([a-z0-9]{1,50})(?:\|[^"']{0,100})?["'][^>]{0,200}>/gi,
    (_, id) => `<img src="https://media.giphy.com/media/${id}/giphy.gif" alt="Giphy GIF">`,
  );

  input = input.replace(
    /(?<!["'])giphy\|([a-z0-9]+)(?!["'])/gi,
    (_, id) => `<img src="https://media.giphy.com/media/${id}/giphy.gif" alt="Giphy GIF">`,
  );

  input = input.replace(/\^(\w+)/g, "<sup>$1</sup>");
  input = input.replace(/\^\(([^)]+)\)/g, "<sup>$1</sup>");
  input = input.replace(/~~(.+?)~~/g, "<del>$1</del>");
  input = input.replace(
    />!(.+?)!</g,
    '<span class="spoiler" style="background: #000; color: #000;">$1</span>',
  );

  const htmlContent = markdownToHtml(input);
  const linked = linkifyHtml(htmlContent);
  return sanitizeUntrustedFragment(linked);
}
