# Phase 9: Feeds CRUD — Implementation Plan

> **Path note (post folder swap):** the Next.js app is the repository root and the
> Django tree is `old/`. Read Python paths below — `core/…`, `yana/…` — as
> `old/core/…` / `old/yana/…`, and treat `uv run …` commands as historical: `old/`
> is read-only reference and is not runnable as configured.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A feeds tab where creating a feed starts with an aggregator choice that reshapes the rest of the form, options unavailable for lack of an integration or AI credentials are hidden, a logo is collected on create, and "update logo" is available as a bulk action.

**Architecture:** The centrepiece is the **Zod option registry** the direction record specifies: one declaration per aggregator that simultaneously validates `feeds.options`, types it, and generates the form body. That is what makes the form reshape on aggregator change without a hand-written form per type, and what makes the `requires` guard a property of an option rather than scattered conditionals. Everything else is phase 5's CRUD kit with a richer form.

**Tech Stack:** Phase 5's CRUD kit, Zod, Drizzle, `sharp`, phase 8's `listTags`.

## Global Constraints

- One registry entry per aggregator in `AGGREGATOR_KEYS`. A missing entry must fail a test, not degrade to a blank form.
- Option **`requires` guards** read the probe-derived flags from phases 6–7 (`youtubeEnabled`, `redditEnabled`, `activeAiProvider !== ""`). A guarded option that is unmet is hidden *and* stripped from submitted values — hiding it in the UI alone leaves it settable by a crafted request.
- Owner-scoped like phase 8: another user's feed id behaves as nonexistent.
- Logo collection **must not block feed creation**. A site with no discoverable icon still yields a working feed; the logo is enqueued, not awaited.
- Logos are re-encoded through `sharp` before storage, for the same reason phase 4 re-encodes avatars.
- `identifier` is required for `reddit` and `youtube` and optional elsewhere — enforced per aggregator by the registry, not by a special case in the form.
- Tags are a multi-select writing `feed_tags` rows. Phase 2 made this many-per-feed; do not reintroduce a single-tag assumption.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/aggregators/registry.ts` | `AGGREGATOR_SPECS` — the option registry |
| `src/lib/aggregators/options.ts` | `schemaFor`, `visibleOptionsFor`, `stripUnavailable` |
| `src/lib/feeds/queries.ts` | `listFeeds`, `getFeed` |
| `src/lib/feeds/actions.ts` | `createFeed`, `updateFeed`, `deleteFeeds`, `refreshLogos` |
| `src/lib/feeds/logo.ts` | `discoverLogo`, `storeLogo` |
| `src/app/(app)/feeds/{page,new/page,[id]/page}.tsx` | Routes |
| `src/components/feeds/aggregator-picker.tsx` | Step one of create |
| `src/components/feeds/option-fields.tsx` | Registry-driven form body |
| `src/components/feeds/feed-form.tsx` | Shared create/edit form |

---

### Task 1: The option registry

**Interfaces:**
- Produces:
  - `type OptionSpec = { key: string; label: string; kind: "boolean" | "number" | "text" | "select" | "selectorList"; default: unknown; help?: string; options?: { value: string; label: string }[]; requires?: "youtube" | "reddit" | "ai" }`
  - `type AggregatorSpec = { key: AggregatorKey; label: string; identifierRequired: boolean; identifierLabel: string; identifierHelp: string; options: OptionSpec[] }`
  - `AGGREGATOR_SPECS: Record<AggregatorKey, AggregatorSpec>`
  - `schemaFor(key: AggregatorKey): z.ZodType` — built from the spec, so validation and form never diverge
  - `visibleOptionsFor(key: AggregatorKey, capabilities: Capabilities): OptionSpec[]`
  - `stripUnavailable(key: AggregatorKey, values: Record<string, unknown>, capabilities: Capabilities): Record<string, unknown>`
  - `type Capabilities = { youtube: boolean; reddit: boolean; ai: boolean }`

- [ ] **Step 1: Extract the real option keys from Python**

The registry must describe the options that actually exist. Do not invent them.

```bash
cd /Users/skrug/PycharmProjects/yana-server
grep -rhoE "options\.get\(\s*.[a-z_]+" core --include='*.py' | grep -oE "[a-z_]{3,}$" | sort -u
grep -rn "content_selectors\|selectors_to_remove\|uses_first_content_match" core/aggregators/*.py core/aggregators/*/*.py | grep -v __pycache__ | head -20
```

For each aggregator class, record which options it actually reads — including inherited ones from `FullWebsiteAggregator`. An option in the registry that no aggregator reads is dead UI; one that is read but absent is a silently ignored setting.

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/aggregators/registry.test.ts
import { describe, expect, it } from "vitest";

import { AGGREGATOR_KEYS } from "@/lib/db/schema";

import { AGGREGATOR_SPECS, schemaFor, stripUnavailable, visibleOptionsFor } from "./registry";

const ALL = { youtube: true, reddit: true, ai: true };
const NONE = { youtube: false, reddit: false, ai: false };

describe("AGGREGATOR_SPECS", () => {
  it("covers every aggregator key", () => {
    for (const key of AGGREGATOR_KEYS) {
      expect(AGGREGATOR_SPECS[key], `no spec for ${key}`).toBeDefined();
    }
  });

  it("requires an identifier for reddit and youtube only", () => {
    expect(AGGREGATOR_SPECS.reddit.identifierRequired).toBe(true);
    expect(AGGREGATOR_SPECS.youtube.identifierRequired).toBe(true);
    expect(AGGREGATOR_SPECS.heise.identifierRequired).toBe(false);
  });

  it("gives every option a unique key within its aggregator", () => {
    for (const key of AGGREGATOR_KEYS) {
      const keys = AGGREGATOR_SPECS[key].options.map((option) => option.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("visibleOptionsFor", () => {
  it("hides AI options when no provider is configured", () => {
    const visible = visibleOptionsFor("heise", NONE).map((option) => option.key);
    expect(visible).not.toContain("ai_summarize");
  });

  it("shows them once a provider is configured", () => {
    expect(visibleOptionsFor("heise", ALL).map((o) => o.key)).toContain("ai_summarize");
  });
});

describe("stripUnavailable", () => {
  it("removes a guarded option a crafted request tried to set", () => {
    // Hiding a field in the UI does not stop anyone from submitting it.
    const cleaned = stripUnavailable("heise", { ai_summarize: true, skip_ads: true }, NONE);
    expect(cleaned).not.toHaveProperty("ai_summarize");
    expect(cleaned).toHaveProperty("skip_ads");
  });

  it("drops keys the aggregator does not declare at all", () => {
    expect(stripUnavailable("heise", { nonsense: 1 }, ALL)).not.toHaveProperty("nonsense");
  });
});

describe("schemaFor", () => {
  it("applies declared defaults for absent values", () => {
    const parsed = schemaFor("podcast").parse({});
    expect(parsed).toHaveProperty("include_download_link");
  });

  it("rejects a boolean option given a string", () => {
    expect(() => schemaFor("heise").parse({ skip_ads: "yes" })).toThrow();
  });
});
```

