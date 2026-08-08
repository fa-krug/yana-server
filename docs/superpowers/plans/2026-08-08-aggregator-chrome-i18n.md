# Translate Aggregator-Added Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Translate the seven hardcoded-English strings aggregators splice into article content ("Comments" headings, per-comment "source" links, empty/disabled-comments notices, and Reddit's two video-link labels) into the feed owner's own language.

**Architecture:** A new `resolveChromeLabels(userId)` helper reads the feed owner's `user_settings.language` and renders a `ChromeLabels` object through next-intl's `createTranslator`, mirroring the existing per-user-locale pattern in `renderDigest()` (`src/lib/email/digest.ts`). `BaseAggregator` exposes this as a memoized `chromeLabels()` method every site aggregator already has access to via `this`. Every function that currently hardcodes one of the seven strings gains a required `labels: ChromeLabels` parameter, threaded from each aggregator's own call site.

**Tech Stack:** TypeScript, Drizzle ORM, next-intl (`use-intl/core`'s `createTranslator`), Vitest.

## Global Constraints

- Line length 100, double quotes, semicolons, trailing commas (Prettier owns formatting).
- `messages/en.json` and `messages/de.json` must define exactly the same key set (enforced by `src/i18n/messages.test.ts`) and no catalog value may be empty.
- New library code under `src/lib/**` gets real-database tests (no driver mocks) per this repo's convention -- see `src/lib/aggregators/credential-resolution.test.ts` for the exact pattern (temp SQLite file + `applyMigrationsAt()`).
- Never add a default value to a `labels: ChromeLabels` parameter -- a call site that forgets to pass it must be a compile error, not silently-shipped English.
- Run `npm run lint && npm run format:check && npm run typecheck && npm test` before considering any task done; each task's steps below call out the narrower commands to run first.

---

### Task 1: Add the `aggregatorChrome` i18n catalog namespace

**Files:**
- Modify: `messages/en.json`
- Modify: `messages/de.json`
- Test: `src/i18n/messages.test.ts` (already exists, no changes needed -- it generically diffs key sets across every namespace)

**Interfaces:**
- Produces: catalog namespace `"aggregatorChrome"` with keys `comments`, `source`, `noCommentsYet`, `commentsDisabled`, `commentsUnavailable`, `viewVideoOnYoutube`, `viewVideo` -- consumed by Task 2's `resolveChromeLabels()`.

- [ ] **Step 1: Add the namespace to `messages/en.json`**

Open `messages/en.json`. It's a flat top-level object keyed by namespace (`nav`, `jobs`, `auth`, ..., `articles`). Add a new top-level key, in the same alphabetically-unsorted style as the rest of the file (append it after the last key, `"articles"`):

```json
  "aggregatorChrome": {
    "comments": "Comments",
    "source": "source",
    "noCommentsYet": "No comments yet.",
    "commentsDisabled": "Comments disabled.",
    "commentsUnavailable": "Comments unavailable.",
    "viewVideoOnYoutube": "▶ View Video on YouTube",
    "viewVideo": "▶ View Video"
  }
```

Remember to add a trailing comma after the previous last key's closing brace, and make this the new final key before the file's closing `}`.

- [ ] **Step 2: Add the matching namespace to `messages/de.json`**

Same structure, German values:

```json
  "aggregatorChrome": {
    "comments": "Kommentare",
    "source": "Quelle",
    "noCommentsYet": "Noch keine Kommentare.",
    "commentsDisabled": "Kommentare deaktiviert.",
    "commentsUnavailable": "Kommentare nicht verfügbar.",
    "viewVideoOnYoutube": "▶ Video auf YouTube ansehen",
    "viewVideo": "▶ Video ansehen"
  }
```

- [ ] **Step 3: Run the catalog parity test**

Run: `npx vitest run src/i18n/messages.test.ts`
Expected: PASS (both tests -- "define exactly the same keys" and "leave no value empty")

- [ ] **Step 4: Format and commit**

```bash
npx prettier --write messages/en.json messages/de.json
git add messages/en.json messages/de.json
git commit -m "feat(i18n): add aggregatorChrome catalog for aggregator-added chrome text"
```

---

### Task 2: `resolveChromeLabels()` helper

**Files:**
- Create: `src/lib/aggregators/chrome-labels.ts`
- Test: `src/lib/aggregators/chrome-labels.test.ts`

**Interfaces:**
- Consumes: `messages/en.json` / `messages/de.json`'s `aggregatorChrome` namespace (Task 1); `getDb()` from `@/lib/db/client`; `userSettings` from `@/lib/db/schema`; `AppLocale`/`FALLBACK_LOCALE` from `@/i18n/locale`.
- Produces: `export interface ChromeLabels { comments: string; source: string; noCommentsYet: string; commentsDisabled: string; commentsUnavailable: string; viewVideoOnYoutube: string; viewVideo: string; }`, `export const DEFAULT_CHROME_LABELS: ChromeLabels`, `export async function resolveChromeLabels(userId: string | number | null | undefined): Promise<ChromeLabels>` -- consumed by Task 3's `BaseAggregator.chromeLabels()` and directly by every touched test file (as the English default to pass when a test doesn't care about locale).

- [ ] **Step 1: Write the failing test**

