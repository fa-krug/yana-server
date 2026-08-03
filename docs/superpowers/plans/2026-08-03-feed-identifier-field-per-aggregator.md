# Feed Identifier Field, Shaped Per Aggregator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the feed form's one-size-fits-all identifier text input with four modes derived from
each aggregator's real shape: nothing to configure, a free-form URL, a fixed dropdown of named feed
variants, or a live search against the YouTube/Reddit APIs.

**Architecture:** A pure function `identifierModeFor(spec)` in the client-safe
`src/lib/aggregators/specs.ts` derives one of `"none" | "url" | "choice" | "search"` from data already
on (or added to) each `AggregatorSpec`. `feed-form.tsx` switches on that mode. The two search-mode
aggregators get a new server action that calls the live APIs using the user's stored integration
credentials, and a new Base UI-backed autocomplete component to drive it.

**Tech Stack:** Next.js 16 / React 19 / TypeScript, Drizzle + better-sqlite3, `@base-ui/react`
(already a dependency), next-intl, Vitest.

## Global Constraints

- Line length 100, double quotes, semicolons, trailing commas (Prettier owns formatting).
- `@/*` maps to `src/*`.
- No new dependency versions — everything used here (`@base-ui/react`, `lucide-react`) is already
  pinned in `package.json`.
- `messages/en.json` and `messages/de.json` must define identical key sets — every new key goes in
  both, in the same commit.
- New library code under `src/lib/**` gets real-database tests (no driver mocks), following
  `src/lib/db/client.test.ts`'s style — see `src/lib/feeds/actions.test.ts` for this feature's exact
  pattern (temp SQLite file per test, real Better Auth session cookie).