- [ ] **Step 3: Implement**

`schemaFor` builds a `z.object` from the spec's options by mapping `kind` to a Zod type with `.default(spec.default)`, then `.strip()` so unknown keys are discarded rather than rejected — a stored feed whose option was removed from the registry must still load.

`selectorList` is the CSS-selector list type the Python `SelectorListField` handles: a newline- or comma-separated string parsed to `string[]`.

- [ ] **Step 4: Run and commit**

```bash
npm test -- registry
git add -A && git commit -m "feat(next): Add the aggregator option registry

One declaration per aggregator drives validation, typing and the form body, so the
three cannot drift apart. A test asserts every aggregator key has a spec -- a
missing one would otherwise degrade to a blank form.

stripUnavailable removes guarded options server-side, because hiding a field in the
UI does not stop anyone submitting it. Schemas strip unknown keys rather than
rejecting, so a feed stored before an option was retired still loads."
```

---

### Task 2: Logo collection

**Interfaces:**
- Produces:
  - `discoverLogo(siteUrl: string): Promise<{ url: string; bytes: Buffer } | null>`
  - `storeLogo(feedId: number, bytes: Buffer, sourceUrl: string): Promise<string>` — returns the stored path

- [ ] **Step 1: Read the Python implementation**

```bash
cd /Users/skrug/PycharmProjects/yana-server
sed -n '1,80p' core/aggregators/utils/favicon.py
sed -n '1,60p' core/aggregators/feed_logo.py
sed -n '1,60p' core/aggregators/utils/logo_background.py
```