Create `src/lib/aggregators/chrome-labels.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../db/test-support";

describe("resolveChromeLabels", () => {
  let dbPath: string;
  let client: typeof import("../db/client");
  let schema: typeof import("../db/schema");
  let chromeLabels: typeof import("./chrome-labels");

  beforeEach(async () => {
    vi.resetModules();
    dbPath = path.join(
      os.tmpdir(),
      `yana-chromelabels-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    applyMigrationsAt(dbPath);

    client = await import("../db/client");
    schema = await import("../db/schema");
    chromeLabels = await import("./chrome-labels");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("returns English defaults without touching the database when userId is missing", async () => {
    const labels = await chromeLabels.resolveChromeLabels(undefined);
    expect(labels).toEqual(chromeLabels.DEFAULT_CHROME_LABELS);
    expect(labels.comments).toBe("Comments");
    expect(labels.source).toBe("source");
  });

  it("returns English defaults for null userId", async () => {
    const labels = await chromeLabels.resolveChromeLabels(null);
    expect(labels).toEqual(chromeLabels.DEFAULT_CHROME_LABELS);
  });

  it("resolves English labels for a user whose language is en", async () => {
    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
      db.insert(schema.userSettings).values({ userId: "user1", language: "en" }).run();
    });

    const labels = await chromeLabels.resolveChromeLabels("user1");
    expect(labels.comments).toBe("Comments");
    expect(labels.source).toBe("source");
    expect(labels.noCommentsYet).toBe("No comments yet.");
  });

  it("resolves German labels for a user whose language is de", async () => {
    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
      db.insert(schema.userSettings).values({ userId: "user1", language: "de" }).run();
    });

    const labels = await chromeLabels.resolveChromeLabels("user1");
    expect(labels.comments).toBe("Kommentare");
    expect(labels.source).toBe("Quelle");
    expect(labels.noCommentsYet).toBe("Noch keine Kommentare.");
    expect(labels.commentsDisabled).toBe("Kommentare deaktiviert.");
    expect(labels.commentsUnavailable).toBe("Kommentare nicht verfügbar.");
    expect(labels.viewVideoOnYoutube).toBe("▶ Video auf YouTube ansehen");
    expect(labels.viewVideo).toBe("▶ Video ansehen");
  });

  it("falls back to English when there is no user_settings row for the given id", async () => {
    const labels = await chromeLabels.resolveChromeLabels("no-such-user");
    expect(labels).toEqual(chromeLabels.DEFAULT_CHROME_LABELS);
  });

  it("accepts a numeric userId by coercing it to the text user_settings.userId column", async () => {
    // Feed.userId's type is `string | number | null` on FeedLike, even though every
    // real feed row's userId is text -- this proves the numeric branch doesn't throw
    // and simply finds no matching row (falls back to English).
    const labels = await chromeLabels.resolveChromeLabels(42);
    expect(labels).toEqual(chromeLabels.DEFAULT_CHROME_LABELS);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/aggregators/chrome-labels.test.ts`
Expected: FAIL with "Cannot find module './chrome-labels'" (the file doesn't exist yet)

- [ ] **Step 3: Write the implementation**

Create `src/lib/aggregators/chrome-labels.ts`:

```ts
import { eq } from "drizzle-orm";
import { createTranslator } from "use-intl/core";

import { FALLBACK_LOCALE, type AppLocale } from "@/i18n/locale";
import { getDb } from "@/lib/db/client";
import { userSettings } from "@/lib/db/schema";

export interface ChromeLabels {
  comments: string;
  source: string;
  noCommentsYet: string;
  commentsDisabled: string;
  commentsUnavailable: string;
  viewVideoOnYoutube: string;
  viewVideo: string;
}

export const DEFAULT_CHROME_LABELS: ChromeLabels = {
  comments: "Comments",
  source: "source",
  noCommentsYet: "No comments yet.",
  commentsDisabled: "Comments disabled.",
  commentsUnavailable: "Comments unavailable.",
  viewVideoOnYoutube: "▶ View Video on YouTube",
  viewVideo: "▶ View Video",
};

/**
 * Resolves the chrome labels aggregators splice into article content
 * ("Comments" headings, per-comment "source" links, ...) in the feed
 * owner's own language. Background aggregation has no request to read a
 * locale from, so this follows the same per-user pattern as
 * `renderDigest()` (`src/lib/email/digest.ts`): read `user_settings.language`
 * directly, then render through `createTranslator` against that locale's
 * own catalog.
 *
 * Falls back to `DEFAULT_CHROME_LABELS` (English) without touching the
 * database at all when `userId` is missing -- every real aggregation/reload
 * run passes the feed owner's real id, but this keeps every site
 * aggregator's own unit tests (which construct feeds with no `userId`) from
 * needing a database connection.
 */
export async function resolveChromeLabels(
  userId: string | number | null | undefined,
): Promise<ChromeLabels> {
  if (userId === null || userId === undefined || userId === "") {
    return DEFAULT_CHROME_LABELS;
  }

  const settings = getDb()
    .select({ language: userSettings.language })
    .from(userSettings)
    .where(eq(userSettings.userId, String(userId)))
    .get();

  const locale: AppLocale = settings?.language === "de" ? "de" : FALLBACK_LOCALE;
  const messages = (await import(`../../../messages/${locale}.json`)).default;
  const t = createTranslator({ locale, messages, namespace: "aggregatorChrome" });

  return {
    comments: t("comments"),
    source: t("source"),
    noCommentsYet: t("noCommentsYet"),
    commentsDisabled: t("commentsDisabled"),
    commentsUnavailable: t("commentsUnavailable"),
    viewVideoOnYoutube: t("viewVideoOnYoutube"),
    viewVideo: t("viewVideo"),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/aggregators/chrome-labels.test.ts`
Expected: PASS (all 7 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/aggregators/chrome-labels.ts src/lib/aggregators/chrome-labels.test.ts
git commit -m "feat(aggregators): add resolveChromeLabels() for per-user chrome text"
```

---

### Task 3: `BaseAggregator.chromeLabels()`

**Files:**
- Modify: `src/lib/aggregators/base.ts`
- Test: `src/lib/aggregators/base.test.ts`

**Interfaces:**
- Consumes: `resolveChromeLabels`, `ChromeLabels` from `./chrome-labels` (Task 2).
- Produces: `protected chromeLabels(): Promise<ChromeLabels>` on `BaseAggregator`, memoized per instance -- consumed by every site aggregator in Tasks 4-9 via `this.chromeLabels()`.

- [ ] **Step 1: Write the failing test**

`src/lib/aggregators/base.test.ts` currently has no database setup (it's a plain sync test file). Add the setup and one new test. Open the file and replace its full contents with:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../db/test-support";
import { BaseAggregator, FeedLike, RawArticle } from "./base";

class TestAggregator extends BaseAggregator {
  public fetchedLimit?: number;

  async fetchSourceData(limit?: number): Promise<unknown> {
    this.fetchedLimit = limit;
    return [
      {
        name: "Recent Article",
        identifier: "https://example.com/1",
        raw_content: "",
        content: "Content 1",
        date: new Date(),
      },
      {
        name: "Old Article",
        identifier: "https://example.com/2",
        raw_content: "",
        content: "Content 2",
        date: new Date(Date.now() - 70 * 24 * 60 * 60 * 1000), // 70 days old
      },
    ];
  }

  async parseToRawArticles(sourceData: unknown): Promise<RawArticle[]> {
    return sourceData as RawArticle[];
  }

  public chromeLabelsForTest() {
    return this.chromeLabels();
  }
}

describe("BaseAggregator", () => {
  it("validates that feed identifier is present", () => {
    const feed: FeedLike = { identifier: "", dailyLimit: 20 };
    const agg = new TestAggregator(feed);
    expect(() => agg.validate()).toThrow("Feed identifier is required");
  });

  it("returns 0 run limit when daily limit is reached", () => {
    const feed: FeedLike = { identifier: "test", dailyLimit: 5 };
    const agg = new TestAggregator(feed);
    expect(agg.getCurrentRunLimit(() => new Date(), 5)).toBe(0);
  });

  it("filters articles older than maxArticleAgeDays", async () => {
    const feed: FeedLike = { identifier: "test", dailyLimit: 20, maxArticleAgeDays: 30 };
    const agg = new TestAggregator(feed);
    const articles = await agg.fetchSourceData().then((data) => agg.parseToRawArticles(data));
    const filtered = await agg.filterArticles(articles);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].name).toBe("Recent Article");
  });

  describe("chromeLabels", () => {
    let dbPath: string;
    let client: typeof import("../db/client");
    let schema: typeof import("../db/schema");

    beforeEach(async () => {
      vi.resetModules();
      dbPath = path.join(
        os.tmpdir(),
        `yana-baseagg-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
      );
      process.env.DATABASE_PATH = dbPath;
      applyMigrationsAt(dbPath);

      client = await import("../db/client");
      schema = await import("../db/schema");
    });

    afterEach(() => {
      delete process.env.DATABASE_PATH;
      const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
      if (connection.open) connection.close();
      for (const suffix of ["", "-shm", "-wal"]) {
        fs.rmSync(`${dbPath}${suffix}`, { force: true });
      }
    });

    it("memoizes the resolved labels for the lifetime of the aggregator instance", async () => {
      client.writeTransaction((db) => {
        db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
        db.insert(schema.userSettings).values({ userId: "user1", language: "de" }).run();
      });

      const feed: FeedLike = { identifier: "test", dailyLimit: 20, userId: "user1" };
      const agg = new TestAggregator(feed);

      const first = await agg.chromeLabelsForTest();
      expect(first.comments).toBe("Kommentare");

      // Delete the row entirely: a second, un-memoized call would fall back to
      // English (no row found), so getting German back proves the first
      // resolution was cached rather than re-queried.
      client.writeTransaction((db) => {
        db.delete(schema.userSettings).run();
      });

      const second = await agg.chromeLabelsForTest();
      expect(second.comments).toBe("Kommentare");
      expect(second).toBe(first);
    });

    it("falls back to English defaults with no database access when the feed has no userId", async () => {
      const feed: FeedLike = { identifier: "test", dailyLimit: 20 };
      const agg = new TestAggregator(feed);

      const labels = await agg.chromeLabelsForTest();
      expect(labels.comments).toBe("Comments");
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/aggregators/base.test.ts`
Expected: FAIL with a TypeScript error / "chromeLabels is not a function" (the method doesn't exist yet)

- [ ] **Step 3: Add `chromeLabels()` to `BaseAggregator`**

In `src/lib/aggregators/base.ts`, add the import at the top (after the existing `import { applyAiOptions } from "../ai/run";` line):

```ts
import { resolveChromeLabels, type ChromeLabels } from "./chrome-labels";
```

Then, inside the `BaseAggregator` class body, add a private field alongside the existing `public identifier`/`dailyLimit`/etc. fields (right after `public usesFirstContentMatch = false;`):

```ts
  private chromeLabelsPromise?: Promise<ChromeLabels>;
```

And add the method itself anywhere in the class body (a sensible spot is right after the `constructor`):

```ts
  /**
   * The feed owner's own-language versions of the chrome text aggregators
   * splice into article content ("Comments" headings, per-comment "source"
   * links, ...). Memoized per instance: a feed's aggregator processes every
   * one of its articles in a single run, and this way that run does one
   * database read total instead of one per article.
   */
  protected chromeLabels(): Promise<ChromeLabels> {
    if (!this.chromeLabelsPromise) {
      this.chromeLabelsPromise = resolveChromeLabels(this.feed.userId);
    }
    return this.chromeLabelsPromise;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/aggregators/base.test.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/aggregators/base.ts src/lib/aggregators/base.test.ts
git commit -m "feat(aggregators): add BaseAggregator.chromeLabels(), memoized per instance"
```

---

### Task 4: Mein-MMO chrome labels

**Files:**
- Modify: `src/lib/aggregators/sites/mein_mmo/comments.ts`
- Modify: `src/lib/aggregators/sites/mein_mmo/aggregator.ts`
- Test: `src/lib/aggregators/sites/mein_mmo/comments.test.ts` (new)

**Interfaces:**
- Consumes: `ChromeLabels`, `DEFAULT_CHROME_LABELS` from `../../chrome-labels` (Task 2); `BaseAggregator.chromeLabels()` (Task 3).
- Produces: `extractComments(html, articleUrl, maxComments, labels)` -- signature change only local to this task.

- [ ] **Step 1: Write the failing test**

Create `src/lib/aggregators/sites/mein_mmo/comments.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { DEFAULT_CHROME_LABELS } from "../../chrome-labels";
import { extractComments } from "./comments";

const GERMAN_LABELS = {
  ...DEFAULT_CHROME_LABELS,
  comments: "Kommentare",
  source: "Quelle",
};

function pageWithOneComment(): string {
  return `
    <div class="wpd-thread-list">
      <div class="wpd-comment">
        <div class="wpd-comment-author"><a>Alex</a></div>
        <div class="wpd-comment-right" id="comment-1"></div>
        <div class="wpd-comment-text"><p>Nice article!</p></div>
      </div>
    </div>
  `;
}

describe("extractComments", () => {
  it("renders the Comments heading and source link in English by default", () => {
    const html = extractComments(pageWithOneComment(), "https://mein-mmo.de/a", 5, DEFAULT_CHROME_LABELS);

    expect(html).toContain(">Comments</a></h3>");
    expect(html).toContain(">source</a>");
  });

  it("renders the Comments heading and source link in the passed-in locale's labels", () => {
    const html = extractComments(pageWithOneComment(), "https://mein-mmo.de/a", 5, GERMAN_LABELS);

    expect(html).toContain(">Kommentare</a></h3>");
    expect(html).toContain(">Quelle</a>");
    expect(html).not.toContain("Comments");
    expect(html).not.toContain(">source<");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/aggregators/sites/mein_mmo/comments.test.ts`
Expected: FAIL with a TypeScript error (`extractComments` doesn't accept a 4th argument yet)

- [ ] **Step 3: Thread `labels` through `comments.ts`**

In `src/lib/aggregators/sites/mein_mmo/comments.ts`:

Add the import (after the existing `escapeHtml` import):

```ts
import type { ChromeLabels } from "../../chrome-labels";
```

Change `commentLink()`'s signature is unchanged (it already takes an arbitrary `label: string`), but the two call sites that hardcode a label need `labels`. Replace:

```ts
function processComment(
  commentEl: cheerio.Cheerio<Element>,
  articleUrl: string,
  _$: cheerio.CheerioAPI,
): string | null {
```

with:

```ts
function processComment(
  commentEl: cheerio.Cheerio<Element>,
  articleUrl: string,
  _$: cheerio.CheerioAPI,
  labels: ChromeLabels,
): string | null {
```

and inside that function, replace:

```ts
    `${commentLink(anchorUrl, "source")}</p>` +
```

with:

```ts
    `${commentLink(anchorUrl, labels.source)}</p>` +
```

Then update `extractComments()`'s signature and body. Replace:

```ts
export function extractComments(html: string, articleUrl: string, maxComments = 5): string | null {
```

with:

```ts
export function extractComments(
  html: string,
  articleUrl: string,
  maxComments: number,
  labels: ChromeLabels,
): string | null {
```

Inside the function, replace the `processComment(commentEl, articleUrl, $)` call with:

```ts
    const commentHtml = processComment(commentEl, articleUrl, $, labels);
```

And replace:

```ts
  const header = `<h3>${commentLink(commentsUrl, "Comments")}</h3>`;
```

with:

```ts
  const header = `<h3>${commentLink(commentsUrl, labels.comments)}</h3>`;
```

`maxComments` lost its `= 5` default because it's now followed by a required `labels` parameter -- the one call site (Step 4 below) already always passes an explicit value.

- [ ] **Step 4: Update the call site in `aggregator.ts`**

In `src/lib/aggregators/sites/mein_mmo/aggregator.ts`, inside `processContent()`, replace:

```ts
        const commentSource = firstPageHtml || article.raw_content || "";
        if (commentSource) {
          commentsHtml = extractComments(commentSource, article.identifier, maxComments);
        }
```

with:

```ts
        const commentSource = firstPageHtml || article.raw_content || "";
        if (commentSource) {
          const labels = await this.chromeLabels();
          commentsHtml = extractComments(commentSource, article.identifier, maxComments, labels);
        }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/aggregators/sites/mein_mmo/comments.test.ts`
Expected: PASS (both tests)

- [ ] **Step 6: Run the full Mein-MMO test suite to check nothing else broke**

Run: `npx vitest run src/lib/aggregators/sites/mein_mmo/`
Expected: PASS (all tests, including the pre-existing `aggregator.test.ts` and `content.test.ts`)

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/aggregators/sites/mein_mmo/comments.ts src/lib/aggregators/sites/mein_mmo/aggregator.ts src/lib/aggregators/sites/mein_mmo/comments.test.ts
git commit -m "feat(aggregators): translate Mein-MMO's Comments/source chrome"
```

---

### Task 5: MacTechNews chrome labels

**Files:**
- Modify: `src/lib/aggregators/sites/mactechnews/comments.ts`
- Modify: `src/lib/aggregators/sites/mactechnews/aggregator.ts`
- Test: `src/lib/aggregators/sites/mactechnews/comments.test.ts` (new)

**Interfaces:**
- Consumes: `ChromeLabels`, `DEFAULT_CHROME_LABELS` from `../../chrome-labels` (Task 2); `BaseAggregator.chromeLabels()` (Task 3).
- Produces: `extractComments(html, articleUrl, maxComments, labels)` (mirrors Task 4's shape, independent file).

This file is structurally identical to Task 4's -- same `commentLink()` helper, same `processComment()`/`extractComments()` shape, same call site pattern in `processContent()`. It is independent of Task 4 (no shared code between the two `comments.ts` files) and can run in parallel.

- [ ] **Step 1: Write the failing test**

Create `src/lib/aggregators/sites/mactechnews/comments.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { DEFAULT_CHROME_LABELS } from "../../chrome-labels";
import { extractComments } from "./comments";

const GERMAN_LABELS = {
  ...DEFAULT_CHROME_LABELS,
  comments: "Kommentare",
  source: "Quelle",
};

function pageWithOneComment(): string {
  return `
    <div class="MtnCommentScroll">
      <div id="comment-1">
        <span class="MtnCommentAccountName">Alex</span>
        <span class="MtnCommentTime"><span>2026-01-01</span></span>
        <div class="MtnCommentText"><p>Nice article!</p></div>
      </div>
    </div>
  `;
}

describe("extractComments", () => {
  it("renders the Comments heading and source link in English by default", () => {
    const html = extractComments(pageWithOneComment(), "https://mactechnews.de/a", 5, DEFAULT_CHROME_LABELS);

    expect(html).toContain(">Comments</a></h3>");
    expect(html).toContain(">source</a>");
  });

  it("renders the Comments heading and source link in the passed-in locale's labels", () => {
    const html = extractComments(pageWithOneComment(), "https://mactechnews.de/a", 5, GERMAN_LABELS);

    expect(html).toContain(">Kommentare</a></h3>");
    expect(html).toContain(">Quelle</a>");
    expect(html).not.toContain("Comments");
    expect(html).not.toContain(">source<");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/aggregators/sites/mactechnews/comments.test.ts`
Expected: FAIL with a TypeScript error (`extractComments` doesn't accept a 4th argument yet)

- [ ] **Step 3: Thread `labels` through `comments.ts`**

In `src/lib/aggregators/sites/mactechnews/comments.ts`, add the import (after the `escapeHtml` import):

```ts
import type { ChromeLabels } from "../../chrome-labels";
```

Replace:

```ts
function processComment(
  commentEl: cheerio.Cheerio<Element>,
  articleUrl: string,
  $: cheerio.CheerioAPI,
): string | null {
```

with:

```ts
function processComment(
  commentEl: cheerio.Cheerio<Element>,
  articleUrl: string,
  $: cheerio.CheerioAPI,
  labels: ChromeLabels,
): string | null {
```

Inside that function, replace:

```ts
    `${commentLink(anchorUrl, "source")}</p>` +
```

with:

```ts
    `${commentLink(anchorUrl, labels.source)}</p>` +
```

Replace:

```ts
export function extractComments(html: string, articleUrl: string, maxComments = 5): string | null {
```

with:

```ts
export function extractComments(
  html: string,
  articleUrl: string,
  maxComments: number,
  labels: ChromeLabels,
): string | null {
```

Inside the function, find the loop that calls `processComment(commentEl, articleUrl, $)` and replace it with:

```ts
    const commentHtml = processComment(commentEl, articleUrl, $, labels);
```

And replace:

```ts
  const header = `<h3>${commentLink(commentsUrl, "Comments")}</h3>`;
```

with:

```ts
  const header = `<h3>${commentLink(commentsUrl, labels.comments)}</h3>`;
```

- [ ] **Step 4: Update the call site in `aggregator.ts`**

In `src/lib/aggregators/sites/mactechnews/aggregator.ts`, `processContent()` is not currently marked `async` (it's typed `string | Promise<string>` but has no `await` in its body). Change its signature from:

```ts
  override processContent(html: string, article: RawArticle): string | Promise<string> {
```

to:

```ts
  override async processContent(html: string, article: RawArticle): Promise<string> {
```

Then replace:

```ts
        const rawHtml = article.raw_content || "";
        if (rawHtml) {
          commentsHtml = extractComments(rawHtml, article.identifier, maxComments);
        }
```

with:

```ts
        const rawHtml = article.raw_content || "";
        if (rawHtml) {
          const labels = await this.chromeLabels();
          commentsHtml = extractComments(rawHtml, article.identifier, maxComments, labels);
        }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/aggregators/sites/mactechnews/comments.test.ts`
Expected: PASS (both tests)

- [ ] **Step 6: Run the rest of the mactechnews suite (if any) and website.test.ts**

Run: `npx vitest run src/lib/aggregators/sites/mactechnews/ src/lib/aggregators/website.test.ts`
Expected: PASS (mactechnews has no other test files today; this also re-checks `FullWebsiteAggregator`'s own tests are unaffected)

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/aggregators/sites/mactechnews/comments.ts src/lib/aggregators/sites/mactechnews/aggregator.ts src/lib/aggregators/sites/mactechnews/comments.test.ts
git commit -m "feat(aggregators): translate MacTechNews's Comments/source chrome"
```

---

### Task 6: Heise chrome labels

**Files:**
- Modify: `src/lib/aggregators/sites/heise.ts`
- Test: `src/lib/aggregators/sites/heise.test.ts` (new)

**Interfaces:**
- Consumes: `ChromeLabels`, `DEFAULT_CHROME_LABELS` from `../chrome-labels` (Task 2); `BaseAggregator.chromeLabels()` (Task 3, inherited via `FullWebsiteAggregator`).
- Produces: `HeiseAggregator.extractComments(articleUrl, articleHtml, maxComments, labels)` -- a public method, independent of Tasks 4/5/7-9.

This is Heise's own comment-extraction shape (fetches a separate forum page over the network, unlike Mein-MMO/MacTechNews which parse comments already embedded in the article page) -- structurally different from Task 4/5, but the same two strings ("Comments" heading, "source" link).

- [ ] **Step 1: Write the failing test**

Create `src/lib/aggregators/sites/heise.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FeedLike } from "../base";
import { DEFAULT_CHROME_LABELS } from "../chrome-labels";
import { HeiseAggregator } from "./heise";

vi.mock("../http/fetcher", () => ({
  fetchHtml: vi.fn(),
}));

function aggregatorFor(): HeiseAggregator {
  const feed: FeedLike = { identifier: "https://www.heise.de/", dailyLimit: 20 };
  return new HeiseAggregator(feed);
}

const ARTICLE_HTML = `
  <html><body>
    <script type="application/ld+json">{"discussionUrl": "https://www.heise.de/forum/x/Kommentare/y/list"}</script>
  </body></html>
`;

const FORUM_HTML = `
  <html><body>
    <li class="posting_element" id="posting_1">
      <a class="posting_subject" href="/forum/x/y/1">A reply</a>
      <span class="pseudonym">Alex</span>
    </li>
  </body></html>
`;

describe("HeiseAggregator.extractComments", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Comments heading and source link in English by default", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(FORUM_HTML);

    const agg = aggregatorFor();
    const html = await agg.extractComments(
      "https://www.heise.de/a",
      ARTICLE_HTML,
      5,
      DEFAULT_CHROME_LABELS,
    );

    expect(html).toContain(">Comments</a></h3>");
    expect(html).toContain(">source</a>");
  });

  it("renders the Comments heading and source link in the passed-in locale's labels", async () => {
    const { fetchHtml } = await import("../http/fetcher");
    vi.mocked(fetchHtml).mockResolvedValue(FORUM_HTML);

    const agg = aggregatorFor();
    const germanLabels = { ...DEFAULT_CHROME_LABELS, comments: "Kommentare", source: "Quelle" };
    const html = await agg.extractComments("https://www.heise.de/a", ARTICLE_HTML, 5, germanLabels);

    expect(html).toContain(">Kommentare</a></h3>");
    expect(html).toContain(">Quelle</a>");
    expect(html).not.toContain(">source<");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/aggregators/sites/heise.test.ts`
Expected: FAIL with a TypeScript error (`extractComments` doesn't accept a 4th argument yet)

- [ ] **Step 3: Thread `labels` through `heise.ts`**

Add the import at the top of `src/lib/aggregators/sites/heise.ts` (after the `fetchHtml` import):

```ts
import type { ChromeLabels } from "../chrome-labels";
```

Replace:

```ts
function commentSourceLink(url: string): string {
  if (isSafeUrl(url)) {
    return `<a href="${escapeHtml(url)}">source</a>`;
  }
  return "source";
}
```

with:

```ts
function commentSourceLink(url: string, labels: ChromeLabels): string {
  if (isSafeUrl(url)) {
    return `<a href="${escapeHtml(url)}">${labels.source}</a>`;
  }
  return labels.source;
}
```

Replace:

```ts
function processListItemComment($: cheerio.CheerioAPI, el: Element): string | null {
```

with:

```ts
function processListItemComment(
  $: cheerio.CheerioAPI,
  el: Element,
  labels: ChromeLabels,
): string | null {
```

and inside it, replace `${commentSourceLink(commentUrl)}</p>` with `${commentSourceLink(commentUrl, labels)}</p>`.

Replace:

```ts
function processFullViewComment(
  $: cheerio.CheerioAPI,
  el: Element,
  index: number,
  articleUrl: string,
): string | null {
```

with:

```ts
function processFullViewComment(
  $: cheerio.CheerioAPI,
  el: Element,
  index: number,
  articleUrl: string,
  labels: ChromeLabels,
): string | null {
```

and inside it, replace `${commentSourceLink(commentUrl)}</p>` with `${commentSourceLink(commentUrl, labels)}</p>`.

Now update the class method. Replace:

```ts
  async extractComments(
    articleUrl: string,
    articleHtml: string,
    maxComments = 5,
  ): Promise<string | null> {
```

with:

```ts
  async extractComments(
    articleUrl: string,
    articleHtml: string,
    maxComments: number,
    labels: ChromeLabels,
  ): Promise<string | null> {
```

Inside that method, replace:

```ts
        const commentHtml =
          el.name === "li"
            ? processListItemComment($, el)
            : processFullViewComment($, el, i, articleUrl);
```

with:

```ts
        const commentHtml =
          el.name === "li"
            ? processListItemComment($, el, labels)
            : processFullViewComment($, el, i, articleUrl, labels);
```

And replace:

```ts
      const header = `<h3><a href="${escapeHtml(forumUrl)}">Comments</a></h3>`;
```

with:

```ts
      const header = `<h3><a href="${escapeHtml(forumUrl)}">${labels.comments}</a></h3>`;
```

Finally, update the one call site inside `processContent()`. Replace:

```ts
        const rawHtml = article.raw_content || "";
        if (rawHtml) {
          commentsHtml = await this.extractComments(article.identifier, rawHtml, maxComments);
        }
```

with:

```ts
        const rawHtml = article.raw_content || "";
        if (rawHtml) {
          const labels = await this.chromeLabels();
          commentsHtml = await this.extractComments(article.identifier, rawHtml, maxComments, labels);
        }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/aggregators/sites/heise.test.ts`
Expected: PASS (both tests)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/aggregators/sites/heise.ts src/lib/aggregators/sites/heise.test.ts
git commit -m "feat(aggregators): translate Heise's Comments/source chrome"
```

---

### Task 7: Reddit chrome labels -- `comments.ts` and `content.ts`

**Files:**
- Modify: `src/lib/aggregators/sites/reddit/comments.ts`
- Modify: `src/lib/aggregators/sites/reddit/content.ts`
- Modify: `src/lib/aggregators/sites/reddit/content.test.ts` (existing calls need a `labels` argument)
- Test: `src/lib/aggregators/sites/reddit/comments.test.ts` (existing file, add a new `describe` block)

**Interfaces:**
- Consumes: `ChromeLabels`, `DEFAULT_CHROME_LABELS` from `../../chrome-labels` (Task 2).
- Produces: `formatCommentHtml(comment, labels)`; `buildPostContent(post, commentLimit, subreddit, labels, userId?, isCrossPost?, commentsList?)` (note: `labels` moved before the existing optional parameters, since TypeScript disallows a required parameter after an optional one) -- both consumed by Task 8's `aggregator.ts` changes. **Task 8 depends on this task's `buildPostContent()` signature.**

- [ ] **Step 1: Write the failing test for `formatCommentHtml`**

Open `src/lib/aggregators/sites/reddit/comments.test.ts` and add, at the end of the file:

```ts
import { DEFAULT_CHROME_LABELS } from "../../chrome-labels";
import { formatCommentHtml } from "./comments";
import { RedditComment } from "./types";

describe("formatCommentHtml", () => {
  function comment(): RedditComment {
    return new RedditComment({
      author: "Alex",
      body: "Nice post!",
      permalink: "/r/test/comments/abc123/post/def456/",
      score: 1,
    } as never);
  }

  it("renders the source link in English by default", () => {
    const html = formatCommentHtml(comment(), DEFAULT_CHROME_LABELS);
    expect(html).toContain(">source</a>");
  });

  it("renders the source link in the passed-in locale's labels", () => {
    const html = formatCommentHtml(comment(), { ...DEFAULT_CHROME_LABELS, source: "Quelle" });
    expect(html).toContain(">Quelle</a>");
    expect(html).not.toContain(">source<");
  });
});
```

(Add the three new imports to the top of the file alongside the existing `import { afterEach, describe, expect, it, vi } from "vitest";` and `import { ArticleSkipError } from "../../errors";` lines, rather than inline -- ESLint's import ordering will otherwise flag it.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/aggregators/sites/reddit/comments.test.ts`
Expected: FAIL with a TypeScript error (`formatCommentHtml` doesn't accept a 2nd argument yet)

- [ ] **Step 3: Thread `labels` through `comments.ts`**

Add the import at the top of `src/lib/aggregators/sites/reddit/comments.ts` (after the `errors` import):

```ts
import type { ChromeLabels } from "../../chrome-labels";
```

Replace:

```ts
export function formatCommentHtml(comment: RedditComment): string {
  const author = comment.author || "[deleted]";
  const body = convertRedditMarkdown(comment.body || "");
  const commentUrl = `https://reddit.com${comment.permalink}`;

  return `\n<blockquote>\n<p><strong>${escapeHtml(author)}</strong> | ${safeLinkHtml(
    commentUrl,
    "source",
  )}</p>\n<div>${body}</div>\n</blockquote>\n`;
}
```

with:

```ts
export function formatCommentHtml(comment: RedditComment, labels: ChromeLabels): string {
  const author = comment.author || "[deleted]";
  const body = convertRedditMarkdown(comment.body || "");
  const commentUrl = `https://reddit.com${comment.permalink}`;

  return `\n<blockquote>\n<p><strong>${escapeHtml(author)}</strong> | ${safeLinkHtml(
    commentUrl,
    labels.source,
  )}</p>\n<div>${body}</div>\n</blockquote>\n`;
}
```

- [ ] **Step 4: Run the `comments.ts` test to verify it passes**

Run: `npx vitest run src/lib/aggregators/sites/reddit/comments.test.ts`
Expected: PASS (all tests, including the pre-existing `fetchPostComments` ones)

- [ ] **Step 5: Update `content.test.ts`'s existing calls**

`buildPostContent`'s signature is about to change (Step 6 below moves `labels` to be its 4th parameter, before the existing optional `userId`/`isCrossPost`/`commentsList`). Update `src/lib/aggregators/sites/reddit/content.test.ts`'s three call sites now, so the file compiles the moment Step 6 lands:

Add the import at the top of the file (after the existing `import { buildPostContent } from "./content";` line):

```ts
import { DEFAULT_CHROME_LABELS } from "../../chrome-labels";
```

Replace:

```ts
    const html = await buildPostContent(post, 0, "test");
```

with:

```ts
    const html = await buildPostContent(post, 0, "test", DEFAULT_CHROME_LABELS);
```

Replace:

```ts
    await expect(buildPostContent(post(), 10, "test")).rejects.toThrow(ArticleSkipError);
```

with:

```ts
    await expect(
      buildPostContent(post(), 10, "test", DEFAULT_CHROME_LABELS),
    ).rejects.toThrow(ArticleSkipError);
```

Replace:

```ts
    const html = await buildPostContent(post(), 10, "test");
    expect(html).toContain("No comments yet.");
```

with:

```ts
    const html = await buildPostContent(post(), 10, "test", DEFAULT_CHROME_LABELS);
    expect(html).toContain("No comments yet.");
```

- [ ] **Step 6: Thread `labels` through `content.ts`**

Add the import at the top of `src/lib/aggregators/sites/reddit/content.ts` (after the `errors` import):

```ts
import type { ChromeLabels } from "../../chrome-labels";
```

Replace the `buildPostContent()` signature and body:

```ts
export async function buildPostContent(
  post: RedditPostData,
  commentLimit: number,
  subreddit: string,
  userId?: number | string | null,
  isCrossPost = false,
  commentsList?: RedditComment[],
): Promise<string> {
  const contentParts: string[] = [];

  // 1. Selftext
  if (post.selftext) {
    const selftextHtml = convertRedditMarkdown(post.selftext);
    contentParts.push(`<div>${selftextHtml}</div>`);
  }

  // 2. Gallery media
  addGalleryMedia(post, contentParts);

  // 3. Link media
  addLinkMedia(post, contentParts, isCrossPost);

  // 4. Comments section
  await addCommentsSection(post, commentLimit, subreddit, userId, contentParts, commentsList);

  return contentParts.join("");
}
```

with:

```ts
export async function buildPostContent(
  post: RedditPostData,
  commentLimit: number,
  subreddit: string,
  labels: ChromeLabels,
  userId?: number | string | null,
  isCrossPost = false,
  commentsList?: RedditComment[],
): Promise<string> {
  const contentParts: string[] = [];

  // 1. Selftext
  if (post.selftext) {
    const selftextHtml = convertRedditMarkdown(post.selftext);
    contentParts.push(`<div>${selftextHtml}</div>`);
  }

  // 2. Gallery media
  addGalleryMedia(post, contentParts);

  // 3. Link media
  addLinkMedia(post, contentParts, isCrossPost, labels);

  // 4. Comments section
  await addCommentsSection(post, commentLimit, subreddit, userId, contentParts, labels, commentsList);

  return contentParts.join("");
}
```

Replace:

```ts
function addLinkMedia(post: RedditPostData, contentParts: string[], isCrossPost: boolean): void {
  if (!post.url || post.is_gallery) return;

  const url = decodeHtmlEntitiesInUrl(post.url);

  if (processLinkMedia(post, url, contentParts)) {
    return;
  }

  if (!isCrossPost && !post.is_self) {
    contentParts.push(`<p>${safeLinkHtml(url, url)}</p>`);
  }
}

function processLinkMedia(post: RedditPostData, url: string, contentParts: string[]): boolean {
```

with:

```ts
function addLinkMedia(
  post: RedditPostData,
  contentParts: string[],
  isCrossPost: boolean,
  labels: ChromeLabels,
): void {
  if (!post.url || post.is_gallery) return;

  const url = decodeHtmlEntitiesInUrl(post.url);

  if (processLinkMedia(post, url, contentParts, labels)) {
    return;
  }

  if (!isCrossPost && !post.is_self) {
    contentParts.push(`<p>${safeLinkHtml(url, url)}</p>`);
  }
}

function processLinkMedia(
  post: RedditPostData,
  url: string,
  contentParts: string[],
  labels: ChromeLabels,
): boolean {
```

Inside `processLinkMedia()`, replace:

```ts
  if (urlLower.includes("youtube.com") || urlLower.includes("youtu.be")) {
    contentParts.push(`<p>${safeLinkHtml(url, "▶ View Video on YouTube")}</p>`);
    return true;
  }
```

with:

```ts
  if (urlLower.includes("youtube.com") || urlLower.includes("youtu.be")) {
    contentParts.push(`<p>${safeLinkHtml(url, labels.viewVideoOnYoutube)}</p>`);
    return true;
  }
```

Replace the `addCommentsSection()` signature and body:

```ts
async function addCommentsSection(
  post: RedditPostData,
  commentLimit: number,
  subreddit: string,
  userId: number | string | null | undefined,
  contentParts: string[],
  providedComments?: RedditComment[],
): Promise<void> {
  const decodedPermalink = decodeHtmlEntitiesInUrl(post.permalink);
  const permalink = `https://reddit.com${decodedPermalink}`;
  const commentSectionParts: string[] = [`<h3>${safeLinkHtml(permalink, "Comments")}</h3>`];

  if (commentLimit > 0) {
    try {
      const comments =
        providedComments !== undefined
          ? providedComments
          : await fetchPostComments(subreddit, post.id, commentLimit, userId);

      if (comments && comments.length > 0) {
        const commentHtmls = comments.map(formatCommentHtml);
        commentSectionParts.push(commentHtmls.join(""));
      } else {
        commentSectionParts.push("<p><em>No comments yet.</em></p>");
      }
    } catch (err) {
      // A 403/404 from the comments endpoint means the post itself is private,
      // removed or gone -- `fetchPostComments()` reports that as an
      // `ArticleSkipError` and the caller drops the article. Swallowing it here
      // would silently reinstate the bug that fix by degrading a skipped post
      // into one whose body says "Comments unavailable." Production always
      // pre-fetches (`aggregator.ts` passes `commentsList`), so this path is
      // reachable only from a future caller that does not -- which is exactly
      // when the guard has to already be here.
      if (err instanceof ArticleSkipError) throw err;
      commentSectionParts.push("<p><em>Comments unavailable.</em></p>");
    }
  } else {
    commentSectionParts.push("<p><em>Comments disabled.</em></p>");
  }

  contentParts.push(`<section>${commentSectionParts.join("")}</section>`);
}
```

with:

```ts
async function addCommentsSection(
  post: RedditPostData,
  commentLimit: number,
  subreddit: string,
  userId: number | string | null | undefined,
  contentParts: string[],
  labels: ChromeLabels,
  providedComments?: RedditComment[],
): Promise<void> {
  const decodedPermalink = decodeHtmlEntitiesInUrl(post.permalink);
  const permalink = `https://reddit.com${decodedPermalink}`;
  const commentSectionParts: string[] = [`<h3>${safeLinkHtml(permalink, labels.comments)}</h3>`];

  if (commentLimit > 0) {
    try {
      const comments =
        providedComments !== undefined
          ? providedComments
          : await fetchPostComments(subreddit, post.id, commentLimit, userId);

      if (comments && comments.length > 0) {
        const commentHtmls = comments.map((comment) => formatCommentHtml(comment, labels));
        commentSectionParts.push(commentHtmls.join(""));
      } else {
        commentSectionParts.push(`<p><em>${labels.noCommentsYet}</em></p>`);
      }
    } catch (err) {
      // A 403/404 from the comments endpoint means the post itself is private,
      // removed or gone -- `fetchPostComments()` reports that as an
      // `ArticleSkipError` and the caller drops the article. Swallowing it here
      // would silently reinstate the bug that fix by degrading a skipped post
      // into one whose body says "Comments unavailable." Production always
      // pre-fetches (`aggregator.ts` passes `commentsList`), so this path is
      // reachable only from a future caller that does not -- which is exactly
      // when the guard has to already be here.
      if (err instanceof ArticleSkipError) throw err;
      commentSectionParts.push(`<p><em>${labels.commentsUnavailable}</em></p>`);
    }
  } else {
    commentSectionParts.push(`<p><em>${labels.commentsDisabled}</em></p>`);
  }

  contentParts.push(`<section>${commentSectionParts.join("")}</section>`);
}
```

- [ ] **Step 7: Run the reddit content/comments tests to verify they pass**

Run: `npx vitest run src/lib/aggregators/sites/reddit/content.test.ts src/lib/aggregators/sites/reddit/comments.test.ts`
Expected: PASS (all tests)

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/aggregators/sites/reddit/comments.ts src/lib/aggregators/sites/reddit/content.ts src/lib/aggregators/sites/reddit/comments.test.ts src/lib/aggregators/sites/reddit/content.test.ts
git commit -m "feat(aggregators): translate Reddit's comment/video chrome in content.ts"
```

---

### Task 8: Reddit chrome labels -- `aggregator.ts`

**Depends on:** Task 7 (`buildPostContent()`'s new signature, `formatCommentHtml()`'s new signature).

**Files:**
- Modify: `src/lib/aggregators/sites/reddit/aggregator.ts`
- Test: `src/lib/aggregators/sites/reddit/aggregator.test.ts` (add new tests; existing ones are unaffected since none of them exercise the three touched code paths today)

**Interfaces:**
- Consumes: `ChromeLabels` from `../../chrome-labels` (Task 2); `BaseAggregator.chromeLabels()` (Task 3); `buildPostContent(post, commentLimit, subreddit, labels, userId?, isCrossPost?, commentsList?)` and `formatCommentHtml(comment, labels)` (Task 7).

There are three independent spots in this file, none of which call into `content.ts` -- each reimplements its own version of the content-building inline.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/aggregators/sites/reddit/aggregator.test.ts`, at the end of the file (before the final closing of the file, i.e. just append):

```ts
describe("RedditAggregator.finalizeArticles video-link header caption", () => {
  it("renders the View Video caption", async () => {
    const agg = aggregatorFor({});

    const [finalized] = await agg.finalizeArticles([
      article({
        _reddit_header_image_url: "https://preview.redd.it/a/preview.jpg",
        _reddit_video_url: "https://v.redd.it/a",
      }),
    ]);

    expect(finalized!.content).toContain("▶ View Video");
  });
});
```

This test passes even before Step 3's changes (it asserts the same English string that's already hardcoded today) -- it exists to catch a regression during Step 3, not to prove new behavior on its own. The real proof that `labels` is actually threaded through (not just present as an unused parameter) is the German-locale test below, which exercises Spot 3 -- the only one of the three spots whose behavior is pure synchronous JSON parsing, with no network calls to mock.

Add a database-backed test for `extractContent()`'s legacy JSON branch (Spot 3). This needs real database setup (unlike the rest of this test file). Add these imports at the top of the file, alongside the existing ones (node builtins first, then third-party, then relative -- matching this repo's import-group ordering):

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
```

Then add, at the end of the file:

```ts
describe("RedditAggregator.extractContent legacy JSON locale", () => {
  let dbPath: string;
  let client: typeof import("../../../db/client");
  let schema: typeof import("../../../db/schema");

  beforeEach(async () => {
    dbPath = path.join(
      os.tmpdir(),
      `yana-reddit-locale-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    const { applyMigrationsAt } = await import("../../../db/test-support");
    applyMigrationsAt(dbPath);

    client = await import("../../../db/client");
    schema = await import("../../../db/schema");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("renders the Comments heading in the feed owner's language", async () => {
    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id: "user1", email: "user1@example.com" }).run();
      db.insert(schema.userSettings).values({ userId: "user1", language: "de" }).run();
    });

    const feed: FeedLike = { identifier: "test", dailyLimit: 20, userId: "user1" };
    const agg = new RedditAggregator(feed);

    // The legacy JSON shape extractContent() falls back to parsing when its
    // input isn't already-built content HTML -- a raw post dict with at
    // least `id` and `title`. No network call happens on this path.
    const legacyJson = JSON.stringify({
      id: "abc123",
      title: "A post",
      permalink: "/r/test/comments/abc123/post/",
      is_self: true,
      selftext: "hello",
    });

    const html = await agg.extractContent(legacyJson, article());

    expect(html).toContain("Kommentare");
    expect(html).not.toContain(">Comments<");
  });
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run src/lib/aggregators/sites/reddit/aggregator.test.ts`
Expected: FAIL -- `extractContent` isn't `async` yet and doesn't call `chromeLabels()`, so the new German-locale test fails (the returned HTML still says "Comments", not "Kommentare"). The header-caption test passes already; that's expected.

- [ ] **Step 3: Thread `labels` through the three spots in `aggregator.ts`**

Add the import at the top of `src/lib/aggregators/sites/reddit/aggregator.ts` (alongside the other relative imports):

```ts
import type { ChromeLabels } from "../../chrome-labels";
```

**Spot 1 -- `fetchArticleContent()`.** Find the end of this method (it currently ends with a call to `buildPostContent(...)`):

```ts
    return buildPostContent(
      effectivePostData,
      commentLimit,
      effectiveSubreddit,
      this.feed.userId,
      isCrossPost,
      comments,
    );
  }
```

Replace with:

```ts
    const labels = await this.chromeLabels();
    return buildPostContent(
      effectivePostData,
      commentLimit,
      effectiveSubreddit,
      labels,
      this.feed.userId,
      isCrossPost,
      comments,
    );
  }
```

**Spot 2 -- the header-caption builder inside `finalizeArticles()`.** Replace:

```ts
          let headerCaptionHtml: string | null = null;
          const videoUrl = article._reddit_video_url as string | null;
          if (videoUrl && !isYoutubeHeader) {
            headerCaptionHtml = `<p>${safeLinkHtml(videoUrl, "▶ View Video")}</p>`;
          }
```

with:

```ts
          let headerCaptionHtml: string | null = null;
          const videoUrl = article._reddit_video_url as string | null;
          if (videoUrl && !isYoutubeHeader) {
            const labels = await this.chromeLabels();
            headerCaptionHtml = `<p>${safeLinkHtml(videoUrl, labels.viewVideo)}</p>`;
          }
```

**Spot 3 -- the legacy JSON-shaped `extractContent()` override.** First, change its signature from sync to async. Replace:

```ts
  override extractContent(html: string, _article: RawArticle): string {
    if (!html) return "";
```

with:

```ts
  override async extractContent(html: string, _article: RawArticle): Promise<string> {
    if (!html) return "";
```

Then, inside the `if (postDict) {` block, right after the `const isCrossPost = Boolean(...)` line and before `const contentParts: string[] = [];`, add:

```ts
          const labels = await this.chromeLabels();
```

so that block reads:

```ts
        if (postDict) {
          const postData = new RedditPostData(postDict);
          const includeComments = (this.feed.options?.include_comments as boolean) ?? true;
          const commentLimit = includeComments
            ? ((this.feed.options?.comment_limit as number) ?? 10)
            : 0;
          const subreddit = postDict.subreddit || normalizeSubreddit(this.identifier);
          const isCrossPost = Boolean(
            postData.crosspost_parent_list && postData.crosspost_parent_list.length > 0,
          );
          const labels = await this.chromeLabels();

          const contentParts: string[] = [];
```

Then, further down in the same block, replace:

```ts
            } else if (urlLower.includes("youtube.com") || urlLower.includes("youtu.be")) {
              contentParts.push(`<p>${safeLinkHtml(url, "▶ View Video on YouTube")}</p>`);
```

with:

```ts
            } else if (urlLower.includes("youtube.com") || urlLower.includes("youtu.be")) {
              contentParts.push(`<p>${safeLinkHtml(url, labels.viewVideoOnYoutube)}</p>`);
```

And replace:

```ts
          const decodedPermalink = decodeHtmlEntitiesInUrl(postData.permalink);
          const permalink = `https://reddit.com${decodedPermalink}`;
          const commentSectionParts: string[] = [`<h3>${safeLinkHtml(permalink, "Comments")}</h3>`];

          if (commentLimit > 0) {
            if (commentsList && commentsList.length > 0) {
              const sliced = commentsList.slice(0, commentLimit);
              const commentHtmls = sliced.map((c: RedditComment) => formatCommentHtml(c));
              commentSectionParts.push(commentHtmls.join(""));
            } else {
              commentSectionParts.push("<p><em>No comments yet.</em></p>");
            }
          } else {
            commentSectionParts.push("<p><em>Comments disabled.</em></p>");
          }
```

with:

```ts
          const decodedPermalink = decodeHtmlEntitiesInUrl(postData.permalink);
          const permalink = `https://reddit.com${decodedPermalink}`;
          const commentSectionParts: string[] = [
            `<h3>${safeLinkHtml(permalink, labels.comments)}</h3>`,
          ];

          if (commentLimit > 0) {
            if (commentsList && commentsList.length > 0) {
              const sliced = commentsList.slice(0, commentLimit);
              const commentHtmls = sliced.map((c: RedditComment) => formatCommentHtml(c, labels));
              commentSectionParts.push(commentHtmls.join(""));
            } else {
              commentSectionParts.push(`<p><em>${labels.noCommentsYet}</em></p>`);
            }
          } else {
            commentSectionParts.push(`<p><em>${labels.commentsDisabled}</em></p>`);
          }
```

- [ ] **Step 4: Run the reddit aggregator tests to verify they pass**

Run: `npx vitest run src/lib/aggregators/sites/reddit/aggregator.test.ts`
Expected: PASS (all tests, including the two new ones)

- [ ] **Step 5: Run the full reddit test suite**

Run: `npx vitest run src/lib/aggregators/sites/reddit/`
Expected: PASS (all files)

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/aggregators/sites/reddit/aggregator.ts src/lib/aggregators/sites/reddit/aggregator.test.ts
git commit -m "feat(aggregators): translate Reddit's remaining chrome in aggregator.ts"
```

---

### Task 9: YouTube chrome labels

**Files:**
- Modify: `src/lib/aggregators/sites/youtube/aggregator.ts`
- Modify: `src/lib/aggregators/sites/youtube/aggregator.test.ts` (existing `buildContentHtml` calls need a `labels` argument; add a new German-locale test)

**Interfaces:**
- Consumes: `ChromeLabels`, `DEFAULT_CHROME_LABELS` from `../../chrome-labels` (Task 2); `BaseAggregator.chromeLabels()` (Task 3).
- Produces: `buildContentHtml(description, comments, videoId, labels)` -- public method, no other file consumes it.

- [ ] **Step 1: Update the existing test call sites and add a new one**

In `src/lib/aggregators/sites/youtube/aggregator.test.ts`, add the import at the top (alongside the existing relative imports):

```ts
import { DEFAULT_CHROME_LABELS } from "../../chrome-labels";
```

Replace each of the four `agg.buildContentHtml(...)` calls to add `DEFAULT_CHROME_LABELS` as the 4th argument:

```ts
    const html = agg.buildContentHtml("<script>alert(1)</script>", [], "vid1");
```
→
```ts
    const html = agg.buildContentHtml("<script>alert(1)</script>", [], "vid1", DEFAULT_CHROME_LABELS);
```

```ts
    const html = agg.buildContentHtml("<img src=x onerror=alert(1)>", [], "vid1");
```
→
```ts
    const html = agg.buildContentHtml("<img src=x onerror=alert(1)>", [], "vid1", DEFAULT_CHROME_LABELS);
```

```ts
    const html = agg.buildContentHtml("line one\nline two", [], "vid1");
```
→
```ts
    const html = agg.buildContentHtml("line one\nline two", [], "vid1", DEFAULT_CHROME_LABELS);
```

```ts
    const html = agg.buildContentHtml("hello", comments, "vid1");
```
→
```ts
    const html = agg.buildContentHtml("hello", comments, "vid1", DEFAULT_CHROME_LABELS);
```

Also add a new test right after the "appends sanitized comments after the escaped description" test, still inside `describe("YouTubeAggregator.buildContentHtml", ...)`:

```ts
  it("renders the Comments heading and per-comment source link in the passed-in locale's labels", () => {
    const agg = aggregatorFor();
    const comments: YouTubeCommentThread[] = [
      {
        id: "c1",
        snippet: {
          topLevelComment: {
            snippet: {
              authorDisplayName: "Someone",
              textDisplay: "nice video",
            },
          },
        },
      },
    ];

    const germanLabels = { ...DEFAULT_CHROME_LABELS, comments: "Kommentare", source: "Quelle" };
    const html = agg.buildContentHtml("hello", comments, "vid1", germanLabels);

    expect(html).toContain(">Kommentare</h3>");
    expect(html).toContain(">Quelle</a>");
    expect(html).not.toContain(">Comments<");
    expect(html).not.toContain(">source<");
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/aggregators/sites/youtube/aggregator.test.ts`
Expected: FAIL with a TypeScript error (`buildContentHtml` doesn't accept a 4th argument yet)

- [ ] **Step 3: Thread `labels` through `buildContentHtml()`, `enrichArticles()`, and `extractContent()`**

Add the import at the top of `src/lib/aggregators/sites/youtube/aggregator.ts` (alongside the other relative imports):

```ts
import type { ChromeLabels } from "../../chrome-labels";
```

Replace:

```ts
  override async enrichArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    let client: YouTubeClient | null = null;
    try {
      client = this.getClient();
    } catch {
      // Client optional if no key available
    }

    const commentLimit = (this.feed.options?.comment_limit as number) ?? 10;

    await mapWithConcurrency(articles, this.concurrency, async (article) => {
      const videoId = article._youtube_video_id;
      const description = article.content || "";

      let comments: YouTubeCommentThread[] = [];
      if (typeof videoId === "string" && client) {
        comments = await client.fetchVideoComments(videoId, commentLimit);
      }

      const contentHtml = this.buildContentHtml(
        description,
        comments,
        typeof videoId === "string" ? videoId : "",
      );
      article.content = contentHtml;
      article.raw_content = contentHtml;
    });

    return articles;
  }

  buildContentHtml(description: string, comments: YouTubeCommentThread[], videoId: string): string {
```

with:

```ts
  override async enrichArticles(articles: RawArticle[]): Promise<RawArticle[]> {
    let client: YouTubeClient | null = null;
    try {
      client = this.getClient();
    } catch {
      // Client optional if no key available
    }

    const commentLimit = (this.feed.options?.comment_limit as number) ?? 10;
    const labels = await this.chromeLabels();

    await mapWithConcurrency(articles, this.concurrency, async (article) => {
      const videoId = article._youtube_video_id;
      const description = article.content || "";

      let comments: YouTubeCommentThread[] = [];
      if (typeof videoId === "string" && client) {
        comments = await client.fetchVideoComments(videoId, commentLimit);
      }

      const contentHtml = this.buildContentHtml(
        description,
        comments,
        typeof videoId === "string" ? videoId : "",
        labels,
      );
      article.content = contentHtml;
      article.raw_content = contentHtml;
    });

    return articles;
  }

  buildContentHtml(
    description: string,
    comments: YouTubeCommentThread[],
    videoId: string,
    labels: ChromeLabels,
  ): string {
```

Inside `buildContentHtml()`, replace:

```ts
    if (comments && comments.length > 0) {
      htmlContent += `<div class="youtube-comments"><h3>Comments</h3>`;
```

with:

```ts
    if (comments && comments.length > 0) {
      htmlContent += `<div class="youtube-comments"><h3>${labels.comments}</h3>`;
```

and replace:

```ts
        htmlContent += `\n<blockquote>\n<p><strong>${authorHtml}</strong> | <a href="${commentUrl}" target="_blank" rel="noopener">source</a></p>\n<div>${sanitizedBody}</div>\n</blockquote>\n`;
```

with:

```ts
        htmlContent += `\n<blockquote>\n<p><strong>${authorHtml}</strong> | <a href="${commentUrl}" target="_blank" rel="noopener">${labels.source}</a></p>\n<div>${sanitizedBody}</div>\n</blockquote>\n`;
```

Now update `extractContent()`. Replace:

```ts
  override extractContent(html: string, article: RawArticle): string {
    if (this._last_reloaded_video) {
      const video = this._last_reloaded_video;
      const comments = this._last_reloaded_comments;
      let videoId = video.id;
      if (typeof videoId === "object" && videoId !== null && "videoId" in videoId) {
        videoId = (videoId as { videoId: string }).videoId;
      }
      const description = video.snippet?.description || "";
      if (typeof videoId === "string") {
        return this.buildContentHtml(description, comments, videoId);
      }
    }

    if (html) {
      try {
        const trimmed = html.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          const data = JSON.parse(trimmed);
          const video = Array.isArray(data.items) ? data.items[0] : null;
          if (video) {
            let videoId = video.id;
            if (typeof videoId === "object" && videoId !== null && "videoId" in videoId) {
              videoId = (videoId as { videoId: string }).videoId;
            }
            if (!videoId && article.identifier) {
              const match = article.identifier.match(/v=([A-Za-z0-9_-]+)/);
              if (match) videoId = match[1];
            }
            const description = video.snippet?.description || "";
            const comments = Array.isArray(data.comments) ? data.comments : [];
            if (typeof videoId === "string" && videoId) {
              return this.buildContentHtml(description, comments, videoId);
            }
          }
        }
      } catch {
        // Ignore non-JSON
      }
    }

    return html;
  }
```

with:

```ts
  override async extractContent(html: string, article: RawArticle): Promise<string> {
    const labels = await this.chromeLabels();

    if (this._last_reloaded_video) {
      const video = this._last_reloaded_video;
      const comments = this._last_reloaded_comments;
      let videoId = video.id;
      if (typeof videoId === "object" && videoId !== null && "videoId" in videoId) {
        videoId = (videoId as { videoId: string }).videoId;
      }
      const description = video.snippet?.description || "";
      if (typeof videoId === "string") {
        return this.buildContentHtml(description, comments, videoId, labels);
      }
    }

    if (html) {
      try {
        const trimmed = html.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
          const data = JSON.parse(trimmed);
          const video = Array.isArray(data.items) ? data.items[0] : null;
          if (video) {
            let videoId = video.id;
            if (typeof videoId === "object" && videoId !== null && "videoId" in videoId) {
              videoId = (videoId as { videoId: string }).videoId;
            }
            if (!videoId && article.identifier) {
              const match = article.identifier.match(/v=([A-Za-z0-9_-]+)/);
              if (match) videoId = match[1];
            }
            const description = video.snippet?.description || "";
            const comments = Array.isArray(data.comments) ? data.comments : [];
            if (typeof videoId === "string" && videoId) {
              return this.buildContentHtml(description, comments, videoId, labels);
            }
          }
        }
      } catch {
        // Ignore non-JSON
      }
    }

    return html;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/aggregators/sites/youtube/aggregator.test.ts`
Expected: PASS (all tests, including the new German-locale one)

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/aggregators/sites/youtube/aggregator.ts src/lib/aggregators/sites/youtube/aggregator.test.ts
git commit -m "feat(aggregators): translate YouTube's Comments/source chrome"
```

---

### Task 10: Full verification pass

**Files:** none (verification only)

**Interfaces:** none

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS (all tests; the one pre-existing unrelated failure is `src/lib/auth/server.test.ts`'s `ENOENT` on a missing `node_modules/better-auth` file, unrelated to this change -- confirm it's the same failure and not a new one)

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: 0 errors (pre-existing warnings are fine; do not introduce new ones)

- [ ] **Step 3: Run format check**

Run: `npm run format:check`
If it fails, run `npm run format` and re-check.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: 0 errors

- [ ] **Step 5: Update CLAUDE.md if needed**

Skim the "## Conventions" section of `CLAUDE.md` for anything this change makes stale. It documents the `defineIntegration()`/probe/secrets architecture in detail but says nothing about aggregator chrome text -- no update should be needed here, but confirm by grepping: `grep -n "Comments\|chrome" CLAUDE.md`. If it returns nothing, no doc update is needed.

- [ ] **Step 6: Final commit (only if any of the above steps produced changes)**

```bash
git add -A
git commit -m "chore: format/lint fixes after aggregator chrome i18n"
```
