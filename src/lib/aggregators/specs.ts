/**
 * The client-safe half of the aggregator registry: the per-aggregator option
 * *descriptions* the feed form and list render, and the zod schema derived from
 * them. It imports nothing but `zod` and a type, for the reason
 * `src/lib/ai/providers.ts` imports nothing at all — `registry.ts` beside it
 * pulls in every aggregator class, and those reach `@/lib/db/client` and
 * therefore `better-sqlite3`. A component importing the specs from there is a
 * `Can't resolve 'fs'` build failure, so the two halves are separate modules
 * and `eslint.config.mjs` refuses the server one from `src/components/**`.
 */
import { z } from "zod";

import type { AggregatorKey } from "@/lib/db/schema/enums";

/**
 * The cap on `ai_custom_prompt_text`. It lives in `feeds.options` JSON and is
 * sent with *every* article this feed aggregates, so an unbounded blob is both
 * a fat row and a per-article token cost. Refused rather than truncated:
 * silently cutting an instruction in half changes what the model is asked to
 * do. The feed form sets the same number as the textarea's `maxLength`, so the
 * limit is unreachable from the UI and this check is for crafted requests.
 */
export const MAX_CUSTOM_PROMPT_LENGTH = 4000;

export type OptionSpec = {
  key: string;
  label: string;
  /**
   * `prompt` is `text`'s long-form sibling: the feed form renders it as a
   * read-only preview that opens a modal editor, rather than a single-line
   * input. Nothing else distinguishes the two — the stored value is a string
   * either way.
   */
  kind: "boolean" | "number" | "text" | "select" | "selectorList" | "prompt";
  default: unknown;
  help?: string;
  options?: { value: string; label: string }[];
  requires?: "youtube" | "reddit" | "ai";
  /**
   * The key of a boolean option in the same spec that switches this one on.
   * The feed form hides the field entirely while that box is unchecked — it is
   * a display rule only, so the stored value survives a toggle off and back on,
   * and neither `schemaFor()` nor `stripUnavailable()` reads it.
   */
  dependsOn?: string;
};

export type AggregatorSpec = {
  key: AggregatorKey;
  label: string;
  /**
   * Starting point for a new feed's `updateIntervalMinutes`/`concurrency`
   * columns (`src/lib/db/schema/feeds.ts`) -- pre-filled by the feed form on
   * create and on aggregator switch, freely editable afterward. Three tiers:
   * 30 min / concurrency 4 for frequently-updated article sources, 1440 min
   * (daily) / concurrency 4 for infrequent comics/podcasts, and 60 min /
   * concurrency 2 for sources known to be rate- or quota-sensitive --
   * `caschys_blog` earned its tier the hard way: its host started refusing
   * connections from this server's IP after repeated automated polling (see
   * docs/superpowers/specs/2026-08-06-per-feed-interval-and-concurrency-design.md).
   */
  recommendedIntervalMinutes: number;
  recommendedConcurrency: number;
  identifierRequired: boolean;
  identifierLabel: string;
  identifierHelp: string;
  /**
   * Fixed feed variants, ported verbatim from the aggregator's own
   * `getIdentifierChoices()` in `src/lib/aggregators/sites/*` — see the
   * cross-check test in `registry.test.ts` that keeps this hand-kept copy
   * honest. Empty for the two free-form-URL aggregators and the two
   * live-search aggregators.
   */
  identifierChoices: { value: string; label: string }[];
  /** Set only for the two aggregators with a live search-as-you-type identifier field. */
  identifierSearch?: "youtube" | "reddit";
  options: OptionSpec[];
};

export type Capabilities = { youtube: boolean; reddit: boolean; ai: boolean };

/**
 * The identifier field's shape, derived from data rather than declared
 * per-aggregator — so it can never drift from the choices actually listed.
 *
 * - `identifierSearch` set -> `"search"`.
 * - Otherwise, the number of `identifierChoices` decides it: zero is a
 *   free-form URL, exactly one is nothing to configure (there's only ever
 *   one possible value), two or more is a fixed dropdown.
 */
export type IdentifierMode = "none" | "url" | "choice" | "search";

