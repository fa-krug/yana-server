import { z } from "zod";
import type { AggregatorKey } from "@/lib/db/schema/enums";
import type { FeedLike } from "./base";
import { BaseAggregator } from "./base";
import { RssAggregator } from "./rss";
import { DarkLegacyAggregator } from "./sites/dark_legacy";
import { OglafAggregator } from "./sites/oglaf";
import { FullWebsiteAggregator } from "./website";

export type AggregatorClass = (new (feed: any) => BaseAggregator) & {
  identifierField?: string;
  getIdentifierFromRelated?: (relatedObj: unknown) => string;
  getDefaultIdentifier?: () => string;
  selectorsToRemove?: string[];
  contentSelectors?: string[];
};

export const IMPLEMENTED_AGGREGATORS: Record<string, AggregatorClass | undefined> = {
  feed_content: RssAggregator as unknown as AggregatorClass,
  rss: RssAggregator as unknown as AggregatorClass,
  full_website: FullWebsiteAggregator as unknown as AggregatorClass,
  oglaf: OglafAggregator as unknown as AggregatorClass,
  dark_legacy: DarkLegacyAggregator as unknown as AggregatorClass,
};

export class AggregatorRegistry {
  static get(aggregatorType: string): AggregatorClass {
    const cls = IMPLEMENTED_AGGREGATORS[aggregatorType as AggregatorKey];
    if (!cls) {
      throw new Error(`Unknown aggregator type: ${aggregatorType}`);
    }
    return cls;
  }

  static getAll(): Partial<Record<AggregatorKey, AggregatorClass>> {
    return { ...IMPLEMENTED_AGGREGATORS };
  }
}

export function getAggregator(feed: FeedLike): BaseAggregator {
  const aggregatorType = feed.aggregator || "full_website";
  const AggregatorClass = AggregatorRegistry.get(aggregatorType);
  return new AggregatorClass(feed);
}

export type OptionSpec = {
  key: string;
  label: string;
  kind: "boolean" | "number" | "text" | "select" | "selectorList";
  default: unknown;
  help?: string;
  options?: { value: string; label: string }[];
  requires?: "youtube" | "reddit" | "ai";
};

export type AggregatorSpec = {
  key: AggregatorKey;
  label: string;
  identifierRequired: boolean;
  identifierLabel: string;
  identifierHelp: string;
  options: OptionSpec[];
};

export type Capabilities = { youtube: boolean; reddit: boolean; ai: boolean };

const AI_OPTIONS: OptionSpec[] = [
  {
    key: "ai_summarize",
    label: "Summarize Content",
    kind: "boolean",
    default: false,
    requires: "ai",
  },
  {
    key: "ai_improve_writing",
    label: "Improve Writing",
    kind: "boolean",
    default: false,
    requires: "ai",
  },
  {
    key: "ai_translate",
    label: "Translate Content",
    kind: "boolean",
    default: false,
    requires: "ai",
  },
  {
    key: "ai_translate_language",
    label: "Target Language",
    kind: "text",
    default: "English",
    requires: "ai",
  },
];

const WEBSITE_OPTIONS: OptionSpec[] = [
  ...AI_OPTIONS,
  {
    key: "content_selectors",
    label: "Content Selectors",
    kind: "selectorList",
    default: "",
    help: "CSS selectors for the content, one per line",
  },
  {
    key: "ignore_selectors",
    label: "Selectors to Remove",
    kind: "selectorList",
    default: "",
    help: "CSS selectors to remove, one per line",
  },
];