Three behaviours to carry over: the icon-source preference order, the size preference, and the white-background removal. The last is the non-obvious one — many favicons are a logo on solid white, which looks wrong on a dark sidebar.

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/feeds/logo.test.ts
import { describe, expect, it } from "vitest";

import { pickBestIcon, removeWhiteBackground } from "./logo";

describe("pickBestIcon", () => {
  it("prefers a larger declared size", () => {
    const chosen = pickBestIcon([
      { href: "/small.png", sizes: "16x16", rel: "icon" },
      { href: "/large.png", sizes: "180x180", rel: "apple-touch-icon" },
    ]);
    expect(chosen?.href).toBe("/large.png");
  });

  it("treats sizes=any as best", () => {
    const chosen = pickBestIcon([
      { href: "/png.png", sizes: "48x48", rel: "icon" },
      { href: "/svg.svg", sizes: "any", rel: "icon" },
    ]);
    expect(chosen?.href).toBe("/svg.svg");
  });

  it("returns null when there is nothing to pick", () => {
    expect(pickBestIcon([])).toBeNull();
  });
});

describe("removeWhiteBackground", () => {
  it("makes near-white pixels transparent", async () => {
    const output = await removeWhiteBackground(await solidWhitePng());
    expect(await hasTransparency(output)).toBe(true);
  });

  it("leaves an image that is already transparent alone", async () => {
    const input = await transparentPng();
    expect(await removeWhiteBackground(input)).toEqual(input);
  });
});
```

- [ ] **Step 3: Implement**

`discoverLogo` fetches the site, parses `<link rel="icon">` / `apple-touch-icon` / `manifest` entries with cheerio, falls back to `/favicon.ico`, picks with `pickBestIcon`, fetches the bytes with a **2 MB cap and an explicit timeout**, and returns `null` on any failure rather than throwing — a missing logo is not a feed-creation failure.

`storeLogo` runs the bytes through `sharp` (resize to 128×128 contain, `removeWhiteBackground`, encode WebP), writes to `media/feed_logos/<feedId>.webp`, and sets `feeds.logo` and `feeds.logoSourceUrl`.

- [ ] **Step 4: Run and commit**

```bash
npm test -- logo
git add -A && git commit -m "feat(next): Add feed logo discovery and storage

White-background removal is ported from the Python: many favicons are a logo on
solid white, which looks wrong on a dark sidebar. An already-transparent image is
returned untouched.

