# Feeds OPML Import/Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user export their feeds to an OPML file and import an OPML file back into their feed list, from the `/feeds` page.

**Architecture:** A pure codec module (`src/lib/feeds/opml.ts`) handles the XML wire format. Two new server actions in `src/lib/feeds/actions.ts` (`previewOpmlImport`, `importOpmlFeeds`) share a classification helper that resolves each OPML entry's aggregator, validates it, and checks for duplicates. A new GET route handler (`src/app/api/feeds/export/route.ts`) streams the OPML file for download, since server actions here only return JSON. Two small UI additions wire it into `/feeds`: a preview-then-confirm import dialog, and export links on the page header and the existing bulk action bar.

**Tech Stack:** Next.js 16 server actions + route handlers, Drizzle/better-sqlite3, `cheerio` (already a dependency, used in `xmlMode`) for XML parsing, Vitest (`node` project for real-SQLite tests, `dom` project for the one new component test).

Full design: `docs/superpowers/specs/2026-08-10-feeds-opml-import-export-design.md`.

## Global Constraints

- Prettier owns formatting: line length 100, double quotes, semicolons, trailing commas. Run `npm run format` after each task.
- `@/*` maps to `src/*`.
- Every database write goes through `writeTransaction()` (`src/lib/db/client.ts`); its callback must be synchronous.
- A server action's result type is `{ ok, errorKey? }` where `errorKey` is a `NamespaceKey<Namespace>` (`src/lib/attempt.ts`) — never a raw English or driver message.
- Every user-facing string is added to **both** `messages/en.json` and `messages/de.json`, with identical key sets (`src/i18n/messages.test.ts` enforces this).
- The file extension picks the vitest project: `.test.ts` → `node` (real SQLite, no mocked driver); `.test.tsx` → `dom` (jsdom + Testing Library). Never swap them.
- No server action is ever awaited bare from a client component — always through the feature's `attempt()` binding (here, `src/lib/feeds/result.ts`).
- A route handler outside `(app)` authenticates itself with `requireUser()`/`requireAdmin()` — nothing above a route handler does.
- Before the final commit of this plan: `npm run lint && npm run format:check && npm run typecheck && npm test` must all pass.

---

## File Structure

- **Create** `src/lib/feeds/opml.ts` — pure OPML 2.0 encode/decode, no DB/auth.
- **Create** `src/lib/feeds/opml.test.ts` — codec tests.
- **Modify** `src/lib/feeds/actions.ts` — add `resolveOpmlEntries` (internal), `previewOpmlImport`, `importOpmlFeeds`.
- **Modify** `src/lib/feeds/actions.test.ts` — add tests for the two new actions.
- **Create** `src/app/api/feeds/export/route.ts` — `GET`, cookie-authenticated OPML download.
- **Create** `src/app/api/feeds/export/route.test.ts` — route tests.
- **Create** `src/components/feeds/import-opml-button.tsx` — file picker + preview/confirm dialog.
- **Create** `src/components/feeds/import-opml-button.test.tsx` — component test.
- **Modify** `src/components/feeds/feeds-table.tsx` — add the "Export OPML" bulk action.
- **Modify** `src/app/(app)/feeds/page.tsx` — add "Export all" link and `<ImportOpmlButton>`.
- **Modify** `messages/en.json`, `messages/de.json` — new `feeds` namespace keys, added incrementally per task.

---

### Task 1: OPML codec

**Files:**
- Create: `src/lib/feeds/opml.ts`
- Test: `src/lib/feeds/opml.test.ts`

**Interfaces:**
- Produces: `OpmlExportFeed` (type), `OpmlEntry` (type), `encodeOpml(feeds: OpmlExportFeed[]): string`, `decodeOpml(xml: string): OpmlEntry[]` (throws `Error` when the file has no `<opml>`/`<body>` structure at all), `decodeOpmlOptions(base64: string): Record<string, unknown> | null`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/feeds/opml.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { decodeOpml, decodeOpmlOptions, encodeOpml, type OpmlExportFeed } from "./opml";

describe("encodeOpml / decodeOpml", () => {
  it("round-trips every field", () => {
    const feed: OpmlExportFeed = {
      name: "Heise",
      aggregator: "full_website",
      identifier: "https://www.heise.de/rss/heise-atom.xml",
      enabled: true,
      dailyLimit: 20,
      updateIntervalMinutes: 30,
      concurrency: 4,
      maxArticleAgeDays: 30,
      options: { ai_summarize: true },
      tags: ["Tech", "News"],
    };

    const xml = encodeOpml([feed]);
    const [entry] = decodeOpml(xml);

    expect(entry.name).toBe("Heise");
    expect(entry.identifier).toBe(feed.identifier);
    expect(entry.aggregatorType).toBe("full_website");
    expect(entry.enabled).toBe(true);
    expect(entry.dailyLimit).toBe(20);
    expect(entry.updateIntervalMinutes).toBe(30);
    expect(entry.concurrency).toBe(4);
    expect(entry.maxArticleAgeDays).toBe(30);
    expect(entry.tags).toEqual(["Tech", "News"]);
    expect(decodeOpmlOptions(entry.optionsBase64 as string)).toEqual({ ai_summarize: true });
  });

  it("omits yana:tags and yana:options when there is nothing to carry", () => {
    const feed: OpmlExportFeed = {
      name: "Plain",
      aggregator: "feed_content",
      identifier: "https://example.com/feed.xml",
      enabled: true,
      dailyLimit: 20,
      updateIntervalMinutes: 30,
      concurrency: 4,
      maxArticleAgeDays: 30,
      options: {},
      tags: [],
    };

    const xml = encodeOpml([feed]);
    expect(xml).not.toContain("yana:tags");
    expect(xml).not.toContain("yana:options");

    const [entry] = decodeOpml(xml);
    expect(entry.tags).toEqual([]);
    expect(entry.optionsBase64).toBeUndefined();
  });

  it("decodes foreign OPML with no yana: attributes at all", () => {
    const xml = `<?xml version="1.0"?>
<opml version="2.0">
  <body>
    <outline text="A Blog" xmlUrl="https://example.com/rss" type="rss" />
  </body>
</opml>`;

    const [entry] = decodeOpml(xml);
    expect(entry.name).toBe("A Blog");
    expect(entry.identifier).toBe("https://example.com/rss");
    expect(entry.aggregatorType).toBeUndefined();
    expect(entry.tags).toEqual([]);
  });

  it("skips an outline with neither a name nor an identifier", () => {
    const xml = `<opml version="2.0"><body><outline type="rss" /></body></opml>`;
    expect(decodeOpml(xml)).toEqual([]);
  });

  it("throws on a file with no <opml>/<body> structure", () => {
    expect(() => decodeOpml("<html><body>not opml</body></html>")).toThrow();
  });
});