- Server actions in this codebase are called through `attempt()`/`attemptIn()`
  (`src/lib/attempt.ts`) from client components — never awaited bare. This plan's one new client-side
  action (`searchFeedIdentifier`) follows that rule; the pre-existing `createFeed`/`updateFeed` calls
  in `feed-form.tsx` are not touched (out of scope — see the design doc's "Out of scope" section).
- `ProbeResult.detail` / any new provider-facing error text is built from string constants only —
  never interpolate a response body or a credential into anything a user or log line renders.

---

### Task 1: Give `explosm`, `dark_legacy`, and `oglaf` the missing `getIdentifierChoices()` override

**Why this is first:** the rest of this plan derives each aggregator's UI mode from
`identifierChoices.length`. Three site classes are missing the single-entry override their Django
ancestors had (confirmed by reading `old/core/aggregators/{explosm,dark_legacy}/aggregator.py`, which
both explicitly override `get_identifier_choices()`, and by the fact that `caschys_blog.ts`,
`the_verge.ts`, and `mein_mmo/aggregator.ts` already carry the equivalent one-entry TS override).
Without this fix, those three aggregators would incorrectly resolve to `"url"` mode (an editable free
text field) instead of `"none"` (nothing to configure).

**Files:**
- Modify: `src/lib/aggregators/sites/explosm.ts:16-21`
- Modify: `src/lib/aggregators/sites/dark_legacy.ts:16-21`
- Modify: `src/lib/aggregators/sites/oglaf.ts:16-24`
- Test: `src/lib/aggregators/registry.test.ts` (Task 2 adds the cross-check that exercises this)

**Interfaces:**
- Produces: `ExplosmAggregator.getIdentifierChoices()`, `DarkLegacyAggregator.getIdentifierChoices()`,
  `OglafAggregator.getIdentifierChoices()` — each `(): Array<[string, string]>`, matching the
  signature every other brand aggregator already implements (see `HeiseAggregator` for the pattern).

- [ ] **Step 1: Add the override to `explosm.ts`**

In `src/lib/aggregators/sites/explosm.ts`, change:

```ts
export class ExplosmAggregator extends FullWebsiteAggregator {
  static brandSiteUrl = "https://explosm.net/";

  static getDefaultIdentifier(): string {
    return "https://explosm.net/rss.xml";
  }
```

to:

```ts
export class ExplosmAggregator extends FullWebsiteAggregator {
  static brandSiteUrl = "https://explosm.net/";

  static getDefaultIdentifier(): string {
    return "https://explosm.net/rss.xml";
  }

  static getIdentifierChoices(): Array<[string, string]> {
    return [["https://explosm.net/rss.xml", "Cyanide & Happiness (Main RSS)"]];
  }
```

- [ ] **Step 2: Add the override to `dark_legacy.ts`**

In `src/lib/aggregators/sites/dark_legacy.ts`, change:

```ts
export class DarkLegacyAggregator extends FullWebsiteAggregator {
  static brandSiteUrl = "https://darklegacycomics.com/";

  static getDefaultIdentifier(): string {
    return "https://darklegacycomics.com/feed.xml";
  }
```

to:

```ts
export class DarkLegacyAggregator extends FullWebsiteAggregator {
  static brandSiteUrl = "https://darklegacycomics.com/";

  static getDefaultIdentifier(): string {
    return "https://darklegacycomics.com/feed.xml";
  }

  static getIdentifierChoices(): Array<[string, string]> {
    return [["https://darklegacycomics.com/feed.xml", "Dark Legacy Comics (Main Feed)"]];
  }
```

- [ ] **Step 3: Add the override to `oglaf.ts`**

In `src/lib/aggregators/sites/oglaf.ts`, change:

```ts
export class OglafAggregator extends FullWebsiteAggregator {
  static brandSiteUrl = "https://www.oglaf.com/";

  static getDefaultIdentifier(): string {
    return "https://www.oglaf.com/feeds/rss/";
  }

  static resolvesFeedUrl(): boolean {
    return false;
  }
```

to (keep `resolvesFeedUrl` — it's dead code today, not called anywhere outside `base.ts` itself and
its own declaration per `grep -rn resolvesFeedUrl src/`, but it's a correctness signal for a future
feature and removing it is not this task's job):

```ts
export class OglafAggregator extends FullWebsiteAggregator {
  static brandSiteUrl = "https://www.oglaf.com/";

  static getDefaultIdentifier(): string {
    return "https://www.oglaf.com/feeds/rss/";
  }

  static getIdentifierChoices(): Array<[string, string]> {
    return [["https://www.oglaf.com/feeds/rss/", "Oglaf (Main Feed)"]];
  }

  static resolvesFeedUrl(): boolean {
    return false;
  }
```

- [ ] **Step 4: Typecheck and run the existing aggregator test suite**

Run: `npm run typecheck && npx vitest run src/lib/aggregators`
Expected: PASS (these three classes have no dedicated test file yet, so nothing exercises the new
method until Task 2 — this step only confirms the edit doesn't break anything else, e.g. golden
parity tests elsewhere in `src/lib/aggregators`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/aggregators/sites/explosm.ts src/lib/aggregators/sites/dark_legacy.ts src/lib/aggregators/sites/oglaf.ts
git commit -m "fix(aggregators): restore the missing single-feed identifier choice for explosm, dark_legacy, and oglaf"
```

---

### Task 2: Add `identifierChoices` / `identifierSearch` / `identifierModeFor()` to the spec layer

**Files:**
- Modify: `src/lib/aggregators/specs.ts`
- Test: `src/lib/aggregators/registry.test.ts`

**Interfaces:**
- Consumes: `ExplosmAggregator`, `DarkLegacyAggregator`, `OglafAggregator` (Task 1's fix — the
  literal choice data written here must match their `getIdentifierChoices()` exactly), and every
  other site class's already-existing `getIdentifierChoices()` (`HeiseAggregator`, `MerkurAggregator`,
  `TagesschauAggregator`, `ArsTechnicaAggregator`, `MactechnewsAggregator`, `CaschysBlogAggregator`,
  `TheVergeAggregator`, `MeinMmoAggregator`).
- Produces (consumed by Tasks 8 and 9):
  - `AggregatorSpec.identifierChoices: { value: string; label: string }[]`
  - `AggregatorSpec.identifierSearch?: "youtube" | "reddit"`
  - `export type IdentifierMode = "none" | "url" | "choice" | "search";`
  - `export function identifierModeFor(spec: AggregatorSpec): IdentifierMode`
  - `export function defaultIdentifierFor(spec: AggregatorSpec): string` — `""` for `url`/`search`
    modes, `spec.identifierChoices[0].value` for `none`/`choice` modes.

- [ ] **Step 1: Extend the type and add the derivation functions**

In `src/lib/aggregators/specs.ts`, change:

```ts
export type AggregatorSpec = {
  key: AggregatorKey;
  label: string;
  identifierRequired: boolean;
  identifierLabel: string;
  identifierHelp: string;
  options: OptionSpec[];
};

export type Capabilities = { youtube: boolean; reddit: boolean; ai: boolean };
```

to:

```ts
export type AggregatorSpec = {
  key: AggregatorKey;
  label: string;
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
```

- [ ] **Step 2: Populate `identifierChoices` / `identifierSearch` for all 16 entries**

Still in `src/lib/aggregators/specs.ts`, add `identifierChoices: []` to `full_website`, `feed_content`,
and `podcast` (the three `url`-mode entries — no data to carry). For every other entry, add
`identifierChoices` copied verbatim from the matching site class, and add `identifierSearch` to
`youtube`/`reddit`. The full set of edits:

```ts
  full_website: {
    key: "full_website",
    label: "Full Website",
    identifierRequired: false,
    identifierLabel: "URL",
    identifierHelp: "Website URL",
    identifierChoices: [],
    options: WEBSITE_OPTIONS,
  },
  feed_content: {
    key: "feed_content",
    label: "Feed Content",
    identifierRequired: false,
    identifierLabel: "URL",
    identifierHelp: "RSS Feed URL",
    identifierChoices: [],
    options: AI_OPTIONS,
  },
  heise: {
    key: "heise",
    label: "Heise",
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
      { value: "https://www.tagesschau.de/inland/regional/hamburg/index~rss2.xml", label: "Hamburg" },
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
    ],
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
    identifierChoices: [
      { value: "https://explosm.net/rss.xml", label: "Cyanide & Happiness (Main RSS)" },
    ],
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
    identifierChoices: [
      { value: "https://darklegacycomics.com/feed.xml", label: "Dark Legacy Comics (Main Feed)" },
    ],
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
    identifierChoices: [
      { value: "https://stadt-bremerhaven.de/feed/", label: "Caschy's Blog (Main Feed)" },
    ],
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
    identifierChoices: [
      { value: "https://www.mactechnews.de/Rss/News.x", label: "News" },
      { value: "https://www.mactechnews.de/Rss/Rewind.x", label: "Rewind" },
      { value: "https://www.mactechnews.de/Rss/Journals.x", label: "Journals" },
    ],
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
    identifierChoices: [{ value: "https://www.oglaf.com/feeds/rss/", label: "Oglaf (Main Feed)" }],
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
    identifierChoices: [
      { value: "https://mein-mmo.de/feed/", label: "Main Feed (All Articles)" },
    ],
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
    identifierChoices: [{ value: "https://www.theverge.com/rss/index.xml", label: "Main Feed" }],
    options: WEBSITE_OPTIONS,
  },
  ars_technica: {
    key: "ars_technica",
    label: "Ars Technica",
    identifierRequired: false,
    identifierLabel: "Feed",
    identifierHelp: "Select Ars Technica feed",
    identifierChoices: [
      { value: "https://arstechnica.com/feed/", label: "Main Feed" },
      { value: "https://arstechnica.com/gadgets/feed/", label: "Gadgets" },
      { value: "https://arstechnica.com/science/feed/", label: "Science" },
      { value: "https://arstechnica.com/gaming/feed/", label: "Gaming" },
    ],
    options: WEBSITE_OPTIONS,
  },
  youtube: {
    key: "youtube",
    label: "YouTube",
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
```

- [ ] **Step 3: Write the failing cross-check test**

Add to `src/lib/aggregators/registry.test.ts`. First extend the imports at the top of the file:

```ts
import { describe, expect, it } from "vitest";

import { AGGREGATOR_KEYS } from "@/lib/db/schema";

import { BaseAggregator } from "./base";
import { AggregatorRegistry, getAggregator, IMPLEMENTED_AGGREGATORS } from "./registry";
import {
  AGGREGATOR_SPECS,
  defaultIdentifierFor,
  identifierModeFor,
  schemaFor,
  stripUnavailable,
  visibleOptionsFor,
} from "./specs";
import { RssAggregator } from "./rss";
import { FullWebsiteAggregator } from "./website";
import { ArsTechnicaAggregator } from "./sites/ars_technica";
import { CaschysBlogAggregator } from "./sites/caschys_blog";
import { DarkLegacyAggregator } from "./sites/dark_legacy";
import { ExplosmAggregator } from "./sites/explosm";
import { HeiseAggregator } from "./sites/heise";
import { MactechnewsAggregator } from "./sites/mactechnews/aggregator";
import { MeinMmoAggregator } from "./sites/mein_mmo/aggregator";
import { MerkurAggregator } from "./sites/merkur";
import { OglafAggregator } from "./sites/oglaf";
import { TagesschauAggregator } from "./sites/tagesschau/aggregator";
import { TheVergeAggregator } from "./sites/the_verge";
```

Then append at the end of the file:

```ts
describe("identifierModeFor", () => {
  it("derives the four modes from the data on each spec", () => {
    const expected: Record<string, string> = {
      full_website: "url",
      feed_content: "url",
      podcast: "url",
      heise: "choice",
      merkur: "choice",
      tagesschau: "choice",
      ars_technica: "choice",
      mactechnews: "choice",
      explosm: "none",
      dark_legacy: "none",
      caschys_blog: "none",
      oglaf: "none",
      mein_mmo: "none",
      the_verge: "none",
      youtube: "search",
      reddit: "search",
    };

    for (const key of AGGREGATOR_KEYS) {
      expect(identifierModeFor(AGGREGATOR_SPECS[key]), key).toBe(expected[key]);
    }
  });

  it("gives none/choice modes a non-empty default identifier", () => {
    for (const key of AGGREGATOR_KEYS) {
      const spec = AGGREGATOR_SPECS[key];
      const mode = identifierModeFor(spec);
      if (mode === "none" || mode === "choice") {
        expect(defaultIdentifierFor(spec), key).not.toBe("");
      } else {
        expect(defaultIdentifierFor(spec), key).toBe("");
      }
    }
  });
});

describe("identifierChoices parity with the ported aggregator classes", () => {
  const classesWithChoices: [string, typeof BaseAggregator][] = [
    ["heise", HeiseAggregator],
    ["merkur", MerkurAggregator],
    ["tagesschau", TagesschauAggregator],
    ["ars_technica", ArsTechnicaAggregator],
    ["mactechnews", MactechnewsAggregator],
    ["explosm", ExplosmAggregator],
    ["dark_legacy", DarkLegacyAggregator],
    ["caschys_blog", CaschysBlogAggregator],
    ["oglaf", OglafAggregator],
    ["mein_mmo", MeinMmoAggregator],
    ["the_verge", TheVergeAggregator],
  ];

  it("matches each site class's getIdentifierChoices() byte-for-byte", () => {
    for (const [key, cls] of classesWithChoices) {
      const fromClass = cls.getIdentifierChoices().map(([value, label]) => ({ value, label }));
      expect(AGGREGATOR_SPECS[key as keyof typeof AGGREGATOR_SPECS].identifierChoices, key).toEqual(
        fromClass,
      );
    }
  });
});
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/lib/aggregators/registry.test.ts`
Expected: PASS — all `describe` blocks green, including the two new ones. If the parity test fails for
any key, the `identifierChoices` array copied into `specs.ts` for that key doesn't match its class; fix
the transcription (do not change the class).

- [ ] **Step 5: Full typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/aggregators/specs.ts src/lib/aggregators/registry.test.ts
git commit -m "feat(aggregators): derive an identifier UI mode from each spec's choices"
```

---

### Task 3: Factor Reddit's access-token exchange out of the credential probe

**Why:** the new search action (Task 5) needs a Reddit OAuth bearer token the same way the existing
credential probe does. Sharing the exchange rather than copying it is what Task 5 depends on.

**Files:**
- Modify: `src/lib/integrations/reddit.ts`
- Test: `src/lib/integrations/reddit.test.ts` (no new tests needed — this step must leave every
  existing test passing unchanged, which is the proof the refactor preserved behavior)

**Interfaces:**
- Produces:
  `export async function fetchRedditAccessToken(credentials: RedditCredentials): Promise<{ ok: true; token: string } | { ok: false; result: ProbeResult }>`
- Consumes: `PROBE_TIMEOUT_MS`, `readJson`, `ProbeResult` from `./probe` (already imported in this
  file).

- [ ] **Step 1: Extract the token exchange**

In `src/lib/integrations/reddit.ts`, add `readJson` to the existing import from `./probe`:

```ts
import { PROBE_TIMEOUT_MS, readJson, transportFailure, type ProbeResult } from "./probe";
```

Then replace the body of `testRedditCredentials` — from the `try {` through the closing of that
function — extracting the token exchange into a new function placed just above it:

```ts
/**
 * One client-credentials token request against Reddit's OAuth endpoint.
 *
 * Shared between {@link testRedditCredentials} (which only needs to know
 * whether the exchange succeeded) and the identifier-search action in
 * `src/lib/aggregators/search.ts` (which needs the token itself to call
 * `/subreddits/search`). Never rejects for an HTTP-level failure -- only a
 * genuine transport failure (network, timeout) throws, exactly like every
 * other probe in this file.
 */
export async function fetchRedditAccessToken({
  clientId,
  clientSecret,
  userAgent,
}: RedditCredentials): Promise<{ ok: true; token: string } | { ok: false; result: ProbeResult }> {
  const credentials = toBasicAuthBase64(`${clientId}:${clientSecret}`);
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "User-Agent": userAgent,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });

  /**
   * **A 200 is not enough here: the token has to be in it.** See the note that
   * used to live on `testRedditCredentials` -- unchanged reasoning, just moved
   * with the code: an OAuth token endpoint has real answers that are `200` and
   * prove nothing about the credential (`{"error":"unsupported_grant_type"}` if
   * the form body ever changes, or an HTML interstitial to a flagged IP).
   */
  if (response.ok) {
    const tokenResponse = (await readJson(response)) as { access_token?: unknown } | null;
    if (typeof tokenResponse?.access_token === "string" && tokenResponse.access_token !== "") {
      return { ok: true, token: tokenResponse.access_token };
    }
    return {
      ok: false,
      result: { ok: false, cause: "unexpected", detail: "A 200 answer carried no access token." },
    };
  }
  if (response.status === 401) {
    return {
      ok: false,
      result: { ok: false, cause: "unauthorized", detail: "The client credentials were rejected." },
    };
  }
  if (response.status === 429) {
    // Not a verdict on the credential: Reddit sheds load at the edge, before
    // the Basic auth header is validated.
    return {
      ok: false,
      result: {
        ok: false,
        cause: "quota",
        detail: "Rate limited before the credentials could be checked.",
      },
    };
  }
  return {
    ok: false,
    result: { ok: false, cause: "unexpected", detail: `Unexpected status ${response.status}.` },
  };
}

/**
 * One client-credentials token request -- the cheapest call that proves the
 * client id and secret are accepted. Provider messages are classified rather
 * than forwarded, for the same reason as the YouTube probe: a raw body can
 * echo a submitted credential straight back into the page.
 */
export async function testRedditCredentials({
  clientId,
  clientSecret,
  userAgent,
}: RedditCredentials): Promise<ProbeResult> {
  // Reddit rate-limits a missing or generic User-Agent aggressively, so a
  // blank one is a doomed request -- refused before any HTTP call is made,
  // not after.
  if (userAgent.trim() === "") {
    return {
      ok: false,
      cause: "unauthorized",
      detail: "A descriptive User-Agent is required and none was configured.",
    };
  }

  try {
    const tokenResult = await fetchRedditAccessToken({ clientId, clientSecret, userAgent });
    if (!tokenResult.ok) return tokenResult.result;
    return { ok: true, detail: "Credentials accepted." };
  } catch (error) {
    return transportFailure("reddit", error, "Could not reach the Reddit API.");
  }
}
```

Remove the old inline implementation of `testRedditCredentials` that this replaces (the block that
previously built the Basic auth header and called `fetch` directly inside its own `try`).

- [ ] **Step 2: Run the existing Reddit test suite unchanged**

Run: `npx vitest run src/lib/integrations/reddit.test.ts`
Expected: PASS, with the exact same test cases as before this task — this is what proves the
extraction didn't change `testRedditCredentials`'s behavior.

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/integrations/reddit.ts
git commit -m "refactor(integrations): extract fetchRedditAccessToken for reuse by feed identifier search"
```

---

### Task 4: Add the `feeds` result binding and the new catalog keys

**Files:**
- Create: `src/lib/feeds/result.ts`
- Modify: `messages/en.json`
- Modify: `messages/de.json`

**Interfaces:**
- Produces: `export const attempt: ReturnType<typeof attemptIn<"feeds">>` from
  `src/lib/feeds/result.ts` — called as `attempt(() => someFeedsAction(...))` by Task 7's autocomplete
  component.
- New catalog keys (both files, identical structure): `feeds.sessionEnded`, `feeds.requestFailed`,
  `feeds.identifierSearch.placeholder`, `feeds.identifierSearch.loading`,
  `feeds.identifierSearch.empty`, `feeds.identifierSearch.unavailable`,
  `feeds.identifierSearch.unavailableBannerBefore`, `feeds.identifierSearch.unavailableBannerLink`,
  `feeds.identifierSearch.unavailableBannerAfter`. The last three compose one sentence around a
  `<Link>` — split rather than one ICU string, since there's no `t.rich`-style precedent anywhere in
  this codebase to embed a React element inside a translated string (`grep -rn "t.rich" src/` is
  empty), and English/German put the link in different positions in the sentence (German's verb lands
  after it, not before), so a single "before/after the link" split has to hold for both languages
  rather than assuming English's word order.

- [ ] **Step 1: Create the result binding**

Create `src/lib/feeds/result.ts`:

```ts
import { attemptIn } from "@/lib/attempt";

/**
 * The `feeds` binding of `attempt()` (see `src/lib/attempt.ts`). The one
 * client-side call that needs it today is the identifier search in
 * `src/components/feeds/identifier-autocomplete.tsx` — `feed-form.tsx`'s own
 * `createFeed`/`updateFeed` calls predate this convention and are unchanged
 * by this feature.
 */
export const attempt = attemptIn("feeds", {
  sessionEnded: "sessionEnded",
  requestFailed: "requestFailed",
});
```

- [ ] **Step 2: Add the catalog keys to `messages/en.json`**

In the `"feeds"` object, add `sessionEnded` and `requestFailed` right after `"title"`:

```json
  "title": "Feeds",
  "sessionEnded": "Your session ended. Sign in again to continue.",
  "requestFailed": "The server did not answer. Check your connection and try again.",
```

And add an `"identifierSearch"` object right after the closing of `"columns"` (before `"form"`):

```json
  "identifierSearch": {
    "placeholder": "Type to search",
    "loading": "Searching…",
    "empty": "No results",
    "unavailable": "This integration is not configured. You can configure it in Integrations.",
    "unavailableBannerBefore": "This feed's integration is not configured. You can configure it in",
    "unavailableBannerLink": "Integrations",
    "unavailableBannerAfter": "."
  },
```

- [ ] **Step 3: Add the same keys to `messages/de.json`**

Mirroring `integrations.sessionEnded`/`integrations.requestFailed`'s existing German text, add to the
`"feeds"` object right after `"title"`:

```json
  "title": "Feeds",
  "sessionEnded": "Deine Sitzung ist beendet. Melde dich erneut an, um fortzufahren.",
  "requestFailed": "Der Server hat nicht geantwortet. Prüfe deine Verbindung und versuche es erneut.",
```

And add, in the same position as the English file (after `"columns"`, before `"form"`):

```json
  "identifierSearch": {
    "placeholder": "Zum Suchen tippen",
    "loading": "Suche läuft…",
    "empty": "Keine Ergebnisse",
    "unavailable": "Diese Integration ist nicht eingerichtet. Du kannst sie unter Integrationen einrichten.",
    "unavailableBannerBefore": "Die Integration für diesen Feed ist nicht eingerichtet. Du kannst sie unter",
    "unavailableBannerLink": "Integrationen",
    "unavailableBannerAfter": "einrichten."
  },
```

- [ ] **Step 4: Run the catalog parity test**

Run: `npx vitest run src/i18n/messages.test.ts`
Expected: PASS — confirms `en.json` and `de.json` still define identical key sets.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS. (`NamespaceKey<"feeds">` now includes the four new leaf paths; nothing consumes them
yet until Task 5/7, so this just confirms the JSON is well-formed and the augmentation still compiles.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/feeds/result.ts messages/en.json messages/de.json
git commit -m "feat(feeds): add the feeds attempt() binding and identifier-search catalog keys"
```

---

### Task 5: The `searchFeedIdentifier` server action

**Files:**
- Create: `src/lib/aggregators/search.ts`
- Test: `src/lib/aggregators/search.test.ts`

**Interfaces:**
- Consumes: `getSettings()` (`@/lib/settings/queries`), `fetchRedditAccessToken` (Task 3),
  `PROBE_TIMEOUT_MS`/`transportFailure`/`readJson` (`@/lib/integrations/probe`), `AggregatorKey`
  (`@/lib/db/schema/enums`), `NamespaceKey<"feeds">` (`@/i18n/next-intl`).
- Produces (consumed by Task 7):
  ```ts
  export type IdentifierSearchResult =
    | { ok: true; results: { value: string; label: string }[] }
    | { ok: false; errorKey: NamespaceKey<"feeds"> };

  export async function searchFeedIdentifier(
    aggregator: AggregatorKey,
    query: string,
  ): Promise<IdentifierSearchResult>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/aggregators/search.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { requestHeaders, cookieJar } = vi.hoisted(() => ({
  requestHeaders: { current: new Headers() },
  cookieJar: new Map<string, string>(),
}));

vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders, cookieJar),
);

const PASSWORD = "correct horse battery staple";

describe("searchFeedIdentifier", () => {
  let dbPath: string;
  let search: typeof import("./search");
  let client: typeof import("@/lib/db/client");
  let raw: (db: unknown) => import("better-sqlite3").Database;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-search-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    const { auth, createUserWithPassword } = await import("@/lib/auth/server");
    client = await import("@/lib/db/client");
    raw = (db) => (db as { $client: import("better-sqlite3").Database }).$client;

    const user = await createUserWithPassword({
      email: "user@example.com",
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "user",
    });
    raw(client.getDb()).exec(`INSERT INTO user_settings (user_id) VALUES ('${user.id}')`);
    const cookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
    requestHeaders.current = new Headers({ cookie });
    cookieJar.clear();

    search = await import("./search");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("returns no results without calling the network when the query is under 2 characters", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const result = await search.searchFeedIdentifier("youtube", "a");
    expect(result).toEqual({ ok: true, results: [] });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports unavailable when youtube is not configured", async () => {
    const result = await search.searchFeedIdentifier("youtube", "linus");
    expect(result).toEqual({ ok: false, errorKey: "identifierSearch.unavailable" });
  });

  it("reports unavailable when reddit is not configured", async () => {
    const result = await search.searchFeedIdentifier("reddit", "programming");
    expect(result).toEqual({ ok: false, errorKey: "identifierSearch.unavailable" });
  });

  it("rejects an aggregator with no search capability", async () => {
    const result = await search.searchFeedIdentifier("heise", "anything");
    expect(result).toEqual({ ok: false, errorKey: "identifierSearch.unavailable" });
  });

  it("searches youtube channels and maps id/title/handle when configured", async () => {
    raw(client.getDb()).exec(
      `UPDATE user_settings SET youtube_enabled = 1, youtube_api_key = 'test-key'`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string | URL) => {
        const href = url.toString();
        if (href.includes("/search")) {
          return Promise.resolve(
            new Response(JSON.stringify({ items: [{ id: { channelId: "UC123" } }] })),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [{ id: "UC123", snippet: { title: "Linus Tech Tips", customUrl: "ltt" } }],
            }),
          ),
        );
      }),
    );

    const result = await search.searchFeedIdentifier("youtube", "linus");
    expect(result).toEqual({
      ok: true,
      results: [{ value: "UC123", label: "Linus Tech Tips (@ltt)" }],
    });
  });

  it("searches subreddits and maps display_name/title/subscribers when configured", async () => {
    raw(client.getDb()).exec(
      `UPDATE user_settings SET reddit_enabled = 1, reddit_client_id = 'id', reddit_client_secret = 'secret', reddit_user_agent = 'Yana/1.0 (test)'`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string | URL) => {
        const href = url.toString();
        if (href.includes("access_token")) {
          return Promise.resolve(new Response(JSON.stringify({ access_token: "tok" })));
        }
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                children: [
                  { data: { display_name: "programming", title: "Programming", subscribers: 5000000 } },
                ],
              },
            }),
          ),
        );
      }),
    );

    const result = await search.searchFeedIdentifier("reddit", "programming");
    expect(result).toEqual({
      ok: true,
      results: [{ value: "programming", label: "r/programming: Programming (5,000,000 subs)" }],
    });
  });

  it("reports unavailable rather than throwing on a transport failure", async () => {
    raw(client.getDb()).exec(
      `UPDATE user_settings SET youtube_enabled = 1, youtube_api_key = 'test-key'`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } })),
    );

    const result = await search.searchFeedIdentifier("youtube", "linus");
    expect(result).toEqual({ ok: false, errorKey: "identifierSearch.unavailable" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/aggregators/search.test.ts`
Expected: FAIL with "Cannot find module './search'" (the module doesn't exist yet).

- [ ] **Step 3: Implement `src/lib/aggregators/search.ts`**

```ts
import type { AggregatorKey } from "@/lib/db/schema/enums";
import type { NamespaceKey } from "@/i18n/next-intl";
import { PROBE_TIMEOUT_MS, readJson, transportFailure } from "@/lib/integrations/probe";
import { fetchRedditAccessToken } from "@/lib/integrations/reddit";
import { getSettings } from "@/lib/settings/queries";

/**
 * The identifier-search server action for the two live-search aggregators.
 * Everything else (a fixed dropdown, a free URL, nothing to configure) needs
 * no server round trip -- see `identifierModeFor()` in `./specs`.
 */
export type IdentifierSearchResult =
  | { ok: true; results: { value: string; label: string }[] }
  | { ok: false; errorKey: NamespaceKey<"feeds"> };

const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 10;

const UNAVAILABLE: IdentifierSearchResult = { ok: false, errorKey: "identifierSearch.unavailable" };

export async function searchFeedIdentifier(
  aggregator: AggregatorKey,
  query: string,
): Promise<IdentifierSearchResult> {
  const trimmed = query.trim();
  if (trimmed.length < MIN_QUERY_LENGTH) {
    return { ok: true, results: [] };
  }

  const settings = await getSettings();

  if (aggregator === "youtube") {
    if (!settings.youtubeEnabled || !settings.youtubeApiKey) return UNAVAILABLE;
    return searchYoutubeChannels(trimmed, settings.youtubeApiKey);
  }

  if (aggregator === "reddit") {
    if (!settings.redditEnabled || !settings.redditClientId || !settings.redditClientSecret) {
      return UNAVAILABLE;
    }
    return searchSubreddits(trimmed, {
      clientId: settings.redditClientId,
      clientSecret: settings.redditClientSecret,
      userAgent: settings.redditUserAgent,
    });
  }

  return UNAVAILABLE;
}

type YoutubeSearchResponse = { items?: { id?: { channelId?: string } }[] };
type YoutubeChannelsResponse = {
  items?: { id?: string; snippet?: { title?: string; customUrl?: string } }[];
};

/**
 * Ported from `search_channels()` in
 * `old/core/aggregators/youtube/aggregator.py`: a `search.list` for channel
 * ids, then a batched `channels.list` for title/handle. Never rejects --
 * every branch below returns `UNAVAILABLE` rather than throwing, and the one
 * `catch` covers a genuine transport failure the same way every probe in
 * `src/lib/integrations/*` does.
 */
async function searchYoutubeChannels(query: string, apiKey: string): Promise<IdentifierSearchResult> {
  try {
    const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
    searchUrl.searchParams.set("part", "id");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("type", "channel");
    searchUrl.searchParams.set("maxResults", String(MAX_RESULTS));
    searchUrl.searchParams.set("key", apiKey);

    const searchResponse = await fetch(searchUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!searchResponse.ok) return UNAVAILABLE;

    const searchBody = (await readJson(searchResponse)) as YoutubeSearchResponse | null;
    const channelIds = (searchBody?.items ?? [])
      .map((item) => item.id?.channelId)
      .filter((id): id is string => typeof id === "string");

    if (channelIds.length === 0) return { ok: true, results: [] };

    const channelsUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
    channelsUrl.searchParams.set("part", "snippet");
    channelsUrl.searchParams.set("id", channelIds.join(","));
    channelsUrl.searchParams.set("key", apiKey);

    const channelsResponse = await fetch(channelsUrl, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!channelsResponse.ok) return UNAVAILABLE;

    const channelsBody = (await readJson(channelsResponse)) as YoutubeChannelsResponse | null;
    const results = (channelsBody?.items ?? [])
      .filter((item): item is { id: string; snippet?: { title?: string; customUrl?: string } } =>
        typeof item.id === "string",
      )
      .map((item) => {
        const title = item.snippet?.title ?? item.id;
        const rawHandle = item.snippet?.customUrl;
        const handle = rawHandle ? (rawHandle.startsWith("@") ? rawHandle : `@${rawHandle}`) : "";
        return { value: item.id, label: handle ? `${title} (${handle})` : `${title} (${item.id})` };
      });

    return { ok: true, results };
  } catch (error) {
    transportFailure("youtube", error, "Could not reach the YouTube API.");
    return UNAVAILABLE;
  }
}

type RedditSearchResponse = {
  data?: { children?: { data?: { display_name?: string; title?: string; subscribers?: number } }[] };
};

/**
 * Ported from `get_identifier_choices()` in
 * `old/core/aggregators/reddit/aggregator.py`, translated from PRAW's
 * `subreddits.search()` to the plain REST endpoint it wraps
 * (`GET /subreddits/search`), authenticated the same client-credentials way
 * as the existing Reddit probe (`fetchRedditAccessToken`).
 */
async function searchSubreddits(
  query: string,
  credentials: { clientId: string; clientSecret: string; userAgent: string },
): Promise<IdentifierSearchResult> {
  try {
    const tokenResult = await fetchRedditAccessToken(credentials);
    if (!tokenResult.ok) return UNAVAILABLE;

    const url = new URL("https://oauth.reddit.com/subreddits/search");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(MAX_RESULTS));

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${tokenResult.token}`,
        "User-Agent": credentials.userAgent,
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return UNAVAILABLE;

    const body = (await readJson(response)) as RedditSearchResponse | null;
    const results = (body?.data?.children ?? [])
      .map((child) => child.data)
      .filter(
        (data): data is { display_name: string; title?: string; subscribers?: number } =>
          typeof data?.display_name === "string",
      )
      .map((data) => ({
        value: data.display_name,
        label: `r/${data.display_name}: ${data.title ?? ""} (${(data.subscribers ?? 0).toLocaleString("en-US")} subs)`,
      }));

    return { ok: true, results };
  } catch (error) {
    transportFailure("reddit", error, "Could not reach the Reddit API.");
    return UNAVAILABLE;
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/aggregators/search.test.ts`
Expected: PASS, all 8 cases.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/aggregators/search.ts src/lib/aggregators/search.test.ts
git commit -m "feat(aggregators): add the YouTube/Reddit identifier search server action"
```

---

### Task 6: The `<Autocomplete>` UI primitive

**Files:**
- Create: `src/components/ui/autocomplete.tsx`

**Interfaces:**
- Produces: `Autocomplete`, `AutocompleteInput`, `AutocompletePopup`, `AutocompleteList`,
  `AutocompleteItem`, `AutocompleteEmpty`, `AutocompleteStatus` — consumed by Task 7.

- [ ] **Step 1: Write the primitive, mirroring `src/components/ui/select.tsx`'s composition style**

Create `src/components/ui/autocomplete.tsx`:

```tsx
"use client";

import * as React from "react";
import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";

import { cn } from "@/lib/utils";

/**
 * The app's `<Autocomplete>` -- composed the same way as `./select.tsx`:
 * `render`-prop composition on top of Base UI, no `asChild`. Unlike
 * `<Select>`, this one is a free-text input with clickable suggestions, not a
 * fixed set of options with one selected value -- see the identifier-search
 * usage in `src/components/feeds/identifier-autocomplete.tsx`, which tracks
 * the actually-selected item's `value` itself rather than trusting this
 * component's own `value` (which is only ever the visible input text).
 */
function Autocomplete<ItemValue>(props: AutocompletePrimitive.Root.Props<ItemValue>) {
  return <AutocompletePrimitive.Root {...props} />;
}

function AutocompleteInput({ className, ...props }: AutocompletePrimitive.Input.Props) {
  return (
    <AutocompletePrimitive.Input
      data-slot="autocomplete-input"
      className={cn(
        "flex h-8 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50",
        className,
      )}
      {...props}
    />
  );
}

function AutocompletePopup({ className, children, ...props }: AutocompletePrimitive.Popup.Props) {
  return (
    <AutocompletePrimitive.Portal>
      <AutocompletePrimitive.Positioner side="bottom" sideOffset={4} className="isolate z-50">
        <AutocompletePrimitive.Popup
          data-slot="autocomplete-popup"
          className={cn(
            "relative isolate z-50 max-h-(--available-height) w-(--anchor-width) overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
            className,
          )}
          {...props}
        >
          <AutocompletePrimitive.List>{children}</AutocompletePrimitive.List>
        </AutocompletePrimitive.Popup>
      </AutocompletePrimitive.Positioner>
    </AutocompletePrimitive.Portal>
  );
}

function AutocompleteItem({ className, children, ...props }: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      data-slot="autocomplete-item"
      className={cn(
        "relative flex w-full cursor-default items-center rounded-md px-1.5 py-1 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
    </AutocompletePrimitive.Item>
  );
}

function AutocompleteEmpty({ className, ...props }: AutocompletePrimitive.Empty.Props) {
  return (
    <AutocompletePrimitive.Empty
      data-slot="autocomplete-empty"
      className={cn("px-2.5 py-2 text-sm text-muted-foreground empty:m-0 empty:p-0", className)}
      {...props}
    />
  );
}

function AutocompleteStatus({ className, ...props }: AutocompletePrimitive.Status.Props) {
  return (
    <AutocompletePrimitive.Status
      data-slot="autocomplete-status"
      className={cn("px-2.5 py-2 text-sm text-muted-foreground empty:m-0 empty:p-0", className)}
      {...props}
    />
  );
}

export {
  Autocomplete,
  AutocompleteInput,
  AutocompletePopup,
  AutocompleteItem,
  AutocompleteEmpty,
  AutocompleteStatus,
};
```

Note: `AutocompletePrimitive.Empty`/`Status` render an empty `<div>` when there's nothing to show
(they must stay mounted for screen-reader announcements — see their doc comments in
`node_modules/@base-ui/react/combobox/{empty,status}/*.d.ts`); the `empty:m-0 empty:p-0` classes keep
an empty one from taking up visible space.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS. There's no dedicated test for this file — it's a styling wrapper with no logic of its
own, verified through Task 7's component test instead, exactly like `select.tsx` has no test file of
its own either (`ls src/components/ui/*.test.*` returns nothing today).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/ui/autocomplete.tsx
git commit -m "feat(ui): add the Autocomplete primitive wrapper"
```

---

### Task 7: The `<IdentifierAutocomplete>` component

**Files:**
- Create: `src/components/feeds/identifier-autocomplete.tsx`
- Test: `src/components/feeds/identifier-autocomplete.test.tsx`

**Interfaces:**
- Consumes: `Autocomplete`/`AutocompleteInput`/`AutocompletePopup`/`AutocompleteItem`/
  `AutocompleteEmpty`/`AutocompleteStatus` (Task 6); `searchFeedIdentifier` (Task 5);
  `attempt` from `@/lib/feeds/result` (Task 4).
- Produces:
  ```ts
  function IdentifierAutocomplete(props: {
    aggregator: "youtube" | "reddit";
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
  }): React.JSX.Element
  ```
  — consumed by Task 8's `feed-form.tsx`.

- [ ] **Step 1: Write the failing test**

Create `src/components/feeds/identifier-autocomplete.test.tsx`:

```tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";

import { renderWithProviders } from "@/test/render";
import { IdentifierAutocomplete } from "./identifier-autocomplete";

vi.mock("@/lib/aggregators/search", () => ({
  searchFeedIdentifier: vi.fn(),
}));

import { searchFeedIdentifier } from "@/lib/aggregators/search";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("IdentifierAutocomplete", () => {
  it("shows the stored identifier as plain text on load", () => {
    renderWithProviders(
      <IdentifierAutocomplete aggregator="youtube" value="UC123" onValueChange={vi.fn()} />,
    );
    expect(screen.getByRole("combobox")).toHaveValue("UC123");
  });

  it("searches after 2 characters and lets the user pick a result", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(searchFeedIdentifier).mockResolvedValue({
      ok: true,
      results: [{ value: "UC123", label: "Linus Tech Tips (@ltt)" }],
    });

    const onValueChange = vi.fn();
    renderWithProviders(
      <IdentifierAutocomplete aggregator="youtube" value="" onValueChange={onValueChange} />,
    );

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "linus" } });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    await waitFor(() => expect(searchFeedIdentifier).toHaveBeenCalledWith("youtube", "linus"));

    const item = await screen.findByText("Linus Tech Tips (@ltt)");
    fireEvent.pointerDown(item);
    fireEvent.click(item);

    expect(onValueChange).toHaveBeenCalledWith("UC123");
  });

  it("does not search below 2 characters", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithProviders(
      <IdentifierAutocomplete aggregator="reddit" value="" onValueChange={vi.fn()} />,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(searchFeedIdentifier).not.toHaveBeenCalled();
  });

  it("disables the input when disabled is passed", () => {
    renderWithProviders(
      <IdentifierAutocomplete aggregator="reddit" value="" onValueChange={vi.fn()} disabled />,
    );
    expect(screen.getByRole("combobox")).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/feeds/identifier-autocomplete.test.tsx`
Expected: FAIL with "Cannot find module './identifier-autocomplete'".

- [ ] **Step 3: Implement the component**

Create `src/components/feeds/identifier-autocomplete.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompletePopup,
  AutocompleteStatus,
} from "@/components/ui/autocomplete";
import { searchFeedIdentifier } from "@/lib/aggregators/search";
import { attempt } from "@/lib/feeds/result";

type Result = { value: string; label: string };

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

/**
 * The `search`-mode identifier field: type a query, get live YouTube
 * channel / Reddit subreddit results, click one to select it. `value` is the
 * real identifier (a channel id or a subreddit name) -- never shown as the
 * input's text once a result has been picked, since a picked result displays
 * its human-readable `label` instead. On mount, an existing feed's stored
 * `value` is shown as-is (no reverse lookup to a friendly label -- every
 * other identifier mode shows the raw stored value on load too).
 */
export function IdentifierAutocomplete({
  aggregator,
  value,
  onValueChange,
  disabled,
}: {
  aggregator: "youtube" | "reddit";
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("feeds");
  const [query, setQuery] = useState(value);
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestIdRef = useRef(0);

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  function handleQueryChange(nextQuery: string) {
    setQuery(nextQuery);
    clearTimeout(debounceRef.current);

    const trimmed = nextQuery.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setLoading(false);
      setOpen(false);
      return;
    }

    setLoading(true);
    setOpen(true);
    const requestId = ++requestIdRef.current;

    debounceRef.current = setTimeout(async () => {
      const attempted = await attempt(() => searchFeedIdentifier(aggregator, trimmed));
      if (requestId !== requestIdRef.current) return; // a newer keystroke already superseded this one
      setLoading(false);
      setResults(attempted.ok ? attempted.results : []);
    }, DEBOUNCE_MS);
  }

  function handleSelect(result: Result) {
    setQuery(result.label);
    setOpen(false);
    onValueChange(result.value);
  }

  return (
    <Autocomplete
      items={results}
      value={query}
      onValueChange={handleQueryChange}
      open={open}
      onOpenChange={setOpen}
      mode="none"
      disabled={disabled}
    >
      <AutocompleteInput placeholder={t("identifierSearch.placeholder")} />
      <AutocompletePopup>
        <AutocompleteStatus>{loading ? t("identifierSearch.loading") : null}</AutocompleteStatus>
        <AutocompleteEmpty>{!loading ? t("identifierSearch.empty") : null}</AutocompleteEmpty>
        {results.map((result) => (
          <AutocompleteItem
            key={result.value}
            value={result.value}
            onClick={() => handleSelect(result)}
          >
            {result.label}
          </AutocompleteItem>
        ))}
      </AutocompletePopup>
    </Autocomplete>
  );
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/components/feeds/identifier-autocomplete.test.tsx`
Expected: PASS, all 4 cases. If the click-selection test fails with nothing selected, check that the
test fires `pointerDown` before `click` on the item — Base UI's combobox/autocomplete item ignores a
bare `click` it didn't see a pointer press begin on (see the note on this exact issue for `<Select>`
in `CLAUDE.md`, "Driving one from a jsdom test takes a `pointerDown` before the item's `click`").

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/feeds/identifier-autocomplete.tsx src/components/feeds/identifier-autocomplete.test.tsx
git commit -m "feat(feeds): add the live-search identifier field for YouTube and Reddit"
```

---

### Task 8: Wire the four modes into `feed-form.tsx`

**Files:**
- Modify: `src/components/feeds/feed-form.tsx`
- Test: `src/components/feeds/feed-form.test.tsx` (new)

**Interfaces:**
- Consumes: `identifierModeFor`, `defaultIdentifierFor` (Task 2); `IdentifierAutocomplete` (Task 7).

- [ ] **Step 1: Write the failing test**

Create `src/components/feeds/feed-form.test.tsx`:

```tsx
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { FeedForm } from "./feed-form";

vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/feeds/actions", () => ({ createFeed: vi.fn(), updateFeed: vi.fn() }));
vi.mock("@/lib/aggregators/search", () => ({ searchFeedIdentifier: vi.fn() }));

const ALL: import("@/lib/aggregators/specs").Capabilities = { youtube: true, reddit: true, ai: true };
const NONE: import("@/lib/aggregators/specs").Capabilities = {
  youtube: false,
  reddit: false,
  ai: false,
};

function selectAggregator(label: string) {
  fireEvent.click(screen.getByLabelText("Aggregator"));
  const option = screen.getByRole("option", { name: label });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
}

describe("FeedForm identifier field", () => {
  it("renders nothing for a none-mode aggregator", () => {
    renderWithProviders(<FeedForm capabilities={ALL} allTags={[]} />);
    selectAggregator("Explosm");
    expect(screen.queryByLabelText("Feed")).not.toBeInTheDocument();
  });

  it("renders a plain text input for a url-mode aggregator", () => {
    renderWithProviders(<FeedForm capabilities={ALL} allTags={[]} />);
    selectAggregator("Full Website");
    expect(screen.getByLabelText("URL (Optional)")).toBeInTheDocument();
  });

  it("renders a dropdown for a choice-mode aggregator", () => {
    renderWithProviders(<FeedForm capabilities={ALL} allTags={[]} />);
    selectAggregator("Heise");
    expect(screen.getByRole("combobox", { name: "Feed (Optional)" })).toBeInTheDocument();
  });

  it("renders the autocomplete for a search-mode aggregator", () => {
    renderWithProviders(<FeedForm capabilities={ALL} allTags={[]} />);
    selectAggregator("YouTube");
    expect(screen.getByPlaceholderText("Type to search")).toBeInTheDocument();
  });

  it("resets the identifier to the new aggregator's default when switching", () => {
    renderWithProviders(<FeedForm capabilities={ALL} allTags={[]} />);
    selectAggregator("Heise");
    const heiseSelect = screen.getByRole("combobox", { name: "Feed (Optional)" });
    expect(heiseSelect).toHaveTextContent("Main Feed");

    selectAggregator("Merkur");
    const merkurSelect = screen.getByRole("combobox", { name: "Feed (Optional)" });
    expect(merkurSelect).toHaveTextContent("Main Feed");
  });

  it("hides youtube and reddit from the picker when neither integration is configured", () => {
    renderWithProviders(<FeedForm capabilities={NONE} allTags={[]} />);
    fireEvent.click(screen.getByLabelText("Aggregator"));
    expect(screen.queryByRole("option", { name: "YouTube" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Reddit" })).not.toBeInTheDocument();
  });

  it("keeps an existing feed's own aggregator in the picker, and disables the identifier field with a banner", () => {
    const feed = {
      id: 1,
      userId: "u1",
      name: "My Channel",
      aggregator: "youtube",
      identifier: "UC999",
      options: {},
      enabled: true,
      dailyLimit: 20,
      createdAt: new Date(),
      updatedAt: new Date(),
      tags: [],
    } as unknown as import("@/lib/db/schema").Feed & { tags: import("@/lib/db/schema").Tag[] };

    renderWithProviders(<FeedForm feed={feed} capabilities={NONE} allTags={[]} />);

    expect(screen.getByText(/integration is not configured/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type to search")).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/components/feeds/feed-form.test.tsx`
Expected: FAIL — every case fails because `feed-form.tsx` still renders the same plain `<Input>` for
every aggregator.

- [ ] **Step 3: Implement the changes in `feed-form.tsx`**

Change the imports at the top of `src/components/feeds/feed-form.tsx`:

```ts
import { AGGREGATOR_SPECS, visibleOptionsFor, type Capabilities } from "@/lib/aggregators/specs";
```

to:

```ts
import {
  AGGREGATOR_SPECS,
  defaultIdentifierFor,
  identifierModeFor,
  visibleOptionsFor,
  type Capabilities,
} from "@/lib/aggregators/specs";
import { IdentifierAutocomplete } from "./identifier-autocomplete";
```

Change `handleAggregatorChange` from:

```ts
  function handleAggregatorChange(newAggregator: string | null) {
    if (!newAggregator) return;
    const key = newAggregator as keyof typeof AGGREGATOR_SPECS;
    setAggregator(key);
    // Reset options to default for new aggregator
    const newSpec = AGGREGATOR_SPECS[key];
    const newOptions: Record<string, unknown> = {};
    if (newSpec) {
      for (const opt of newSpec.options) {
        newOptions[opt.key] = opt.default;
      }
    }
    setOptions(newOptions);
  }
```

to:

```ts
  function handleAggregatorChange(newAggregator: string | null) {
    if (!newAggregator) return;
    const key = newAggregator as keyof typeof AGGREGATOR_SPECS;
    setAggregator(key);
    // Reset options to default for new aggregator
    const newSpec = AGGREGATOR_SPECS[key];
    const newOptions: Record<string, unknown> = {};
    if (newSpec) {
      for (const opt of newSpec.options) {
        newOptions[opt.key] = opt.default;
      }
      setIdentifier(defaultIdentifierFor(newSpec));
    }
    setOptions(newOptions);
  }
```

Add, right after the `spec`/`visibleOptions` declarations:

```ts
  const spec = AGGREGATOR_SPECS[aggregator];
  const visibleOptions = visibleOptionsFor(aggregator, capabilities);
```

becomes:

```ts
  const spec = AGGREGATOR_SPECS[aggregator];
  const visibleOptions = visibleOptionsFor(aggregator, capabilities);
  const identifierMode = identifierModeFor(spec);

  const availableAggregators = Object.values(AGGREGATOR_SPECS).filter(
    (s) => !s.identifierSearch || capabilities[s.identifierSearch] || s.key === feed?.aggregator,
  );
  const identifierSearchUnavailable =
    identifierMode === "search" && spec.identifierSearch && !capabilities[spec.identifierSearch];
```

Change the aggregator `<Select>` block from:

```tsx
        <Select
          value={aggregator}
          onValueChange={handleAggregatorChange}
          items={Object.values(AGGREGATOR_SPECS).map((s) => ({ value: s.key, label: s.label }))}
          disabled={pending}
        >
          <SelectTrigger id="aggregator">
            <SelectValue placeholder={t("form.aggregatorPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {Object.values(AGGREGATOR_SPECS).map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
```

to:

```tsx
        <Select
          value={aggregator}
          onValueChange={handleAggregatorChange}
          items={availableAggregators.map((s) => ({ value: s.key, label: s.label }))}
          disabled={pending}
        >
          <SelectTrigger id="aggregator">
            <SelectValue placeholder={t("form.aggregatorPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {availableAggregators.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
```

Replace the whole identifier block:

```tsx
      {(spec.identifierRequired || spec.identifierLabel) && (
        <div className="grid gap-2">
          <Label htmlFor="identifier">
            {spec.identifierLabel}
            {!spec.identifierRequired && " (Optional)"}
          </Label>
          <Input
            id="identifier"
            required={spec.identifierRequired}
            autoComplete="off"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            disabled={pending}
          />
          {spec.identifierHelp && (
            <p className="text-sm text-muted-foreground">{spec.identifierHelp}</p>
          )}
        </div>
      )}
```

with:

```tsx
      {identifierMode === "url" && (
        <div className="grid gap-2">
          <Label htmlFor="identifier">
            {spec.identifierLabel}
            {!spec.identifierRequired && " (Optional)"}
          </Label>
          <Input
            id="identifier"
            required={spec.identifierRequired}
            autoComplete="off"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            disabled={pending}
          />
          {spec.identifierHelp && (
            <p className="text-sm text-muted-foreground">{spec.identifierHelp}</p>
          )}
        </div>
      )}

      {identifierMode === "choice" && (
        <div className="grid gap-2">
          <Label htmlFor="identifier">{spec.identifierLabel} (Optional)</Label>
          <Select
            value={identifier || defaultIdentifierFor(spec)}
            onValueChange={(val: string | null) => val && setIdentifier(val)}
            items={spec.identifierChoices}
            disabled={pending}
          >
            <SelectTrigger id="identifier">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {spec.identifierChoices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {spec.identifierHelp && (
            <p className="text-sm text-muted-foreground">{spec.identifierHelp}</p>
          )}
        </div>
      )}

      {identifierMode === "search" && (
        <div className="grid gap-2">
          <Label htmlFor="identifier">{spec.identifierLabel}</Label>
          <IdentifierAutocomplete
            aggregator={spec.identifierSearch as "youtube" | "reddit"}
            value={identifier}
            onValueChange={setIdentifier}
            disabled={pending || identifierSearchUnavailable}
          />
          {spec.identifierHelp && (
            <p className="text-sm text-muted-foreground">{spec.identifierHelp}</p>
          )}
          {identifierSearchUnavailable && (
            <div className="flex items-start gap-2 text-sm text-muted-foreground bg-secondary/50 p-3 rounded-md border border-border">
              <AlertCircle className="size-4 mt-0.5 shrink-0" />
              <span>
                {t("identifierSearch.unavailableBannerBefore")}{" "}
                <Link href="/integrations" className="underline hover:text-primary">
                  {t("identifierSearch.unavailableBannerLink")}
                </Link>
                {t("identifierSearch.unavailableBannerAfter")}
              </span>
            </div>
          )}
        </div>
      )}
```

This banner is translated (`t("identifierSearch.unavailable...")`, added in Task 4), unlike the
pre-existing `missingGuards` banner lower in this same file, which is hardcoded English and predates
this feature (see the "Post-plan note" at the end of this document). New code follows the project's
i18n rule regardless of what a neighboring, already-broken banner does — matching the neighbor's gap
would just be a second copy of the same defect. `t` here is the same `useTranslations("feeds")`
instance already bound at the top of the component (`const t = useTranslations("feeds");`); no new
import is needed.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/components/feeds/feed-form.test.tsx`
Expected: PASS, all 7 cases.

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Manual verification in the browser**

Run: `npm run dev`, open `/feeds/new`. Confirm: selecting "Explosm" shows no identifier field;
"Full Website" shows the free text field; "Heise" shows a dropdown of 4 named feeds; "YouTube" (only
visible if a YouTube API key is configured under `/integrations` — configure a throwaway one, or skip
this aggregator if that's not available) shows a search box that queries as you type.

- [ ] **Step 7: Commit**

```bash
git add src/components/feeds/feed-form.tsx src/components/feeds/feed-form.test.tsx
git commit -m "feat(feeds): switch the identifier field's shape per aggregator in the form"
```

---

### Task 9: Server-side identifier normalization and the capability gate

**Files:**
- Modify: `src/lib/feeds/actions.ts`
- Test: `src/lib/feeds/actions.test.ts`

**Interfaces:**
- Consumes: `identifierModeFor`, `defaultIdentifierFor` (Task 2).

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/feeds/actions.test.ts`, inside the existing `describe("createFeed", ...)` block, right
after the `"allows an empty identifier for a scraper"` test:

```ts
  it("snaps a choice-mode identifier to the default when the submitted value isn't a known choice", async () => {
    await currentUserId();
    const { id } = await actions.createFeed({
      name: "Heise",
      aggregator: "heise",
      identifier: "not-a-real-feed-url",
    });
    expect((await actions.getFeed(id!))?.identifier).toBe("https://www.heise.de/rss/heise.rdf");
  });

  it("keeps a submitted choice-mode identifier when it is a known choice", async () => {
    await currentUserId();
    const { id } = await actions.createFeed({
      name: "Heise Security",
      aggregator: "heise",
      identifier: "https://www.heise.de/rss/heise-security.rdf",
    });
    expect((await actions.getFeed(id!))?.identifier).toBe(
      "https://www.heise.de/rss/heise-security.rdf",
    );
  });

  it("always sets a none-mode identifier to its one fixed value", async () => {
    await currentUserId();
    const { id } = await actions.createFeed({ name: "X", aggregator: "explosm", identifier: "" });
    expect((await actions.getFeed(id!))?.identifier).toBe("https://explosm.net/rss.xml");
  });

  it("rejects a new reddit feed when the reddit integration is disabled", async () => {
    await currentUserId();
    const result = await actions.createFeed({
      name: "r/programming",
      aggregator: "reddit",
      identifier: "programming",
    });
    expect(result.ok).toBe(false);
  });

  it("creates a reddit feed once the reddit integration is enabled", async () => {
    await currentUserId();
    raw(client.getDb()).exec(`UPDATE user_settings SET reddit_enabled = 1`);
    const result = await actions.createFeed({
      name: "r/programming",
      aggregator: "reddit",
      identifier: "programming",
    });
    expect(result.ok).toBe(true);
  });
```

Then add a new `describe` block after the closing `});` of `describe("createFeed", ...)`:

```ts
describe("updateFeed", () => {
  let dbPath: string;
  let actions: typeof import("./actions");
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();
    cookieJar.clear();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-feeds-update-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    actions = await import("./actions");
    client = await import("@/lib/db/client");

    const user = await createUserWithPassword({
      email: "user@example.com",
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "user",
    });
    raw(client.getDb()).exec(`INSERT INTO user_settings (user_id) VALUES ('${user.id}')`);
    const cookie = await signInCookie(auth, { email: "user@example.com", password: PASSWORD });
    requestHeaders.current = new Headers({ cookie });
    cookieJar.clear();
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("keeps an existing reddit feed editable after the integration is later disabled", async () => {
    raw(client.getDb()).exec(`UPDATE user_settings SET reddit_enabled = 1`);
    const { id } = await actions.createFeed({
      name: "r/programming",
      aggregator: "reddit",
      identifier: "programming",
    });
    raw(client.getDb()).exec(`UPDATE user_settings SET reddit_enabled = 0`);

    const result = await actions.updateFeed(id!, { name: "r/programming (renamed)" });
    expect(result.ok).toBe(true);
    const updated = await actions.getFeed(id!);
    expect(updated?.name).toBe("r/programming (renamed)");
    // The subreddit must survive a rename that doesn't touch the identifier field at all.
    expect(updated?.identifier).toBe("programming");
  });

  it("rejects changing an existing feed's aggregator to reddit while it's disabled", async () => {
    const { id } = await actions.createFeed({ name: "X", aggregator: "heise" });
    const result = await actions.updateFeed(id!, {
      aggregator: "reddit",
      identifier: "programming",
    });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/feeds/actions.test.ts`
Expected: FAIL — the snapping/gating tests fail because `actions.ts` doesn't implement either yet.

- [ ] **Step 3: Implement the changes in `src/lib/feeds/actions.ts`**

Change the import from `@/lib/aggregators/specs`:

```ts
import {
  AGGREGATOR_SPECS,
  schemaFor,
  stripUnavailable,
  type Capabilities,
} from "@/lib/aggregators/specs";
```

to:

```ts
import {
  AGGREGATOR_SPECS,
  defaultIdentifierFor,
  identifierModeFor,
  schemaFor,
  stripUnavailable,
  type AggregatorSpec,
  type Capabilities,
} from "@/lib/aggregators/specs";
```

Add this function right after `capabilitiesFor`:

```ts
/**
 * Snaps a `none`/`choice`-mode identifier to one of its known choices,
 * falling back to the default when the submitted value is empty or isn't
 * one of them. Mirrors Python's `normalize_identifier()`. `url`/`search`
 * modes pass through unchanged -- there's no fixed set to validate against.
 */
function normalizeIdentifier(spec: AggregatorSpec, identifier: string): string {
  const mode = identifierModeFor(spec);
  if (mode !== "none" && mode !== "choice") return identifier;

  const validValues = new Set(spec.identifierChoices.map((choice) => choice.value));
  return validValues.has(identifier) ? identifier : defaultIdentifierFor(spec);
}
```

In `createFeed`, change:

```ts
    const name = input?.name;
    const aggregator = input?.aggregator;
    const identifier = input?.identifier || "";
    const options = input?.options || {};
    const tagIds = input?.tagIds || [];

    if (!name) return { ok: false, field: "name", error: "Name is required" };
    if (!aggregator) return { ok: false, field: "aggregator", error: "Aggregator is required" };

    const spec = AGGREGATOR_SPECS[aggregator as keyof typeof AGGREGATOR_SPECS];
    if (!spec) return { ok: false, error: "Invalid aggregator" };

    if (spec.identifierRequired && !identifier) {
      return { ok: false, field: "identifier", error: "Identifier is required" };
    }

    const optionsParsed = schemaFor(spec.key).safeParse(options);
    if (!optionsParsed.success) {
      return { ok: false, error: "Invalid options" };
    }

    const capabilities = await capabilitiesFor();
    const cleanedOptions = stripUnavailable(
      spec.key,
      optionsParsed.data as Record<string, unknown>,
      capabilities,
    );
```

to:

```ts
    const name = input?.name;
    const aggregator = input?.aggregator;
    const options = input?.options || {};
    const tagIds = input?.tagIds || [];

    if (!name) return { ok: false, field: "name", error: "Name is required" };
    if (!aggregator) return { ok: false, field: "aggregator", error: "Aggregator is required" };

    const spec = AGGREGATOR_SPECS[aggregator as keyof typeof AGGREGATOR_SPECS];
    if (!spec) return { ok: false, error: "Invalid aggregator" };

    const identifier = normalizeIdentifier(spec, input?.identifier || "");

    if (spec.identifierRequired && !identifier) {
      return { ok: false, field: "identifier", error: "Identifier is required" };
    }

    const optionsParsed = schemaFor(spec.key).safeParse(options);
    if (!optionsParsed.success) {
      return { ok: false, error: "Invalid options" };
    }

    const capabilities = await capabilitiesFor();

    if (spec.identifierSearch && !capabilities[spec.identifierSearch]) {
      return { ok: false, error: "Invalid aggregator" };
    }

    const cleanedOptions = stripUnavailable(
      spec.key,
      optionsParsed.data as Record<string, unknown>,
      capabilities,
    );
```

In `updateFeed`, change:

```ts
  const name = input?.name;
  const aggregator = input?.aggregator;
  const identifier = input?.identifier || "";
  const options = input?.options || {};
  const tagIds = input?.tagIds || [];
  const enabled = input?.enabled;

  const feed = await getFeed(id);
  if (!feed) return { ok: false, error: "Not found" };

  const targetAggregator = aggregator || feed.aggregator;
  const spec = AGGREGATOR_SPECS[targetAggregator as keyof typeof AGGREGATOR_SPECS];
  if (!spec) return { ok: false, error: "Invalid aggregator" };

  if (spec.identifierRequired && !identifier && !feed.identifier) {
    return { ok: false, field: "identifier", error: "Identifier is required" };
  }

  const optionsParsed = schemaFor(spec.key).safeParse(options);
  if (!optionsParsed.success) {
    return { ok: false, error: "Invalid options" };
  }

  const capabilities = await capabilitiesFor();
  const cleanedOptions = stripUnavailable(
    spec.key,
    optionsParsed.data as Record<string, unknown>,
    capabilities,
  );
```

to:

```ts
  const name = input?.name;
  const aggregator = input?.aggregator;
  const options = input?.options || {};
  const tagIds = input?.tagIds || [];
  const enabled = input?.enabled;

  const feed = await getFeed(id);
  if (!feed) return { ok: false, error: "Not found" };

  const targetAggregator = aggregator || feed.aggregator;
  const spec = AGGREGATOR_SPECS[targetAggregator as keyof typeof AGGREGATOR_SPECS];
  if (!spec) return { ok: false, error: "Invalid aggregator" };

  /**
   * `undefined` means "the caller didn't submit this field, leave the
   * stored value alone" -- distinct from an explicitly empty string, which
   * is a request to clear it (and, for `none`/`choice` modes,
   * `normalizeIdentifier` snaps that back to the aggregator's default
   * rather than actually clearing it). This distinction is deliberately
   * *new*: the pre-existing `const identifier = input?.identifier || ""`
   * collapsed "omitted" and "submitted empty" into the same string, which
   * made the `identifier !== undefined` guard on the `.set()` call below
   * always true -- so calling `updateFeed(id, { name: "..." })` with no
   * `identifier` field silently wiped the feed's stored identifier to `""`
   * on every save. Nothing caught it: this file had no `updateFeed` test at
   * all before this task. Fixed here because it sits directly on the code
   * path this task is already restructuring, and left alone it would have
   * made the "keeps an existing reddit feed editable" test (Step 1, above) pass while
   * actually erasing that feed's subreddit on every rename.
   */
  const identifier =
    input?.identifier !== undefined ? normalizeIdentifier(spec, input.identifier) : undefined;

  if (spec.identifierRequired && !identifier && !feed.identifier) {
    return { ok: false, field: "identifier", error: "Identifier is required" };
  }

  const optionsParsed = schemaFor(spec.key).safeParse(options);
  if (!optionsParsed.success) {
    return { ok: false, error: "Invalid options" };
  }

  const capabilities = await capabilitiesFor();

  const isAggregatorChange = aggregator !== undefined && aggregator !== feed.aggregator;
  if (isAggregatorChange && spec.identifierSearch && !capabilities[spec.identifierSearch]) {
    return { ok: false, error: "Invalid aggregator" };
  }

  const cleanedOptions = stripUnavailable(
    spec.key,
    optionsParsed.data as Record<string, unknown>,
    capabilities,
  );
```

`createFeed` already uses the local `identifier` further down (in the `.values({...})` call) with no
change needed there. `updateFeed`'s existing `.set({ ...(identifier !== undefined && { identifier }), ... })`
also needs no change to its own line — it's unchanged from today's code — but its behavior does
change, correctly, now that `identifier` can genuinely be `undefined`: an update that omits
`identifier` no longer overwrites the stored value.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/feeds/actions.test.ts`
Expected: PASS, both the pre-existing tests (unchanged behavior) and every new one.

- [ ] **Step 5: Full verification**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: PASS across the board — this is the full CI gate from `CLAUDE.md`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/feeds/actions.ts src/lib/feeds/actions.test.ts
git commit -m "feat(feeds): normalize none/choice identifiers server-side and gate youtube/reddit on capability"
```

---

## Post-plan note

The `missingGuards` banner in `feed-form.tsx` (the "Some options are hidden because the {guard}
integration is not configured" text) predates this feature and is hardcoded English, never routed
through the catalog — a pre-existing gap this plan's own new banner deliberately matches rather than
fixes (see Task 8, Step 3's note). Fixing both banners' i18n together is a separate, small,
well-scoped follow-up worth flagging once this plan lands.