export function identifierModeFor(spec: AggregatorSpec): IdentifierMode {
  if (spec.identifierSearch) return "search";
  if (spec.identifierChoices.length === 0) return "url";
  if (spec.identifierChoices.length === 1) return "none";
  return "choice";
}

/**
 * The identifier value a `none`/`choice`-mode aggregator starts with (its
 * first — for `none`, only — choice), or `""` for `url`/`search` modes,
 * where there's nothing to default to.
 */
export function defaultIdentifierFor(spec: AggregatorSpec): string {
  return spec.identifierChoices[0]?.value ?? "";
}

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
  /**
   * The checkbox/value pair mirrors `ai_translate` + `ai_translate_language`:
   * the flag is what `applyAiOptions()` gates on, the text is what it sends.
   * Checked with empty text is a no-op, exactly as an unchecked box is —
   * see the gating comment in `src/lib/ai/run.ts`.
   */
  {
    key: "ai_custom_prompt",
    label: "Custom Prompt",
    kind: "boolean",
    default: false,
    requires: "ai",
  },
  {
    key: "ai_custom_prompt_text",
    label: "Custom Prompt",
    kind: "prompt",
    dependsOn: "ai_custom_prompt",
    default: "",
    help: "Sent with every article this feed aggregates. Runs on its own, with the options above unchecked.",
    requires: "ai",
  },
];

