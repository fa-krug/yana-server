import React from "react";

import type { BlockNode as BlockNodeType } from "@/lib/blocks/tree";
import type { ArticleInlineRun } from "@/lib/db/schema/articles";
import { youtubeIdFrom } from "@/lib/aggregators/embeds/youtube-url";

/**
 * `youtubeIdFrom` is the one YouTube id extractor for the whole codebase --
 * this is the only place that needs it client-side, which is exactly why it
 * lives in its own dependency-free module rather than in
 * `@/lib/aggregators/embeds/youtube.ts` (which imports the image store and
 * re-exports from `../website`, both server-only) or in
 * `@/lib/aggregators/blocks/parser.ts` (cheerio). See that module's doc
 * comment for the rest of the dependency contract, and its test for the
 * tripwire that pins it.
 */
const DAILYMOTION_VIDEO_ID_PATTERN = /dailymotion\.com\/(?:video|embed\/video)\/([A-Za-z0-9]+)/;

function youtubeEmbedSrc(externalUrl: string): string {
  const videoId = youtubeIdFrom(externalUrl);
  return videoId ? `https://www.youtube.com/embed/${videoId}` : "";
}

function dailymotionEmbedSrc(externalUrl: string): string {
  const match = DAILYMOTION_VIDEO_ID_PATTERN.exec(externalUrl);
  return match ? `https://www.dailymotion.com/embed/video/${match[1]}` : "";
}

export function renderInlineRun(run: ArticleInlineRun, index: number): React.ReactNode {
  let content: React.ReactNode = run.text;

  if (run.code) {
    content = <code className="rounded bg-muted px-1 py-0.5 font-mono text-sm">{content}</code>;
  }
  if (run.bold) {
    content = <strong>{content}</strong>;
  }
  if (run.italic) {
    content = <em>{content}</em>;
  }
  if (run.strikethrough) {
    content = <del>{content}</del>;
  }
  if (run.link) {
    content = (
      <a
        href={run.link}
        target="_blank"
        rel="noreferrer noopener"
        className="text-primary underline hover:text-primary/80"
      >
        {content}
      </a>
    );
  }

  return <React.Fragment key={index}>{content}</React.Fragment>;
}

export function BlockNode({ node }: { node: BlockNodeType }) {
  switch (node.kind) {
    case "paragraph":
      return (
        <p className="leading-relaxed">{node.runs?.map((run, idx) => renderInlineRun(run, idx))}</p>
      );

    case "heading": {
      const rawLevel = node.level ?? 1;
      const level = Math.min(6, Math.max(1, rawLevel));
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      return (
        <Tag className="font-bold tracking-tight">
          {node.runs?.map((run, idx) => renderInlineRun(run, idx))}
        </Tag>
      );
    }

    case "list": {
      const Tag = node.ordered ? "ol" : "ul";
      const listClass = node.ordered
        ? "list-decimal list-inside space-y-1"
        : "list-disc list-inside space-y-1";
      return (
        <Tag className={listClass}>
          {node.children?.map((child) => (
            <BlockNode key={child.id} node={child} />
          ))}
        </Tag>
      );
    }

    case "list_item":
      return (
        <li>
          {node.children?.map((child) => (
            <BlockNode key={child.id} node={child} />
          ))}
        </li>
      );

    case "blockquote":
      return (
        <blockquote className="border-l-4 border-muted pl-4 italic space-y-2">
          {node.children?.map((child) => (
            <BlockNode key={child.id} node={child} />
          ))}
        </blockquote>
      );

    // The AI summary (`applyAiToBlocks()` in @/lib/ai/run): a kind of its own so
    // it can be told from body prose without counting positions.
    case "summary":
      return (
        <section
          data-slot="yana-ai-summary"
          className="rounded-md border border-muted bg-muted/40 p-4 space-y-2 text-sm"
        >
          {node.children?.map((child) => (
            <BlockNode key={child.id} node={child} />
          ))}
        </section>
      );

    case "image": {
      const imageRef = node.imageRef ?? "";
      const src = imageRef.startsWith("yana-img://")
        ? imageRef.replace("yana-img://", "/media/images/")
        : imageRef;

      const hasCaption = node.runs && node.runs.length > 0;

      if (hasCaption) {
        return (
          <figure className="my-4">
            <img src={src} alt="" className="max-w-full h-auto rounded-md" />
            <figcaption className="mt-1 text-sm text-muted-foreground">
              {node.runs.map((run, idx) => renderInlineRun(run, idx))}
            </figcaption>
          </figure>
        );
      }

      return <img src={src} alt="" className="max-w-full h-auto rounded-md my-4" />;
    }

    case "embed": {
      const provider = node.embedProvider ?? "";
      const externalUrl = node.embedExternalUrl ?? "";
      const embedSrc =
        provider === "youtube"
          ? youtubeEmbedSrc(externalUrl)
          : provider === "dailymotion"
            ? dailymotionEmbedSrc(externalUrl)
            : "";

      if (embedSrc) {
        return (
          <div className="my-4 aspect-video overflow-hidden rounded-lg border bg-card">
            <iframe
              src={embedSrc}
              title={node.embedTitle || provider}
              className="h-full w-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          </div>
        );
      }

      const thumbnailRef = node.embedThumbnailRef ?? "";
      const thumbnailSrc = thumbnailRef.startsWith("yana-img://")
        ? thumbnailRef.replace("yana-img://", "/media/images/")
        : thumbnailRef;

      return (
        <div className="my-4 overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm">
          <a
            href={node.embedExternalUrl || "#"}
            target="_blank"
            rel="noreferrer noopener"
            className="flex flex-col sm:flex-row hover:opacity-90 transition-opacity"
          >
            {thumbnailSrc && (
              <div className="sm:w-48 shrink-0">
                <img src={thumbnailSrc} alt="" className="w-full h-full object-cover" />
              </div>
            )}
            <div className="p-4 flex flex-col justify-between space-y-2">
              <div>
                {node.embedProvider && (
                  <span className="inline-block rounded bg-secondary px-2 py-0.5 text-xs font-semibold text-secondary-foreground mb-2">
                    {node.embedProvider}
                  </span>
                )}
                {node.embedTitle && (
                  <h4 className="font-semibold leading-snug">{node.embedTitle}</h4>
                )}
              </div>
            </div>
          </a>
        </div>
      );
    }

    case "code_block":
      return (
        <pre className="my-4 overflow-x-auto rounded-md bg-muted p-4 font-mono text-sm">
          <code className={node.language ? `language-${node.language}` : undefined}>
            {node.text}
          </code>
        </pre>
      );

    case "divider":
      return <hr className="my-4 border-border" />;

    default:
      return null;
  }
}