discoverLogo returns null rather than throwing -- a site with no discoverable icon
must still produce a working feed."
```

---

### Task 3: Queries, actions and the form

**Interfaces:**
- Produces:
  - `listFeeds(params: ListParams): Promise<{ rows: (Feed & { tags: Tag[]; articleCount: number })[]; total: number }>`
  - `getFeed(id: number): Promise<(Feed & { tags: Tag[] }) | null>`
  - `createFeed(input: unknown): Promise<{ ok: boolean; error?: string; field?: string; id?: number }>`
  - `updateFeed(id: number, input: unknown)`, `deleteFeeds(ids: number[])`
  - `refreshLogos(ids: number[]): Promise<{ ok: boolean; enqueued: number }>` — the bulk action
  - `capabilitiesFor(): Promise<Capabilities>` — derived from `userSettings`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/feeds/actions.test.ts
describe("createFeed", () => {
  it("requires an identifier for reddit", async () => {
    const result = await createFeed({ name: "r/x", aggregator: "reddit", identifier: "" });
    expect(result).toMatchObject({ ok: false, field: "identifier" });
  });

  it("allows an empty identifier for a scraper", async () => {
    expect((await createFeed({ name: "Heise", aggregator: "heise", identifier: "" })).ok).toBe(true);
  });

  it("strips an option whose integration is unconfigured", async () => {
    const { id } = await createFeed({
      name: "X", aggregator: "heise", options: { ai_summarize: true },
    });
    expect((await getFeed(id!))?.options).not.toHaveProperty("ai_summarize");
  });

  it("succeeds even when logo discovery fails", async () => {
    // Logo collection is enqueued, never awaited on the create path.
    mockLogoDiscoveryToThrow();
    expect((await createFeed({ name: "X", aggregator: "heise" })).ok).toBe(true);
  });

  it("attaches multiple tags", async () => {
    const a = await createTag({ name: "A" });
    const b = await createTag({ name: "B" });
    const { id } = await createFeed({ name: "X", aggregator: "heise", tagIds: [a.id, b.id] });
    expect((await getFeed(id!))?.tags).toHaveLength(2);
  });

  it("rejects another user's tag id", async () => {
    const foreign = await tagIdBelongingToAnotherUser();
    expect((await createFeed({ name: "X", aggregator: "heise", tagIds: [foreign] })).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

`createFeed` order matters: validate base fields → `stripUnavailable` on options → verify every `tagId` belongs to the caller → insert feed → insert `feed_tags` → **enqueue** a logo job. All inside `writeTransaction` from phase 1 except the enqueue, which is its own row.

Until phase 12's worker exists, `refreshLogos` and the create-path logo step insert `jobs` rows with kind `feed.logo` that nothing yet consumes. That is deliberate: the queue contract lands here and the consumer lands in 12, rather than building a temporary synchronous path that gets deleted.

- [ ] **Step 3: Build the form**

Create is two stages on one route: `<AggregatorPicker>` first, then the body. Changing the aggregator resets options to the new spec's defaults and keeps name, identifier and tags — those are aggregator-independent, and silently discarding a typed name is worse than a reset.

`<OptionFields>` maps `visibleOptionsFor(aggregator, capabilities)` to inputs by `kind`. When an option is hidden by a `requires` guard, render nothing — but show one line per unmet capability explaining why options are missing and linking to `/integrations` or `/ai`. A silently shorter form reads as a bug.

- [ ] **Step 4: The list page and bulk actions**

Columns: logo, name, aggregator, tags, article count, enabled. Filters: aggregator, enabled, tag. Bulk actions: **delete** (confirmed, stating article counts) and **update logo** (enqueues, toasts the count).

- [ ] **Step 5: Verify by hand**

Create one feed per aggregator type and confirm the form reshapes. With integrations off, confirm YouTube/Reddit/AI options are absent and the explanation appears. Submit a crafted request setting a guarded option and confirm it is stripped. Create a feed for a real site and confirm a logo appears.

- [ ] **Step 6: Run every check and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
git add -A && git commit -m "feat(next): Add the feeds tab with a registry-driven form

The aggregator choice reshapes the body from the option registry, so there is one
form rather than sixteen. Changing aggregator resets options to the new defaults
but keeps name, identifier and tags -- discarding a typed name silently is worse
than a reset.

Unmet capability guards hide options and say why, with a link to the relevant tab:
a silently shorter form reads as a bug. Logo collection enqueues a job rather than
blocking creation, so a site with no icon still yields a working feed. Those jobs
have no consumer until phase 12, which is deliberate -- the queue contract lands
here rather than building a synchronous path to delete later."
```

---

## Self-Review

**Spec coverage.** Against bullet 9: CRUD like tags (Tasks 3–4, phase 5's kit), aggregator choice at top reshaping the body (Task 3), options hidden when integration or AI is unconfigured (Tasks 1, 3), logo collected on create (Tasks 2–3), update logo as a bulk action (Task 3 Step 4). Complete.

**Placeholder scan.** Task 1 Step 1 and Task 2 Step 1 direct the engineer to read the Python rather than trusting this document — necessary, because the true option set per aggregator and the icon-preference order were not fully enumerated while writing this plan, and inventing either would produce dead UI or a wrong logo. The registry's *structure* and every guard rule are fully specified.

**Type consistency.** `Capabilities` is declared in Task 1 and consumed by `visibleOptionsFor`, `stripUnavailable` and `capabilitiesFor`. `ListParams` and the CRUD kit come from phase 5. `Tag` from phase 2 via phase 8's `listTags`. Ids are `number`, `String(row.id)` at the table boundary, as in phase 8. `{ ok, error?, field? }` matches phase 8's widened convention.

**One dependency inversion to note.** This phase writes `jobs` rows before phase 12 builds the worker, so `feeds.logo` stays null until then. Phase 12 must therefore include a step that drains the backlog those rows represent, rather than assuming the queue starts empty.