describe("decodeOpmlOptions", () => {
  it("decodes a base64-encoded JSON object", () => {
    const encoded = Buffer.from(JSON.stringify({ a: 1 })).toString("base64");
    expect(decodeOpmlOptions(encoded)).toEqual({ a: 1 });
  });

  it("returns null for invalid base64/JSON", () => {
    expect(decodeOpmlOptions("not-valid-base64-json!!!")).toBeNull();
  });

  it("returns null when the decoded JSON is not an object", () => {
    const encoded = Buffer.from(JSON.stringify([1, 2, 3])).toString("base64");
    expect(decodeOpmlOptions(encoded)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/feeds/opml.test.ts`
Expected: FAIL — `Cannot find module './opml'`.

- [ ] **Step 3: Implement the codec**

Create `src/lib/feeds/opml.ts`:

```ts
/**
 * Pure OPML 2.0 codec for feed import/export — no database, no auth, no
 * Next.js APIs. The `yana:` extension namespace carries everything OPML has
 * no slot for (aggregator type, per-feed scheduling, tags, aggregator
 * options) so a Yana-to-Yana round trip is lossless, while the file stays
 * valid, useful OPML for any other reader: unknown `yana:*` attributes are
 * simply ignored elsewhere. See
 * docs/superpowers/specs/2026-08-10-feeds-opml-import-export-design.md.
 *
 * `decodeOpml()` throws only when the file has no `<opml>`/`<body>`
 * structure at all — a single `<outline>` it can't make sense of (no name,
 * no identifier) is skipped instead, so one bad entry doesn't sink an
 * otherwise-good file.
 *
 * A declared `yana:options` blob is carried back as `optionsBase64`, not
 * decoded here: turning it into a validated options object needs
 * `schemaFor()` from `@/lib/aggregators/specs`, which is domain logic this
 * module deliberately knows nothing about. `decodeOpmlOptions()` only
 * reverses the wire encoding (base64 JSON) `encodeOpml()` applied.
 */
import * as cheerio from "cheerio";

export type OpmlExportFeed = {
  name: string;
  aggregator: string;
  identifier: string;
  enabled: boolean;
  dailyLimit: number;
  updateIntervalMinutes: number;
  concurrency: number;
  maxArticleAgeDays: number;
  options: Record<string, unknown>;
  tags: string[];
};

export type OpmlEntry = {
  name: string;
  identifier: string;
  aggregatorType?: string;
  enabled?: boolean;
  dailyLimit?: number;
  updateIntervalMinutes?: number;
  concurrency?: number;
  maxArticleAgeDays?: number;
  optionsBase64?: string;
  tags: string[];
};

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function encodeOpml(feeds: OpmlExportFeed[]): string {
  const outlines = feeds
    .map((feed) => {
      const attrs = [
        `text="${escapeAttr(feed.name)}"`,
        `title="${escapeAttr(feed.name)}"`,
        `type="rss"`,
        `xmlUrl="${escapeAttr(feed.identifier)}"`,
        `yana:aggregatorType="${escapeAttr(feed.aggregator)}"`,
        `yana:enabled="${feed.enabled}"`,
        `yana:dailyLimit="${feed.dailyLimit}"`,
        `yana:updateIntervalMinutes="${feed.updateIntervalMinutes}"`,
        `yana:concurrency="${feed.concurrency}"`,
        `yana:maxArticleAgeDays="${feed.maxArticleAgeDays}"`,
      ];
      if (feed.tags.length > 0) {
        attrs.push(`yana:tags="${escapeAttr(feed.tags.join(","))}"`);
      }
      if (Object.keys(feed.options).length > 0) {
        const encoded = Buffer.from(JSON.stringify(feed.options), "utf-8").toString("base64");
        attrs.push(`yana:options="${escapeAttr(encoded)}"`);
      }
      return `    <outline ${attrs.join(" ")} />`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0" xmlns:yana="urn:yana:opml">
  <head>
    <title>Yana Feeds</title>
  </head>
  <body>
${outlines}
  </body>
</opml>
`;
}

function parseBool(value: string | undefined): boolean | undefined {
  return value === undefined ? undefined : value === "true";
}

function parseIntAttr(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function decodeOpml(xml: string): OpmlEntry[] {
  const $ = cheerio.load(xml, { xmlMode: true });

  if ($("opml").length === 0 || $("body").length === 0) {
    throw new Error("Not a valid OPML file");
  }

  const entries: OpmlEntry[] = [];

  $("outline").each((_, el) => {
    const $el = $(el);
    const identifier = $el.attr("xmlUrl") ?? "";
    const name = $el.attr("text") || $el.attr("title") || identifier;
    if (!name) return;

    const tags = ($el.attr("yana:tags") ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);

    entries.push({
      name,
      identifier,
      aggregatorType: $el.attr("yana:aggregatorType") || undefined,
      enabled: parseBool($el.attr("yana:enabled")),
      dailyLimit: parseIntAttr($el.attr("yana:dailyLimit")),
      updateIntervalMinutes: parseIntAttr($el.attr("yana:updateIntervalMinutes")),
      concurrency: parseIntAttr($el.attr("yana:concurrency")),
      maxArticleAgeDays: parseIntAttr($el.attr("yana:maxArticleAgeDays")),
      optionsBase64: $el.attr("yana:options") || undefined,
      tags,
    });
  });

  return entries;
}

export function decodeOpmlOptions(base64: string): Record<string, unknown> | null {
  try {
    const decoded = Buffer.from(base64, "base64").toString("utf-8");
    const parsed: unknown = JSON.parse(decoded);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/feeds/opml.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Format and lint**

Run: `npm run format && npm run lint`
Expected: no changes needed beyond formatting; lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/feeds/opml.ts src/lib/feeds/opml.test.ts
git commit -m "feat(feeds): add OPML 2.0 codec"
```

---

### Task 2: `previewOpmlImport` server action

**Files:**
- Modify: `src/lib/feeds/actions.ts`
- Modify: `messages/en.json`, `messages/de.json`
- Test: `src/lib/feeds/actions.test.ts`

**Interfaces:**
- Consumes: `decodeOpml`, `decodeOpmlOptions` from `./opml` (Task 1); `AGGREGATOR_SPECS`, `schemaFor`, `stripUnavailable`, `capabilitiesFor` (all already in this file); `ActionFailure` from `@/lib/attempt`; `NamespaceKey` from `@/i18n/next-intl`.
- Produces (for Task 3 and the UI tasks): `type OpmlPreviewEntry = { name: string; identifier: string; aggregatorLabel: string; tags: string[]; status: "new" | "duplicate" | "invalid"; reasonKey?: NamespaceKey<"feeds"> }`; `previewOpmlImport(content: string): Promise<{ ok: true; entries: OpmlPreviewEntry[] } | ActionFailure<"feeds">>`; the internal `resolveOpmlEntries(content: string, userId: string)` helper and its `OpmlClassified` type, which Task 3's `importOpmlFeeds` reuses directly (same file, not exported).

- [ ] **Step 1: Add the new catalog keys**

In `messages/en.json`, inside the `"feeds"` object, right after `"deletedNone"`, add:

```json
  "deletedNone": "Nothing was deleted — those feeds no longer exist.",
  "invalidOpmlFile": "That file isn't a valid OPML file",
  "importReasonMissingIdentifier": "Missing feed URL",
  "importReasonCapabilityUnavailable": "Integration not configured",
  "importReasonInvalidOptions": "Saved options are invalid"
```

(Keep the file valid JSON — this replaces the previous last line, which had no trailing comma, with one that does.)

In `messages/de.json`, inside the `"feeds"` object, in the same position:

```json
  "deletedNone": "Nichts wurde gelöscht — diese Feeds gibt es nicht mehr.",
  "invalidOpmlFile": "Das ist keine gültige OPML-Datei",
  "importReasonMissingIdentifier": "Feed-URL fehlt",
  "importReasonCapabilityUnavailable": "Integration nicht konfiguriert",
  "importReasonInvalidOptions": "Gespeicherte Optionen sind ungültig"
```

- [ ] **Step 2: Run the catalog parity test to verify it still passes**

Run: `npx vitest run src/i18n/messages.test.ts`
Expected: PASS (both catalogs still define identical keys).

- [ ] **Step 3: Write the failing test**

Open `src/lib/feeds/actions.test.ts`. Find the existing `seedUser`/`currentUserId`/`requestAs` helpers near the top of the `createFeed` describe block (there is one shared `beforeEach`/`afterEach` for the whole file). Add a new `describe` block at the end of the file, after the last existing one, reusing those same module-scoped helpers (they are declared with `let` at the top of the file and assigned in `beforeEach`, so every `describe` in this file already shares them):

```ts
describe("previewOpmlImport", () => {
  const OPML_HEADER = `<?xml version="1.0"?>\n<opml version="2.0" xmlns:yana="urn:yana:opml"><body>`;
  const OPML_FOOTER = `</body></opml>`;

  it("classifies a fresh entry as new", async () => {
    await currentUserId();

    const xml = `${OPML_HEADER}<outline text="Heise" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" />${OPML_FOOTER}`;
    const result = await actions.previewOpmlImport(xml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toEqual([
      expect.objectContaining({ name: "Heise", status: "new", aggregatorLabel: "Full Website" }),
    ]);
  });

  it("classifies an existing (aggregator, identifier) pair as a duplicate", async () => {
    const userId = await currentUserId();
    await actions.createFeed({
      name: "Existing",
      aggregator: "full_website",
      identifier: "https://heise.de/rss",
    });
    void userId;

    const xml = `${OPML_HEADER}<outline text="Heise Again" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" />${OPML_FOOTER}`;
    const result = await actions.previewOpmlImport(xml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0].status).toBe("duplicate");
  });

  it("falls back to full_website for foreign OPML with no yana:aggregatorType", async () => {
    await currentUserId();

    const xml = `${OPML_HEADER}<outline text="Some Blog" xmlUrl="https://example.com/rss" />${OPML_FOOTER}`;
    const result = await actions.previewOpmlImport(xml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]).toEqual(
      expect.objectContaining({ status: "new", aggregatorLabel: "Full Website" }),
    );
  });

  it("classifies an entry with invalid yana:options as invalid, not defaulted", async () => {
    await currentUserId();

    const badOptions = Buffer.from(JSON.stringify({ ai_summarize: "not-a-boolean" })).toString(
      "base64",
    );
    const xml = `${OPML_HEADER}<outline text="Heise" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" yana:options="${badOptions}" />${OPML_FOOTER}`;
    const result = await actions.previewOpmlImport(xml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]).toEqual(
      expect.objectContaining({ status: "invalid", reasonKey: "importReasonInvalidOptions" }),
    );
  });

  it("classifies a reddit/youtube entry as invalid when the integration isn't configured", async () => {
    await currentUserId();

    const xml = `${OPML_HEADER}<outline text="r/aww" xmlUrl="aww" yana:aggregatorType="reddit" />${OPML_FOOTER}`;
    const result = await actions.previewOpmlImport(xml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries[0]).toEqual(
      expect.objectContaining({
        status: "invalid",
        reasonKey: "importReasonCapabilityUnavailable",
      }),
    );
  });

  it("does not import a second identical entry from within the same file twice", async () => {
    await currentUserId();

    const xml = `${OPML_HEADER}<outline text="Heise" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" /><outline text="Heise Dup" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" />${OPML_FOOTER}`;
    const result = await actions.previewOpmlImport(xml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.status)).toEqual(["new", "duplicate"]);
  });

  it("reports invalidOpmlFile for a file with no OPML structure", async () => {
    await currentUserId();

    const result = await actions.previewOpmlImport("not xml at all");

    expect(result).toEqual({ ok: false, errorKey: "invalidOpmlFile" });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/lib/feeds/actions.test.ts -t "previewOpmlImport"`
Expected: FAIL — `actions.previewOpmlImport is not a function`.

- [ ] **Step 5: Implement `previewOpmlImport`**

In `src/lib/feeds/actions.ts`, add to the top imports:

```ts
import type { AggregatorKey } from "@/lib/db/schema/enums";
import type { ActionFailure } from "@/lib/attempt";
import type { NamespaceKey } from "@/i18n/next-intl";
import { decodeOpml, decodeOpmlOptions } from "./opml";
```

Then add this near the bottom of the file (after the existing `updateFeed`/other functions — anywhere at module scope is fine):

```ts
type FeedsKey = NamespaceKey<"feeds">;

export type OpmlPreviewEntry = {
  name: string;
  identifier: string;
  aggregatorLabel: string;
  tags: string[];
  status: "new" | "duplicate" | "invalid";
  reasonKey?: FeedsKey;
};

type OpmlClassified = {
  name: string;
  identifier: string;
  aggregatorKey: AggregatorKey;
  aggregatorLabel: string;
  tags: string[];
  status: "new" | "duplicate" | "invalid";
  reasonKey?: FeedsKey;
  options?: Record<string, unknown>;
  enabled?: boolean;
  dailyLimit?: number;
  updateIntervalMinutes?: number;
  concurrency?: number;
  maxArticleAgeDays?: number;
};

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return rounded < min || rounded > max ? fallback : rounded;
}

/**
 * Shared by `previewOpmlImport` and `importOpmlFeeds` so the two can never
 * disagree about what a file contains: the preview shows exactly what the
 * import would do, because both call this.
 *
 * A "new" entry within the file that repeats an earlier "new" entry's
 * `(aggregator, identifier)` is classified `duplicate`, not `new` — `seen`
 * starts from the caller's existing feeds and grows as entries are
 * classified, so the second of two identical outlines in one file is caught
 * even though neither is in the database yet.
 */
async function resolveOpmlEntries(
  content: string,
  userId: string,
): Promise<{ ok: true; classified: OpmlClassified[] } | ActionFailure<"feeds">> {
  let entries: ReturnType<typeof decodeOpml>;
  try {
    entries = decodeOpml(content);
  } catch {
    return { ok: false, errorKey: "invalidOpmlFile" };
  }

  const db = getDb();
  const capabilities = await capabilitiesFor();

  const seen = new Set(
    db
      .select({ aggregator: feeds.aggregator, identifier: feeds.identifier })
      .from(feeds)
      .where(eq(feeds.userId, userId))
      .all()
      .map((row) => `${row.aggregator}:${row.identifier}`),
  );

  const classified = entries.map((entry): OpmlClassified => {
    const requestedSpec = entry.aggregatorType
      ? AGGREGATOR_SPECS[entry.aggregatorType as AggregatorKey]
      : undefined;
    const spec = requestedSpec ?? AGGREGATOR_SPECS.full_website;
    const base = {
      name: entry.name,
      identifier: entry.identifier,
      aggregatorKey: spec.key,
      aggregatorLabel: spec.label,
      tags: entry.tags,
    };

    if (spec.identifierRequired && !entry.identifier) {
      return { ...base, status: "invalid", reasonKey: "importReasonMissingIdentifier" };
    }

    if (spec.identifierSearch && !capabilities[spec.identifierSearch]) {
      return { ...base, status: "invalid", reasonKey: "importReasonCapabilityUnavailable" };
    }

    let options: Record<string, unknown> = {};
    if (entry.optionsBase64) {
      const decoded = decodeOpmlOptions(entry.optionsBase64);
      const parsed = decoded === null ? null : schemaFor(spec.key).safeParse(decoded);
      if (!parsed || !parsed.success) {
        return { ...base, status: "invalid", reasonKey: "importReasonInvalidOptions" };
      }
      options = stripUnavailable(spec.key, parsed.data as Record<string, unknown>, capabilities);
    }

    const key = `${spec.key}:${entry.identifier}`;
    if (seen.has(key)) {
      return { ...base, status: "duplicate" };
    }
    seen.add(key);

    return {
      ...base,
      status: "new",
      options,
      enabled: entry.enabled ?? true,
      dailyLimit: clampInt(entry.dailyLimit, 20, 0, 1_000_000),
      updateIntervalMinutes: clampInt(
        entry.updateIntervalMinutes,
        spec.recommendedIntervalMinutes,
        0,
        1440,
      ),
      concurrency: clampInt(entry.concurrency, spec.recommendedConcurrency, 1, 10),
      maxArticleAgeDays: clampInt(entry.maxArticleAgeDays, 30, 0, 3650),
    };
  });

  return { ok: true, classified };
}

export async function previewOpmlImport(
  content: string,
): Promise<{ ok: true; entries: OpmlPreviewEntry[] } | ActionFailure<"feeds">> {
  const userId = await currentUserId();
  const resolved = await resolveOpmlEntries(content, userId);
  if (!resolved.ok) return resolved;

  return {
    ok: true,
    entries: resolved.classified.map((entry) => ({
      name: entry.name,
      identifier: entry.identifier,
      aggregatorLabel: entry.aggregatorLabel,
      tags: entry.tags,
      status: entry.status,
      reasonKey: entry.reasonKey,
    })),
  };
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/lib/feeds/actions.test.ts -t "previewOpmlImport"`
Expected: PASS (all 7 tests).

- [ ] **Step 7: Typecheck, format, lint**

Run: `npm run typecheck && npm run format && npm run lint`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/feeds/actions.ts src/lib/feeds/actions.test.ts messages/en.json messages/de.json
git commit -m "feat(feeds): add previewOpmlImport server action"
```

---

### Task 3: `importOpmlFeeds` server action

**Files:**
- Modify: `src/lib/feeds/actions.ts`
- Test: `src/lib/feeds/actions.test.ts`

**Interfaces:**
- Consumes: `resolveOpmlEntries`, `OpmlClassified` (Task 2, same file); `feedTags`, `tags`, `jobs` (already imported in this file); `DEFAULT_TAG_COLOR` from `@/lib/tags/colors` (new import); `sql` from `drizzle-orm` (add to existing import).
- Produces: `importOpmlFeeds(content: string): Promise<{ ok: true; imported: number; skipped: number } | ActionFailure<"feeds">>`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/feeds/actions.test.ts`, after the `previewOpmlImport` describe block:

```ts
describe("importOpmlFeeds", () => {
  const OPML_HEADER = `<?xml version="1.0"?>\n<opml version="2.0" xmlns:yana="urn:yana:opml"><body>`;
  const OPML_FOOTER = `</body></opml>`;

  it("creates new feeds, resolves tags by name, and enqueues a feed.logo job per feed", async () => {
    const userId = await currentUserId();

    const xml = `${OPML_HEADER}<outline text="Heise" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" yana:tags="Tech,News" />${OPML_FOOTER}`;
    const result = await actions.importOpmlFeeds(xml);

    expect(result).toEqual({ ok: true, imported: 1, skipped: 0 });

    const db = client.getDb();
    const row = db.select().from(schema.feeds).where(eq(schema.feeds.userId, userId)).get();
    expect(row?.name).toBe("Heise");
    expect(row?.aggregator).toBe("full_website");

    const feedTagNames = db
      .select({ name: schema.tags.name })
      .from(schema.feedTags)
      .innerJoin(schema.tags, eq(schema.feedTags.tagId, schema.tags.id))
      .where(eq(schema.feedTags.feedId, row!.id))
      .all()
      .map((t) => t.name)
      .sort();
    expect(feedTagNames).toEqual(["News", "Tech"]);

    const job = db.select().from(schema.jobs).where(eq(schema.jobs.kind, "feed.logo")).get();
    expect(job?.payload).toEqual({ feedId: row!.id });
  });

  it("reuses an existing tag by case-insensitive name instead of creating a duplicate", async () => {
    const userId = await currentUserId();
    await tagsActions.createTag({ name: "Tech" });

    const xml = `${OPML_HEADER}<outline text="Heise" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" yana:tags="tech" />${OPML_FOOTER}`;
    await actions.importOpmlFeeds(xml);

    const db = client.getDb();
    const tagRows = db
      .select()
      .from(schema.tags)
      .where(eq(schema.tags.userId, userId))
      .all();
    expect(tagRows).toHaveLength(1);
  });

  it("skips duplicates and invalid entries, and only counts what was actually created", async () => {
    await currentUserId();
    await actions.createFeed({
      name: "Existing",
      aggregator: "full_website",
      identifier: "https://heise.de/rss",
    });

    const badOptions = Buffer.from(JSON.stringify({ ai_summarize: "nope" })).toString("base64");
    const xml = `${OPML_HEADER}<outline text="Heise" xmlUrl="https://heise.de/rss" yana:aggregatorType="full_website" /><outline text="Broken" xmlUrl="https://broken.example" yana:aggregatorType="full_website" yana:options="${badOptions}" /><outline text="Fresh" xmlUrl="https://fresh.example" yana:aggregatorType="full_website" />${OPML_FOOTER}`;

    const result = await actions.importOpmlFeeds(xml);
    expect(result).toEqual({ ok: true, imported: 1, skipped: 2 });

    const db = client.getDb();
    const names = db
      .select({ name: schema.feeds.name })
      .from(schema.feeds)
      .all()
      .map((f) => f.name)
      .sort();
    expect(names).toEqual(["Existing", "Fresh"]);
  });

  it("reports invalidOpmlFile without writing anything for an unparseable file", async () => {
    await currentUserId();

    const result = await actions.importOpmlFeeds("not xml at all");
    expect(result).toEqual({ ok: false, errorKey: "invalidOpmlFile" });

    const db = client.getDb();
    expect(db.select().from(schema.feeds).all()).toEqual([]);
  });
});
```

This test file needs two more module-level `let` declarations alongside the existing ones (`actions`, `tagsActions`, `auth`, etc.) — check whether `schema` is already imported; if not, add:

```ts
let schema: typeof import("@/lib/db/schema");
```

and in the `beforeEach`, alongside the existing `client = await import("@/lib/db/client");` line, add:

```ts
schema = await import("@/lib/db/schema");
```

(`tagsActions` and `client` already exist per the file's existing `createFeed` tests — reuse them; do not redeclare.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/feeds/actions.test.ts -t "importOpmlFeeds"`
Expected: FAIL — `actions.importOpmlFeeds is not a function`.

- [ ] **Step 3: Implement `importOpmlFeeds`**

In `src/lib/feeds/actions.ts`, update the drizzle-orm import to add `sql`:

```ts
import { and, eq, inArray, count, desc, asc, like, sql } from "drizzle-orm";
```

Add a new import:

```ts
import { DEFAULT_TAG_COLOR } from "@/lib/tags/colors";
```

Add, after `previewOpmlImport`:

```ts
export async function importOpmlFeeds(
  content: string,
): Promise<{ ok: true; imported: number; skipped: number } | ActionFailure<"feeds">> {
  const userId = await currentUserId();
  const resolved = await resolveOpmlEntries(content, userId);
  if (!resolved.ok) return resolved;

  const newEntries = resolved.classified.filter((entry) => entry.status === "new");
  const skipped = resolved.classified.length - newEntries.length;

  if (newEntries.length === 0) {
    return { ok: true, imported: 0, skipped };
  }

  const imported = writeTransaction((tx) => {
    function resolveTagId(name: string): number {
      const existing = tx
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.userId, userId), sql`lower(${tags.name}) = lower(${name})`))
        .get();
      if (existing) return existing.id;

      return tx
        .insert(tags)
        .values({ name, userId, color: DEFAULT_TAG_COLOR })
        .returning({ id: tags.id })
        .get().id;
    }

    for (const entry of newEntries) {
      const tagIds = entry.tags.map(resolveTagId);

      const feed = tx
        .insert(feeds)
        .values({
          name: entry.name,
          aggregator: entry.aggregatorKey,
          identifier: entry.identifier,
          options: entry.options ?? {},
          enabled: entry.enabled ?? true,
          dailyLimit: entry.dailyLimit ?? 20,
          updateIntervalMinutes: entry.updateIntervalMinutes ?? 30,
          concurrency: entry.concurrency ?? 4,
          maxArticleAgeDays: entry.maxArticleAgeDays ?? 30,
          userId,
        })
        .returning({ id: feeds.id })
        .get();

      if (tagIds.length > 0) {
        tx.insert(feedTags)
          .values(tagIds.map((tagId) => ({ feedId: feed.id, tagId })))
          .run();
      }

      tx.insert(jobs)
        .values({ kind: "feed.logo", payload: { feedId: feed.id }, userId })
        .run();
    }

    revalidatePath("/feeds");
    return newEntries.length;
  });

  return { ok: true, imported, skipped };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/feeds/actions.test.ts -t "importOpmlFeeds"`
Expected: PASS (all 4 tests).

- [ ] **Step 5: Run the full actions test file**

Run: `npx vitest run src/lib/feeds/actions.test.ts`
Expected: PASS (every test in the file, including the pre-existing `createFeed`/`updateFeed` ones — nothing above was touched in a way that should affect them).

- [ ] **Step 6: Typecheck, format, lint**

Run: `npm run typecheck && npm run format && npm run lint`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/feeds/actions.ts src/lib/feeds/actions.test.ts
git commit -m "feat(feeds): add importOpmlFeeds server action"
```

---

### Task 4: Export route handler

**Files:**
- Create: `src/app/api/feeds/export/route.ts`
- Test: `src/app/api/feeds/export/route.test.ts`

**Interfaces:**
- Consumes: `encodeOpml`, `OpmlExportFeed` from `@/lib/feeds/opml` (Task 1); `requireUser` from `@/lib/auth/session`; `feeds`, `feedTags`, `tags` from `@/lib/db/schema`.
- Produces: `GET(request: Request): Promise<Response>`, returning OPML text with `Content-Type: text/x-opml+xml; charset=utf-8` and `Content-Disposition: attachment; filename="yana-feeds.opml"`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/feeds/export/route.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInCookie } from "@/lib/auth/test-support";
import { applyMigrationsAt } from "@/lib/db/test-support";
import { decodeOpml } from "@/lib/feeds/opml";

const { requestHeaders } = vi.hoisted(() => ({ requestHeaders: { current: new Headers() } }));
vi.mock("next/headers", async () =>
  (await import("@/test/next-headers")).nextHeadersStub(requestHeaders),
);

const REDIRECT = /^NEXT_REDIRECT/;
const PASSWORD = "correct horse battery staple";

describe("GET /api/feeds/export", () => {
  let dbPath: string;
  let GET: typeof import("./route").GET;
  let auth: typeof import("@/lib/auth/server").auth;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  function requestAs(cookie: string): void {
    requestHeaders.current = new Headers({ cookie });
  }

  function get(query = ""): Promise<Response> {
    return GET(new Request(`http://localhost/api/feeds/export${query}`));
  }

  beforeEach(async () => {
    vi.resetModules();
    requestHeaders.current = new Headers();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-feeds-export-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ auth, createUserWithPassword } = await import("@/lib/auth/server"));
    ({ GET } = await import("./route"));
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
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

  async function seedUser(email: string): Promise<{ id: string; cookie: string }> {
    const user = await createUserWithPassword({
      email,
      password: PASSWORD,
      firstName: "",
      lastName: "",
      role: "user",
    });
    raw(client.getDb()).exec(`INSERT INTO user_settings (user_id) VALUES ('${user.id}')`);
    return { id: user.id, cookie: await signInCookie(auth, { email, password: PASSWORD }) };
  }

  function insertFeed(userId: string, name: string): { id: number } {
    return client
      .getDb()
      .insert(schema.feeds)
      .values({
        name,
        aggregator: "full_website",
        identifier: `https://example.com/${name}`,
        userId,
      })
      .returning({ id: schema.feeds.id })
      .get();
  }

  it("exports every feed the caller owns", async () => {
    const owner = await seedUser("owner@example.com");
    insertFeed(owner.id, "FeedA");
    insertFeed(owner.id, "FeedB");
    requestAs(owner.cookie);

    const response = await get();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/x-opml+xml; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="yana-feeds.opml"',
    );

    const entries = decodeOpml(await response.text());
    expect(entries.map((e) => e.name).sort()).toEqual(["FeedA", "FeedB"]);
  });

  it("exports only the requested ids, still scoped to the caller", async () => {
    const owner = await seedUser("owner@example.com");
    const other = await seedUser("other@example.com");
    const keep = insertFeed(owner.id, "KeepMe");
    insertFeed(owner.id, "LeaveMeOut");
    const foreign = insertFeed(other.id, "NotYours");
    requestAs(owner.cookie);

    const response = await get(`?ids=${keep.id},${foreign.id}`);
    const entries = decodeOpml(await response.text());

    expect(entries.map((e) => e.name)).toEqual(["KeepMe"]);
  });

  it("refuses an unauthenticated request", async () => {
    await expect(get()).rejects.toMatchObject({ digest: expect.stringMatching(REDIRECT) });
  });
});
```

Note: `eq` is imported but unused directly in this file's body (it is only used inside the app's own modules) — remove that import if `npm run lint` flags it as unused; the test as written above does not call `eq` itself, so drop `import { eq } from "drizzle-orm";` from the test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/feeds/export/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Implement the route handler**

Create `src/app/api/feeds/export/route.ts`:

```ts
import { and, eq, inArray } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { feeds, feedTags, tags } from "@/lib/db/schema";
import { encodeOpml, type OpmlExportFeed } from "@/lib/feeds/opml";

/**
 * `GET /api/feeds/export` — an OPML download of the caller's own feeds.
 *
 * A route handler, not a server action: actions in this codebase only ever
 * return JSON, and a file download needs a real HTTP response carrying
 * `Content-Disposition`. Authenticates itself with `requireUser()`, the same
 * as `src/app/media/avatars/[userId]/route.ts` — nothing above a route
 * handler does.
 *
 * Not under `/api/v1`: that prefix is the Bearer-token native-client API
 * (`requireApiUser()`). This is a cookie-session, browser-only feature.
 *
 * `?ids=1,2,3` narrows the export to those feeds, but the `userId` filter is
 * always applied on top of it — an id belonging to another user is silently
 * excluded rather than exported, the same "compare, don't trust the id"
 * rule the avatar route follows.
 */
export async function GET(request: Request): Promise<Response> {
  const user = await requireUser();

  const url = new URL(request.url);
  const idsParam = url.searchParams.get("ids");
  const ids = idsParam
    ? idsParam
        .split(",")
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id))
    : undefined;

  const db = getDb();
  const conditions = [eq(feeds.userId, user.id)];
  if (ids && ids.length > 0) {
    conditions.push(inArray(feeds.id, ids));
  }

  const rows = db
    .select()
    .from(feeds)
    .where(and(...conditions))
    .all();

  const exportFeeds: OpmlExportFeed[] = rows.map((row) => {
    const feedTagRows = db
      .select({ name: tags.name })
      .from(feedTags)
      .innerJoin(tags, eq(feedTags.tagId, tags.id))
      .where(eq(feedTags.feedId, row.id))
      .all();

    return {
      name: row.name,
      aggregator: row.aggregator,
      identifier: row.identifier,
      enabled: row.enabled,
      dailyLimit: row.dailyLimit,
      updateIntervalMinutes: row.updateIntervalMinutes,
      concurrency: row.concurrency,
      maxArticleAgeDays: row.maxArticleAgeDays,
      options: row.options,
      tags: feedTagRows.map((t) => t.name),
    };
  });

  return new Response(encodeOpml(exportFeeds), {
    headers: {
      "Content-Type": "text/x-opml+xml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="yana-feeds.opml"',
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/api/feeds/export/route.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Typecheck, format, lint**

Run: `npm run typecheck && npm run format && npm run lint`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/feeds/export/route.ts src/app/api/feeds/export/route.test.ts
git commit -m "feat(feeds): add OPML export route handler"
```

---

### Task 5: Import UI (preview + confirm dialog)

**Files:**
- Modify: `messages/en.json`, `messages/de.json`
- Create: `src/components/feeds/import-opml-button.tsx`
- Test: `src/components/feeds/import-opml-button.test.tsx`

**Interfaces:**
- Consumes: `previewOpmlImport`, `importOpmlFeeds`, `OpmlPreviewEntry` from `@/lib/feeds/actions` (Tasks 2–3); `attempt` from `@/lib/feeds/result`; `Dialog`/`DialogContent`/`DialogFooter`/`DialogHeader`/`DialogTitle` from `@/components/ui/dialog`; `Badge` from `@/components/ui/badge`; `Table`/`TableBody`/`TableCell`/`TableHead`/`TableHeader`/`TableRow` from `@/components/ui/table`.
- Produces: `<ImportOpmlButton />` — a self-contained button + hidden file input + dialog, no props. Consumed by Task 6's `page.tsx`.

- [ ] **Step 1: Add the new catalog keys**

In `messages/en.json`, inside `"feeds"`, after the keys Task 2 added (`importReasonInvalidOptions`), add:

```json
  "importReasonInvalidOptions": "Saved options are invalid",
  "importOpml": "Import OPML",
  "importPreviewTitle": "{count, plural, one {# feed found} other {# feeds found}}",
  "importStatusNew": "New",
  "importStatusDuplicate": "Already added",
  "importStatusInvalid": "Can't import",
  "importConfirm": "{count, plural, one {Import # feed} other {Import # feeds}}",
  "importResult": "{imported, plural, one {# feed imported} other {# feeds imported}}, {skipped} skipped"
```

In `messages/de.json`, in the same position:

```json
  "importReasonInvalidOptions": "Gespeicherte Optionen sind ungültig",
  "importOpml": "OPML importieren",
  "importPreviewTitle": "{count, plural, one {# Feed gefunden} other {# Feeds gefunden}}",
  "importStatusNew": "Neu",
  "importStatusDuplicate": "Bereits vorhanden",
  "importStatusInvalid": "Kann nicht importiert werden",
  "importConfirm": "{count, plural, one {# Feed importieren} other {# Feeds importieren}}",
  "importResult": "{imported, plural, one {# Feed importiert} other {# Feeds importiert}}, {skipped} übersprungen"
```

- [ ] **Step 2: Run the catalog parity test**

Run: `npx vitest run src/i18n/messages.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing component test**

Create `src/components/feeds/import-opml-button.test.tsx`:

```tsx
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { importOpmlFeeds, previewOpmlImport } from "@/lib/feeds/actions";
import { ImportOpmlButton } from "./import-opml-button";

vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/feeds/actions", () => ({
  previewOpmlImport: vi.fn(),
  importOpmlFeeds: vi.fn(),
}));

function selectFile(content: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([content], "feeds.opml", { type: "text/xml" });
  fireEvent.change(input, { target: { files: [file] } });
}

describe("ImportOpmlButton", () => {
  it("shows an error toast and no dialog when the file doesn't parse", async () => {
    vi.mocked(previewOpmlImport).mockResolvedValue({ ok: false, errorKey: "invalidOpmlFile" });
    renderWithProviders(<ImportOpmlButton />);

    selectFile("not opml");

    await waitFor(() => expect(previewOpmlImport).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /import \d/i })).toBeNull();
  });

  it("opens a preview dialog listing every entry with its status", async () => {
    vi.mocked(previewOpmlImport).mockResolvedValue({
      ok: true,
      entries: [
        {
          name: "Heise",
          identifier: "https://heise.de",
          aggregatorLabel: "Full Website",
          tags: [],
          status: "new",
        },
        {
          name: "Old",
          identifier: "https://old.example",
          aggregatorLabel: "Full Website",
          tags: [],
          status: "duplicate",
        },
        {
          name: "Broken",
          identifier: "https://broken.example",
          aggregatorLabel: "Full Website",
          tags: [],
          status: "invalid",
          reasonKey: "importReasonInvalidOptions",
        },
      ],
    });
    renderWithProviders(<ImportOpmlButton />);

    selectFile("<opml></opml>");

    expect(await screen.findByText("Heise")).toBeTruthy();
    expect(screen.getByText("Old")).toBeTruthy();
    expect(screen.getByText("Broken")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import 1 feed" })).toBeTruthy();
  });

  it("disables the confirm button when nothing is new", async () => {
    vi.mocked(previewOpmlImport).mockResolvedValue({
      ok: true,
      entries: [
        {
          name: "Old",
          identifier: "https://old.example",
          aggregatorLabel: "Full Website",
          tags: [],
          status: "duplicate",
        },
      ],
    });
    renderWithProviders(<ImportOpmlButton />);

    selectFile("<opml></opml>");

    const confirmButton = await screen.findByRole("button", { name: "Import 0 feeds" });
    expect(confirmButton).toBeDisabled();
  });

  it("imports and closes the dialog on confirm", async () => {
    vi.mocked(previewOpmlImport).mockResolvedValue({
      ok: true,
      entries: [
        {
          name: "Heise",
          identifier: "https://heise.de",
          aggregatorLabel: "Full Website",
          tags: [],
          status: "new",
        },
      ],
    });
    vi.mocked(importOpmlFeeds).mockResolvedValue({ ok: true, imported: 1, skipped: 0 });
    renderWithProviders(<ImportOpmlButton />);

    selectFile("<opml></opml>");
    fireEvent.click(await screen.findByRole("button", { name: "Import 1 feed" }));

    await waitFor(() => expect(importOpmlFeeds).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /import \d/i })).toBeNull(),
    );
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/components/feeds/import-opml-button.test.tsx`
Expected: FAIL — `Cannot find module './import-opml-button'`.

- [ ] **Step 5: Implement the component**

Create `src/components/feeds/import-opml-button.tsx`:

```tsx
"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { UploadIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { importOpmlFeeds, previewOpmlImport, type OpmlPreviewEntry } from "@/lib/feeds/actions";
import { attempt } from "@/lib/feeds/result";

const STATUS_VARIANT: Record<
  OpmlPreviewEntry["status"],
  "secondary" | "outline" | "destructive"
> = {
  new: "secondary",
  duplicate: "outline",
  invalid: "destructive",
};

export function ImportOpmlButton() {
  const t = useTranslations("feeds");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<OpmlPreviewEntry[] | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function statusLabel(status: OpmlPreviewEntry["status"]): string {
    if (status === "new") return t("importStatusNew");
    if (status === "duplicate") return t("importStatusDuplicate");
    return t("importStatusInvalid");
  }

  async function onFileSelected(file: File) {
    const text = await file.text();
    const result = await attempt(() => previewOpmlImport(text));
    if (!result.ok) {
      toast.error(t(result.errorKey));
      return;
    }
    setContent(text);
    setEntries(result.entries);
  }

  function close() {
    setEntries(null);
    setContent(null);
  }

  function confirm() {
    if (!content) return;
    start(async () => {
      const result = await attempt(() => importOpmlFeeds(content));
      if (!result.ok) {
        toast.error(t(result.errorKey));
        return;
      }
      toast.success(t("importResult", { imported: result.imported, skipped: result.skipped }));
      close();
      router.refresh();
    });
  }

  const newCount = entries?.filter((entry) => entry.status === "new").length ?? 0;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".opml,.xml,text/xml,text/x-opml"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void onFileSelected(file);
        }}
      />
      <Button type="button" variant="outline" onClick={() => inputRef.current?.click()}>
        <UploadIcon />
        {t("importOpml")}
      </Button>

      <Dialog open={entries !== null} onOpenChange={(open) => !open && close()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("importPreviewTitle", { count: entries?.length ?? 0 })}</DialogTitle>
          </DialogHeader>

          <div className="max-h-80 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.name")}</TableHead>
                  <TableHead>{t("columns.aggregator")}</TableHead>
                  <TableHead>{t("form.tags")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries?.map((entry, index) => (
                  <TableRow key={`${entry.identifier}-${index}`}>
                    <TableCell>{entry.name}</TableCell>
                    <TableCell>{entry.aggregatorLabel}</TableCell>
                    <TableCell>{entry.tags.join(", ")}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[entry.status]}>
                        {statusLabel(entry.status)}
                        {entry.reasonKey ? ` — ${t(entry.reasonKey)}` : ""}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={pending}>
              {tCommon("cancel")}
            </Button>
            <Button type="button" onClick={confirm} disabled={pending || newCount === 0}>
              {t("importConfirm", { count: newCount })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/components/feeds/import-opml-button.test.tsx`
Expected: PASS (all 4 tests). If `File.prototype.text()` is not available in this project's jsdom version, replace `const text = await file.text();` with a `FileReader`-based read and re-run.

- [ ] **Step 7: Typecheck, format, lint**

Run: `npm run typecheck && npm run format && npm run lint`
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add messages/en.json messages/de.json src/components/feeds/import-opml-button.tsx src/components/feeds/import-opml-button.test.tsx
git commit -m "feat(feeds): add OPML import preview/confirm dialog"
```

---

### Task 6: Export UI and page wiring

**Files:**
- Modify: `messages/en.json`, `messages/de.json`
- Modify: `src/app/(app)/feeds/page.tsx`
- Modify: `src/components/feeds/feeds-table.tsx`

**Interfaces:**
- Consumes: `<ImportOpmlButton>` (Task 5); the `/api/feeds/export` route (Task 4); the existing `BulkAction` type and `selected`/`onSelectedChange` from `useListSelection()` already used in `feeds-table.tsx`.
- No new exports — this task only wires existing pieces into the page.

- [ ] **Step 1: Add the new catalog keys**

In `messages/en.json`, inside `"feeds"`, after `"importResult"`, add:

```json
  "importResult": "{imported, plural, one {# feed imported} other {# feeds imported}}, {skipped} skipped",
  "exportOpml": "Export all",
  "bulkExportOpml": "Export OPML"
```

In `messages/de.json`, in the same position:

```json
  "importResult": "{imported, plural, one {# Feed importiert} other {# Feeds importiert}}, {skipped} übersprungen",
  "exportOpml": "Alle exportieren",
  "bulkExportOpml": "OPML exportieren"
```

- [ ] **Step 2: Run the catalog parity test**

Run: `npx vitest run src/i18n/messages.test.ts`
Expected: PASS.

- [ ] **Step 3: Wire the page header**

In `src/app/(app)/feeds/page.tsx`, add an import:

```ts
import { ImportOpmlButton } from "@/components/feeds/import-opml-button";
```

Replace the header block:

```tsx
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <Link href="/feeds/new" className={buttonVariants()}>
          {t("new")}
        </Link>
      </div>
```

with:

```tsx
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <a href="/api/feeds/export" className={buttonVariants({ variant: "outline" })}>
            {t("exportOpml")}
          </a>
          <ImportOpmlButton />
          <Link href="/feeds/new" className={buttonVariants()}>
            {t("new")}
          </Link>
        </div>
      </div>
```

- [ ] **Step 4: Add the bulk "Export OPML" action**

In `src/components/feeds/feeds-table.tsx`, inside `FeedsTableChrome`, add a new function next to `removeSelected`/`updateSelectedLogos`/`runAggregation`:

```ts
  function exportSelected(): Promise<boolean> {
    if (selected.length === 0) return Promise.resolve(false);
    const params = new URLSearchParams({ ids: selected.join(",") });
    window.location.href = `/api/feeds/export?${params.toString()}`;
    onSelectedChange([]);
    return Promise.resolve(true);
  }
```

Add it to the `actions` array, right after the `"run-aggregation"` entry and before `"delete"`:

```ts
    {
      key: "export-opml",
      label: t("bulkExportOpml"),
      destructive: false,
      run: exportSelected,
    },
```

- [ ] **Step 5: Manually verify in the dev server**

Run: `npm run dev`, sign in, go to `/feeds`.

- Click "Export all" — a `yana-feeds.opml` file downloads containing every feed.
- Select a couple of rows, click "Export OPML" in the bulk bar — a file downloads containing only those feeds, and the selection clears.
- Click "Import OPML", pick the file just exported — the preview dialog lists every feed as "Already added" (they're all duplicates of what's already there), and "Import 0 feeds" is disabled.
- Edit the exported file to change one `xmlUrl` to a URL not already in the list, re-import — that one row shows "New", and confirming creates it (visible in the list after the dialog closes and the page refreshes).

- [ ] **Step 6: Typecheck, format, lint, full test suite**

Run: `npm run typecheck && npm run format && npm run lint && npm test`
Expected: all clean, no regressions.

- [ ] **Step 7: Commit**

```bash
git add messages/en.json messages/de.json "src/app/(app)/feeds/page.tsx" src/components/feeds/feeds-table.tsx
git commit -m "feat(feeds): wire OPML import/export into the feeds page"
```

---

### Task 7: Final verification pass

**Files:** none (verification only).

- [ ] **Step 1: Run the full pre-commit check set**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: all four pass with no errors and no unexpected diffs.

- [ ] **Step 2: Confirm catalog parity one more time**

Run: `npx vitest run src/i18n/messages.test.ts`
Expected: PASS.

- [ ] **Step 3: Re-read the design doc against what shipped**

Open `docs/superpowers/specs/2026-08-10-feeds-opml-import-export-design.md` and confirm each section has a corresponding implemented piece: format (Task 1), `previewOpmlImport`/`importOpmlFeeds` (Tasks 2–3), export route (Task 4), UI (Tasks 5–6). No step here should require new code — this is a read-through check, not a new task.

- [ ] **Step 4: Update CLAUDE.md's "Where the work is planned" section if this plan's existence should be reflected there**

This is optional and only needed if the user wants the new feature noted in `CLAUDE.md`'s architectural narrative (it documents *why* things are the way they are, not a changelog — most features don't need an entry). Skip unless asked.