/**
 * `content_selectors`/`ignore_selectors` -- for `full_website` only, the one
 * aggregator with no site of its own and therefore no curated selectors to
 * fall back on. Every site-specific aggregator (Heise, Merkur, Tagesschau,
 * The Verge, Ars Technica, ...) hardcodes its own `content_selectors`/
 * `selectors_to_remove` tuned to that site's markup (or, like Tagesschau,
 * bypasses selector-based extraction entirely), so exposing these two fields
 * on their spec would let a user silently override a curated selector with
 * one that matches nothing -- or, for Tagesschau, a `content_selectors` field
 * its `extractContent` override never even reads.
 */
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
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
    identifierLabel: "URL",
    identifierHelp: "Website URL",
    identifierChoices: [],
    options: WEBSITE_OPTIONS,
  },
  feed_content: {
    key: "feed_content",
    label: "Feed Content",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
    identifierLabel: "URL",
    identifierHelp: "RSS Feed URL",
    identifierChoices: [],
    options: AI_OPTIONS,
  },
  heise: {
    key: "heise",
    label: "Heise",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Heise feed",
    identifierChoices: [
      { value: "https://www.heise.de/rss/heise.rdf", label: "Main Feed" },
      { value: "https://www.heise.de/rss/heise-security.rdf", label: "Security" },
      { value: "https://www.heise.de/rss/heise-developer.rdf", label: "Developer" },
      { value: "https://www.heise.de/rss/heise-top.rdf", label: "Top News" },
    ],
    options: [
      ...AI_OPTIONS,
      { key: "include_comments", label: "Include Comments", kind: "boolean", default: true },
      { key: "max_comments", label: "Max Comments", kind: "number", default: 5 },
    ],
  },
  merkur: {
    key: "merkur",
    label: "Merkur",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Merkur feed",
    identifierChoices: [
      { value: "https://www.merkur.de/rssfeed.rdf", label: "Main Feed" },
      {
        value: "https://www.merkur.de/lokales/garmisch-partenkirchen/rssfeed.rdf",
        label: "Garmisch-Partenkirchen",
      },
      { value: "https://www.merkur.de/lokales/wuermtal/rssfeed.rdf", label: "Würmtal" },
      { value: "https://www.merkur.de/lokales/starnberg/rssfeed.rdf", label: "Starnberg" },
      {
        value: "https://www.merkur.de/lokales/fuerstenfeldbruck/rssfeed.rdf",
        label: "Fürstenfeldbruck",
      },
      { value: "https://www.merkur.de/lokales/dachau/rssfeed.rdf", label: "Dachau" },
      { value: "https://www.merkur.de/lokales/freising/rssfeed.rdf", label: "Freising" },
      { value: "https://www.merkur.de/lokales/erding/rssfeed.rdf", label: "Erding" },
      { value: "https://www.merkur.de/lokales/ebersberg/rssfeed.rdf", label: "Ebersberg" },
      { value: "https://www.merkur.de/lokales/muenchen/rssfeed.rdf", label: "München" },
      {
        value: "https://www.merkur.de/lokales/muenchen-lk/rssfeed.rdf",
        label: "München Landkreis",
      },
      { value: "https://www.merkur.de/lokales/holzkirchen/rssfeed.rdf", label: "Holzkirchen" },
      { value: "https://www.merkur.de/lokales/miesbach/rssfeed.rdf", label: "Miesbach" },
      {
        value: "https://www.merkur.de/lokales/region-tegernsee/rssfeed.rdf",
        label: "Region Tegernsee",
      },
      { value: "https://www.merkur.de/lokales/bad-toelz/rssfeed.rdf", label: "Bad Tölz" },
      {
        value: "https://www.merkur.de/lokales/wolfratshausen/rssfeed.rdf",
        label: "Wolfratshausen",
      },
      { value: "https://www.merkur.de/lokales/weilheim/rssfeed.rdf", label: "Weilheim" },
      { value: "https://www.merkur.de/lokales/schongau/rssfeed.rdf", label: "Schongau" },
    ],
    options: [
      ...AI_OPTIONS,
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
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Tagesschau feed",
    identifierChoices: [
      {
        value: "https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml",
        label: "Alle Meldungen",
      },
      { value: "https://www.tagesschau.de/index~rss2.xml", label: "Startseite" },
      { value: "https://www.tagesschau.de/inland/index~rss2.xml", label: "Inland" },
      {
        value: "https://www.tagesschau.de/inland/innenpolitik/index~rss2.xml",
        label: "Innenpolitik",
      },
      {
        value: "https://www.tagesschau.de/inland/gesellschaft/index~rss2.xml",
        label: "Gesellschaft",
      },
      {
        value: "https://www.tagesschau.de/inland/regional/index~rss2.xml",
        label: "Regional (Alle)",
      },
      {
        value: "https://www.tagesschau.de/inland/regional/badenwuerttemberg/index~rss2.xml",
        label: "Baden-Württemberg",
      },
      { value: "https://www.tagesschau.de/inland/regional/bayern/index~rss2.xml", label: "Bayern" },
      { value: "https://www.tagesschau.de/inland/regional/berlin/index~rss2.xml", label: "Berlin" },
      {
        value: "https://www.tagesschau.de/inland/regional/brandenburg/index~rss2.xml",
        label: "Brandenburg",
      },
      { value: "https://www.tagesschau.de/inland/regional/bremen/index~rss2.xml", label: "Bremen" },
      {
        value: "https://www.tagesschau.de/inland/regional/hamburg/index~rss2.xml",
        label: "Hamburg",
      },
      { value: "https://www.tagesschau.de/inland/regional/hessen/index~rss2.xml", label: "Hessen" },
      {
        value: "https://www.tagesschau.de/inland/regional/mecklenburgvorpommern/index~rss2.xml",
        label: "Mecklenburg-Vorpommern",
      },
      {
        value: "https://www.tagesschau.de/inland/regional/niedersachsen/index~rss2.xml",
        label: "Niedersachsen",
      },
      {
        value: "https://www.tagesschau.de/inland/regional/nordrheinwestfalen/index~rss2.xml",
        label: "Nordrhein-Westfalen",
      },
      {
        value: "https://www.tagesschau.de/inland/regional/rheinlandpfalz/index~rss2.xml",
        label: "Rheinland-Pfalz",
      },
      {
        value: "https://www.tagesschau.de/inland/regional/saarland/index~rss2.xml",
        label: "Saarland",
      },
      {
        value: "https://www.tagesschau.de/inland/regional/sachsen/index~rss2.xml",
        label: "Sachsen",
      },
      {
        value: "https://www.tagesschau.de/inland/regional/sachsenanhalt/index~rss2.xml",
        label: "Sachsen-Anhalt",
      },
      {
        value: "https://www.tagesschau.de/inland/regional/schleswigholstein/index~rss2.xml",
        label: "Schleswig-Holstein",
      },
      {
        value: "https://www.tagesschau.de/inland/regional/thueringen/index~rss2.xml",
        label: "Thüringen",
      },
      { value: "https://www.tagesschau.de/ausland/index~rss2.xml", label: "Ausland" },
      { value: "https://www.tagesschau.de/ausland/europa/index~rss2.xml", label: "Europa" },
      { value: "https://www.tagesschau.de/ausland/amerika/index~rss2.xml", label: "Amerika" },
      { value: "https://www.tagesschau.de/ausland/afrika/index~rss2.xml", label: "Afrika" },
      { value: "https://www.tagesschau.de/ausland/asien/index~rss2.xml", label: "Asien" },
      { value: "https://www.tagesschau.de/ausland/ozeanien/index~rss2.xml", label: "Ozeanien" },
      { value: "https://www.tagesschau.de/wirtschaft/index~rss2.xml", label: "Wirtschaft" },
      {
        value: "https://www.tagesschau.de/wirtschaft/finanzen/index~rss2.xml",
        label: "Finanzen",
      },
      {
        value: "https://www.tagesschau.de/wirtschaft/unternehmen/index~rss2.xml",
        label: "Unternehmen",
      },
      {
        value: "https://www.tagesschau.de/wirtschaft/verbraucher/index~rss2.xml",
        label: "Verbraucher",
      },
      {
        value: "https://www.tagesschau.de/wirtschaft/technologie/index~rss2.xml",
        label: "Technologie (Wirtschaft)",
      },
      {
        value: "https://www.tagesschau.de/wirtschaft/weltwirtschaft/index~rss2.xml",
        label: "Weltwirtschaft",
      },
      {
        value: "https://www.tagesschau.de/wirtschaft/konjunktur/index~rss2.xml",
        label: "Konjunktur",
      },
      { value: "https://www.tagesschau.de/wissen/index~rss2.xml", label: "Wissen" },
      {
        value: "https://www.tagesschau.de/wissen/gesundheit/index~rss2.xml",
        label: "Gesundheit",
      },
      {
        value: "https://www.tagesschau.de/wissen/klima/index~rss2.xml",
        label: "Klima & Umwelt",
      },
      {
        value: "https://www.tagesschau.de/wissen/forschung/index~rss2.xml",
        label: "Forschung",
      },
      {
        value: "https://www.tagesschau.de/wissen/technologie/index~rss2.xml",
        label: "Technologie (Wissen)",
      },
      {
        value: "https://www.tagesschau.de/faktenfinder/index~rss2.xml",
        label: "Faktenfinder",
      },
      {
        value: "https://www.tagesschau.de/investigativ/index~rss2.xml",
        label: "Investigativ",
      },
    ],
    options: [
      ...AI_OPTIONS,
      { key: "skip_livestreams", label: "Skip Livestreams", kind: "boolean", default: true },
      { key: "skip_videos", label: "Skip Videos", kind: "boolean", default: true },
    ],
  },
  explosm: {
    key: "explosm",
    label: "Explosm",
    recommendedIntervalMinutes: 1440,
    recommendedConcurrency: 4,
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Explosm feed",
    identifierChoices: [
      { value: "https://explosm.net/rss.xml", label: "Cyanide & Happiness (Main RSS)" },
    ],
    options: [
      ...AI_OPTIONS,
      { key: "show_alt_text", label: "Show Alt Text", kind: "boolean", default: true },
    ],
  },
  dark_legacy: {
    key: "dark_legacy",
    label: "Dark Legacy Comics",
    recommendedIntervalMinutes: 1440,
    recommendedConcurrency: 4,
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Dark Legacy feed",
    identifierChoices: [
      { value: "https://darklegacycomics.com/feed.xml", label: "Dark Legacy Comics (Main Feed)" },
    ],
    options: [
      ...AI_OPTIONS,
      { key: "show_alt_text", label: "Show Alt Text", kind: "boolean", default: true },
    ],
  },
  caschys_blog: {
    key: "caschys_blog",
    label: "Caschys Blog",
    recommendedIntervalMinutes: 60,
    recommendedConcurrency: 2,
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Caschys Blog feed",
    identifierChoices: [
      { value: "https://stadt-bremerhaven.de/feed/", label: "Caschy's Blog (Main Feed)" },
    ],
    options: [
      ...AI_OPTIONS,
      { key: "skip_ads", label: "Skip Ads", kind: "boolean", default: true },
    ],
  },
  mactechnews: {
    key: "mactechnews",
    label: "MacTechNews",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select MacTechNews feed",
    identifierChoices: [
      { value: "https://www.mactechnews.de/Rss/News.x", label: "News" },
      { value: "https://www.mactechnews.de/Rss/Rewind.x", label: "Rewind" },
      { value: "https://www.mactechnews.de/Rss/Journals.x", label: "Journals" },
    ],
    options: [
      ...AI_OPTIONS,
      { key: "combine_pages", label: "Combine Pages", kind: "boolean", default: true },
      { key: "include_comments", label: "Include Comments", kind: "boolean", default: true },
      { key: "max_comments", label: "Max Comments", kind: "number", default: 5 },
    ],
  },
  oglaf: {
    key: "oglaf",
    label: "Oglaf",
    recommendedIntervalMinutes: 1440,
    recommendedConcurrency: 4,
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Oglaf feed",
    identifierChoices: [{ value: "https://www.oglaf.com/feeds/rss/", label: "Oglaf (Main Feed)" }],
    options: [
      ...AI_OPTIONS,
      { key: "show_alt_text", label: "Show Alt Text", kind: "boolean", default: true },
    ],
  },
  mein_mmo: {
    key: "mein_mmo",
    label: "Mein MMO",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Mein MMO feed",
    identifierChoices: [{ value: "https://mein-mmo.de/feed/", label: "Main Feed (All Articles)" }],
    options: [
      ...AI_OPTIONS,
      { key: "combine_pages", label: "Combine Pages", kind: "boolean", default: true },
      { key: "include_comments", label: "Include Comments", kind: "boolean", default: true },
      { key: "max_comments", label: "Max Comments", kind: "number", default: 5 },
      // Off by default, unlike every other boolean option here: this is the
      // Dailymotion player Mein-MMO's CMS auto-inserts into article bodies,
      // not an author's embed -- see processDailymotionBlocks() in
      // sites/mein_mmo/content.ts. The label has to carry the whole
      // explanation, because feed-form.tsx renders no `help` for a boolean.
      {
        key: "include_videos",
        label: "Include Auto-Inserted Videos",
        kind: "boolean",
        default: false,
      },
    ],
  },
  the_verge: {
    key: "the_verge",
    label: "The Verge",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select The Verge feed",
    identifierChoices: [{ value: "https://www.theverge.com/rss/index.xml", label: "Main Feed" }],
    options: AI_OPTIONS,
  },
  ars_technica: {
    key: "ars_technica",
    label: "Ars Technica",
    recommendedIntervalMinutes: 30,
    recommendedConcurrency: 4,
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Ars Technica feed",
    identifierChoices: [
      { value: "https://arstechnica.com/feed/", label: "Main Feed" },
      { value: "https://arstechnica.com/gadgets/feed/", label: "Gadgets" },
      { value: "https://arstechnica.com/science/feed/", label: "Science" },
      { value: "https://arstechnica.com/gaming/feed/", label: "Gaming" },
    ],
    options: AI_OPTIONS,
  },
  youtube: {
    key: "youtube",
    label: "YouTube",
    recommendedIntervalMinutes: 60,
    recommendedConcurrency: 2,
    identifierRequired: true,
    identifierLabel: "Channel",
    identifierHelp: "YouTube Channel ID or URL",
    identifierChoices: [],
    identifierSearch: "youtube",
    options: [
      ...AI_OPTIONS,
      { key: "comment_limit", label: "Comment Limit", kind: "number", default: 10 },
    ],
  },
  reddit: {
    key: "reddit",
    label: "Reddit",
    recommendedIntervalMinutes: 60,
    recommendedConcurrency: 2,
    identifierRequired: true,
    identifierLabel: "Subreddit",
    identifierHelp: "Subreddit name or URL",
    identifierChoices: [],
    identifierSearch: "reddit",
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
    recommendedIntervalMinutes: 1440,
    recommendedConcurrency: 4,
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Podcast RSS Feed",
    identifierChoices: [],
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
      case "prompt":
        type = z.string().max(MAX_CUSTOM_PROMPT_LENGTH);
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
