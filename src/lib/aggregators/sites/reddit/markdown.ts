/**
 * Reddit markdown conversion utilities.
 *
 * Ported from old/core/aggregators/reddit/markdown.py.
 */

import * as cheerio from "cheerio";
import { isSafeUrl } from "../../blocks/parser";
import { cleanHtml, removeSanitizedAttributes, sanitizeHtmlAttributes } from "../../extract/clean";
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
  s = s.replace(/>!([^!\n]+)!</g, '<span class="spoiler" style="background: #000; color: #000;">$1</span>');
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  return s;
}

export function markdownToHtml(md: string): string {
  if (!md) return "";

  const rawBlocks = md.replace(/\r\n/g, "\n").split(/\n{2,}/);
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

    if (trimmed.startsWith(">") && !trimmed.startsWith(">!")) {
      const quoteLines = trimmed
        .split("\n")
        .map((l) => l.replace(/^>\s?/, ""))
        .join("<br>\n");
      intermediateBlocks.push({
        type: "quote",
        html: `blockquote:<p>${quoteLines}</p>`,
      });
      continue;
    }

    const lines = trimmed.split("\n");
    if (lines.every((l) => /^[\*\-]\s+/.test(l.trim()))) {
      const items = lines.map((l) => parseInlineMarkdown(l.trim().replace(/^[\*\-]\s+/, "")));
      intermediateBlocks.push({
        type: "ul",
        html: "",
        items,
      });
      continue;
    }

    if (lines.every((l) => /^\d+\.\s+/.test(l.trim()))) {
      const items = lines.map((l) => parseInlineMarkdown(l.trim().replace(/^\d+\.\s+/, "")));
      intermediateBlocks.push({
        type: "ol",
        html: "",
        items,
      });
      continue;
    }

    const formattedLines = lines.map((l) => parseInlineMarkdown(l)).join("<br>\n");
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
    } else if (curr.type === "quote") {
      const text = curr.html.slice(11);
      mergedBlocks.push(`blockquote:<p>${text}</p>`);
    } else {
      mergedBlocks.push(curr.html);
    }
  }

  return mergedBlocks
    .map((b) => {
      if (b.startsWith("blockquote:")) {
        const text = b.slice(11);
        return `blockquote:${text}`;
      }
      return b;
    })
    .map((b) => {
      if (b.startsWith("blockquote:")) {
        const inner = b.slice(11);
        return `<blockquote>${inner}</blockquote>`;
      }
      return b;
    })
    .join("\n");
}

export function linkifyHtml(htmlContent: string): string {
  if (!htmlContent) return "";

  try {
    const $ = cheerio.load(htmlContent);
    const urlPattern = /(https?:\/\/[^\s<"]+)/g;

    const processTextNode = (node: any) => {
      if (node.type === "text" && node.parent && node.parent.name !== "a") {
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

export function sanitizeMarkdownHtml(contentHtml: string): string {
  const $ = cheerio.load(cleanHtml(contentHtml));
  sanitizeHtmlAttributes($);
  removeSanitizedAttributes($);

  $("a").each((_, tag) => {
    const href = $(tag).attr("href");
    if (href && !isSafeUrl(href)) {
      $(tag).removeAttr("href");
    }
  });

  $("img").each((_, tag) => {
    const src = $(tag).attr("src");
    if (src && !isSafeUrl(src)) {
      $(tag).remove();
    }
  });

  const body = $("body");
  return body.length > 0 ? body.html() || "" : $.html();
}

export function convertRedditMarkdown(text: string): string {
  if (!text) return "";

  const MAX_TEXT_LENGTH = 100000;
  let input = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;

  input = input.replace(
    /\[([^\]]{0,200})\]\((https?:\/\/preview\.redd\.it\/[^\s)]{1,500})\)/g,
    (_, caption, url) =>
      safeImgHtml(decodeHtmlEntitiesInUrl(url), caption || "Reddit preview image"),
  );

  input = input.replace(
    /(?<!\[\(])https?:\/\/preview\.redd\.it\/[^\s)]+/g,
    (match) => safeImgHtml(decodeHtmlEntitiesInUrl(match), "Reddit preview image"),
  );

  input = input.replace(
    /!\[([^\]]*)\]\(giphy\|([a-z0-9]+)(?:\|[^)]+)?\)/gi,
    (_, __, id) => `<img src="https://i.giphy.com/${id}.gif" alt="Giphy GIF">`,
  );

  input = input.replace(
    /<img\s+[^>]{0,200}src\s*=\s*["']giphy\|([a-z0-9]{1,50})(?:\|[^"']{0,100})?["'][^>]{0,200}>/gi,
    (_, id) => `<img src="https://i.giphy.com/${id}.gif" alt="Giphy GIF">`,
  );

  input = input.replace(
    /(?<!["'])giphy\|([a-z0-9]+)(?!["'])/gi,
    (_, id) => `<img src="https://i.giphy.com/${id}.gif" alt="Giphy GIF">`,
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
  return sanitizeMarkdownHtml(linked);
}