export const AGGREGATOR_SPECS: Record<AggregatorKey, AggregatorSpec> = {
  full_website: {
    key: "full_website",
    label: "Full Website",
    identifierRequired: false,
    identifierLabel: "URL",
    identifierHelp: "Website URL",
    options: WEBSITE_OPTIONS,
  },
  feed_content: {
    key: "feed_content",
    label: "Feed Content",
    identifierRequired: false,
    identifierLabel: "URL",
    identifierHelp: "RSS Feed URL",
    options: AI_OPTIONS,
  },
  heise: {
    key: "heise",
    label: "Heise",
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Heise feed",
    options: [
      ...WEBSITE_OPTIONS,
      { key: "include_comments", label: "Include Comments", kind: "boolean", default: true },
      { key: "max_comments", label: "Max Comments", kind: "number", default: 5 },
    ],
  },
  merkur: {
    key: "merkur",
    label: "Merkur",
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Merkur feed",
    options: [
      ...WEBSITE_OPTIONS,
      {
        key: "remove_empty_elements",
        label: "Remove Empty Elements",
        kind: "boolean",
        default: true,
      },
    ],
  },
  tagesschau: {
    key: "tagesschau",
    label: "Tagesschau",
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Tagesschau feed",
    options: [
      ...WEBSITE_OPTIONS,
      { key: "skip_livestreams", label: "Skip Livestreams", kind: "boolean", default: true },
      { key: "skip_videos", label: "Skip Videos", kind: "boolean", default: true },
    ],
  },
  explosm: {
    key: "explosm",
    label: "Explosm",
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Explosm feed",
    options: [
      ...WEBSITE_OPTIONS,
      { key: "show_alt_text", label: "Show Alt Text", kind: "boolean", default: true },
    ],
  },
  dark_legacy: {
    key: "dark_legacy",
    label: "Dark Legacy Comics",
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Dark Legacy feed",
    options: [
      ...WEBSITE_OPTIONS,
      { key: "show_alt_text", label: "Show Alt Text", kind: "boolean", default: true },
    ],
  },
  caschys_blog: {
    key: "caschys_blog",
    label: "Caschys Blog",
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Caschys Blog feed",
    options: [
      ...WEBSITE_OPTIONS,
      { key: "skip_ads", label: "Skip Ads", kind: "boolean", default: true },
    ],
  },
  mactechnews: {
    key: "mactechnews",
    label: "MacTechNews",
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select MacTechNews feed",
    options: [
      ...WEBSITE_OPTIONS,
      { key: "combine_pages", label: "Combine Pages", kind: "boolean", default: true },
      { key: "include_comments", label: "Include Comments", kind: "boolean", default: true },
      { key: "max_comments", label: "Max Comments", kind: "number", default: 5 },
    ],
  },
  oglaf: {
    key: "oglaf",
    label: "Oglaf",
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Oglaf feed",
    options: [
      ...WEBSITE_OPTIONS,
      { key: "show_alt_text", label: "Show Alt Text", kind: "boolean", default: true },
    ],
  },
  mein_mmo: {
    key: "mein_mmo",
    label: "Mein MMO",
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Mein MMO feed",
    options: [
      ...WEBSITE_OPTIONS,
      { key: "combine_pages", label: "Combine Pages", kind: "boolean", default: true },
      { key: "include_comments", label: "Include Comments", kind: "boolean", default: true },
      { key: "max_comments", label: "Max Comments", kind: "number", default: 5 },
    ],
  },
  the_verge: {
    key: "the_verge",
    label: "The Verge",
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select The Verge feed",
    options: WEBSITE_OPTIONS,
  },
  ars_technica: {
    key: "ars_technica",
    label: "Ars Technica",
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Ars Technica feed",
    options: WEBSITE_OPTIONS,
  },
  youtube: {
    key: "youtube",
    label: "YouTube",
    identifierRequired: true,
    identifierLabel: "Channel",
    identifierHelp: "YouTube Channel ID or URL",
    options: [
      ...AI_OPTIONS,
      { key: "comment_limit", label: "Comment Limit", kind: "number", default: 10 },
    ],
  },
  reddit: {
    key: "reddit",
    label: "Reddit",
    identifierRequired: true,
    identifierLabel: "Subreddit",
    identifierHelp: "Subreddit name or URL",
    options: [
      ...AI_OPTIONS,
      {
        key: "subreddit_sort",
        label: "Sort Order",
        kind: "select",
        default: "hot",
        options: [
          { value: "hot", label: "Hot" },
          { value: "new", label: "New" },
          { value: "top", label: "Top" },
          { value: "rising", label: "Rising" },
        ],
      },
      { key: "min_comments", label: "Minimum Comments", kind: "number", default: 5 },
      { key: "min_age_hours", label: "Minimum Post Age (hours)", kind: "number", default: 48 },
      { key: "comment_limit", label: "Comment Limit", kind: "number", default: 10 },
      {
        key: "include_header_image",
        label: "Include Header Image",
        kind: "boolean",
        default: true,
      },
    ],
  },
  podcast: {
    key: "podcast",
    label: "Podcast",
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Podcast RSS Feed",
    options: [
      ...AI_OPTIONS,
      { key: "include_player", label: "Include Player", kind: "boolean", default: true },
      {
        key: "include_download_link",
        label: "Include Download Link",
        kind: "boolean",
        default: true,
      },
      { key: "artwork_size", label: "Artwork Size", kind: "number", default: 300 },
    ],
  },
};

export function schemaFor(key: AggregatorKey): z.ZodType {
  const spec = AGGREGATOR_SPECS[key];
  if (!spec) return z.object({}).strip();

  const shape: Record<string, z.ZodType> = {};
  for (const option of spec.options) {
    let type: z.ZodType;
    switch (option.kind) {
      case "boolean":
        type = z.boolean();
        break;
      case "number":
        type = z.number();
        break;
      case "text":
        type = z.string();
        break;
      case "select":
        type = z.string();
        break;
      case "selectorList":
        type = z.string().transform((val) => {
          if (!val) return [];
          return val
            .split(/[\n,]+/)
            .map((s) => s.trim())
            .filter(Boolean);
        });
        break;
      default:
        type = z.unknown();
    }

    shape[option.key] = type.default(option.default);
  }

  return z.object(shape).strip();
}

export function visibleOptionsFor(key: AggregatorKey, capabilities: Capabilities): OptionSpec[] {
  const spec = AGGREGATOR_SPECS[key];
  if (!spec) return [];

  return spec.options.filter((option) => {
    if (option.requires && !capabilities[option.requires]) {
      return false;
    }
    return true;
  });
}

export function stripUnavailable(
  key: AggregatorKey,
  values: Record<string, unknown>,
  capabilities: Capabilities,
): Record<string, unknown> {
  const spec = AGGREGATOR_SPECS[key];
  if (!spec) return {};

  const allowedKeys = new Set(
    spec.options.filter((opt) => !opt.requires || capabilities[opt.requires]).map((opt) => opt.key),
  );

  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (allowedKeys.has(k)) {
      cleaned[k] = v;
    }
  }
  return cleaned;
}
