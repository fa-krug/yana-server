# Tag Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every tag a color from a curated 12-color palette and render that color everywhere a tag's name already appears (tags list, tag form, feeds table, feed form's tag picker, articles page's tag filter).

**Architecture:** A new `tags.color` column stores a palette *key* (e.g. `"blue"`), never a raw hex value. `src/lib/tags/colors.ts` is the single source of the palette, reusing the WCAG contrast-solving math already in `src/lib/avatar.ts` (extracted into an exported helper) so every swatch is legible under a fixed white foreground in both themes with no `dark:` variants. Two small presentational components (`<TagBadge>`, `<TagColorDot>`) are the only things that turn a color key into pixels; every consumer renders through one of them.

**Tech Stack:** Next.js 16 / React 19 / TypeScript, Drizzle ORM + better-sqlite3, next-intl, Vitest (two projects: `node` for `.test.ts`, `dom` for `.test.tsx`), Tailwind v4 + Base UI.

**Depends on / see also:** `docs/superpowers/specs/2026-08-03-tag-colors-design.md` (the approved design this plan implements).

## Global Constraints

- Line length 100, double quotes, semicolons, trailing commas (Prettier owns formatting).
- Every user-facing string comes from `messages/en.json` **and** `messages/de.json`, which must define identical key sets (`src/i18n/messages.test.ts` enforces this).
- A dynamic catalog key must be typed narrowly at its source (an `as const` array + `.map()`), never cast at the `t()` call site — see `src/components/settings/general-section.tsx`'s `THEMES`/`t(\`theme.${value}\`)` for the established pattern.
- New library code under `src/lib/**` gets real-database tests in the style of `src/lib/tags/actions.test.ts` — no driver mocks.
- Component tests use `@testing-library/react` + vitest's own `expect` — **no `jest-dom`** (no `toHaveAttribute`/`toBeInTheDocument`; use `.getAttribute(...)`, `.style.x`, `toBeTruthy()`, `toBe(...)`).
- `.test.ts` files run in the `node` vitest project, `.test.tsx` in the `dom` project — the extension is what selects the project, not the folder.
- Every write goes through `writeTransaction()` (already true of `src/lib/tags/actions.ts`; nothing here changes that).
- Never introduce a `CHECK` constraint casually — this plan deliberately does not add one for `tags.color` (see Task 3).

---

### Task 1: Extract `solveLightnessForHue` out of `colourFor()`

**Files:**
- Modify: `src/lib/avatar.ts:142-163`
- Test: `src/lib/avatar.test.ts`

**Interfaces:**
- Produces: `export function solveLightnessForHue(hue: number, saturation?: number): number` — the lightness (in `avatar.ts`'s existing `MIN_LIGHTNESS..MAX_LIGHTNESS` window) that first clears `TARGET_CONTRAST` against white for the given hue and saturation, defaulting `saturation` to the module's existing `SATURATION` (55). Task 2 imports this.
- `colourFor(id: string): string` keeps its exact current signature and output — this task only changes what is inside it.

- [ ] **Step 1: Write the failing test**

Add this import to the top of `src/lib/avatar.test.ts` (extend the existing `import { ... } from "./avatar"` block):

```ts
import {
  avatarUrlFor,
  colourFor,
  contrastWithWhite,
  displayNameFor,
  initialsFor,
  safeAvatarSrc,
  solveLightnessForHue,
} from "./avatar";
```

Insert this new `describe` block right before the existing `describe("colourFor", ...)` block:

```ts
describe("solveLightnessForHue", () => {
  it("matches the lightness colourFor derives for every hue", () => {
    // colourFor()'s own output is the reference: extracting the loop into a
    // named function must not change a single value it already returns.
    for (let hue = 0; hue < 360; hue += 1) {
      const [, , , lightness] = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(colourForHue(hue))!;
      expect(solveLightnessForHue(hue, 55)).toBe(Number(lightness));
    }
  });

  it("defaults its saturation to the one colourFor uses", () => {
    expect(solveLightnessForHue(210)).toBe(solveLightnessForHue(210, 55));
  });
});
```

(`colourForHue` is the helper already declared near the bottom of this file — function declarations are hoisted, so referencing it above its own declaration is fine.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/avatar.test.ts`
Expected: FAIL — `solveLightnessForHue` is not exported from `./avatar` (TypeScript/import error).

- [ ] **Step 3: Extract the function**

In `src/lib/avatar.ts`, replace the body of `colourFor` (currently lines ~148-163) with:

```ts
/**
 * The lightness (within the window above) that first clears `TARGET_CONTRAST`
 * against white for this hue, scanning from lightest to darkest.
 *
 * Extracted out of `colourFor()` so `src/lib/tags/colors.ts` can solve the same
 * problem for a fixed palette of hues instead of a hash-derived one, without a
 * second copy of the WCAG math.
 */
export function solveLightnessForHue(hue: number, saturation: number = SATURATION): number {
  for (let candidate = MAX_LIGHTNESS; candidate >= MIN_LIGHTNESS; candidate -= 1) {
    if (contrastWithWhite(hue, saturation, candidate) >= TARGET_CONTRAST) {
      return candidate;
    }
  }
  return MIN_LIGHTNESS;
}

/**
 * Deterministic colour from the user id, so an avatar looks the same on every
 * device and across sessions -- there is nothing persisted to disagree with.
 *
 * **Lightness varies with hue, and that is the whole point.** A fixed
 * `hsl(h 55% 45%)` -- what this returned first -- is *predictably* poor rather
 * than predictably good: white on it falls below AA 4.5:1 for **184 of 360
 * hues**, below even 3:1 for 40% of them, bottoming out at 2.26:1 around hue 60
 * where the colour is yellow. Ids are random, so that is not an edge case, it
 * is half of all users looking at an unreadable version of their own initials
 * forever. Relative luminance is wildly non-uniform across hue -- green carries
 * 0.7152 of it and blue 0.0722 -- so no single lightness can serve every hue.
 *
 * So the lightness is *solved* per hue via `solveLightnessForHue()`. Yellows
 * land near 30% and blues near 62%, and the resulting ratios sit in a narrow
 * 4.60-4.86 band, so the palette reads as one family instead of some colours
 * being much darker than they need to be.
 *
 * `src/lib/avatar.test.ts` asserts the ratio across the whole hue range, not
 * for a couple of sample ids -- sampling is what let the first version ship.
 */
export function colourFor(id: string): string {
  let hue = 0;
  for (let index = 0; index < id.length; index += 1) {
    hue = (hue * 31 + id.charCodeAt(index)) % 360;
  }

  const lightness = solveLightnessForHue(hue);
  return `hsl(${hue} ${SATURATION}% ${lightness}%)`;
}
```

Do not change `SATURATION`, `TARGET_CONTRAST`, `MAX_LIGHTNESS`, `MIN_LIGHTNESS`, or `contrastWithWhite` — only the loop moves.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/avatar.test.ts`
Expected: PASS, all existing `avatar.test.ts` tests still green (this is a pure extraction — every prior assertion about `colourFor` must be unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/lib/avatar.ts src/lib/avatar.test.ts
git commit -m "refactor(avatar): extract solveLightnessForHue for reuse by tag colors"
```

---

### Task 2: The tag color palette (`src/lib/tags/colors.ts`)

**Files:**
- Create: `src/lib/tags/colors.ts`
- Test: `src/lib/tags/colors.test.ts`

**Interfaces:**
- Consumes: `solveLightnessForHue(hue: number, saturation?: number): number` from `@/lib/avatar` (Task 1).
- Produces (used by every later task):
  - `export const TAG_COLOR_KEYS: readonly ["red", "orange", "amber", "yellow", "lime", "green", "teal", "cyan", "blue", "indigo", "violet", "pink"]`
  - `export type TagColorKey = (typeof TAG_COLOR_KEYS)[number]`
  - `export const DEFAULT_TAG_COLOR: TagColorKey` (value `"red"`)
  - `export const TAG_COLOR_FOREGROUND: string` (value `"#ffffff"`)
  - `export function isTagColorKey(value: string): value is TagColorKey`
  - `export function hexForTagColor(value: string): string` — returns an `hsl(...)` string; falls back to `DEFAULT_TAG_COLOR`'s color for any `value` that is not a recognized key.

- [ ] **Step 1: Write the failing test**

Create `src/lib/tags/colors.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { DEFAULT_TAG_COLOR, TAG_COLOR_KEYS, hexForTagColor, isTagColorKey } from "./colors";

describe("the tag color palette", () => {
  it("has twelve distinct keys", () => {
    expect(TAG_COLOR_KEYS.length).toBe(12);
    expect(new Set(TAG_COLOR_KEYS).size).toBe(12);
  });

  it("includes the default among the keys", () => {
    expect(TAG_COLOR_KEYS).toContain(DEFAULT_TAG_COLOR);
  });

  it("resolves every key to a distinct, well-formed color", () => {
    const colors = TAG_COLOR_KEYS.map((key) => hexForTagColor(key));
    expect(new Set(colors).size).toBe(TAG_COLOR_KEYS.length);
    for (const color of colors) {
      expect(color).toMatch(/^hsl\(\d+ \d+% \d+%\)$/);
    }
  });

  it("is stable for the same key", () => {
    expect(hexForTagColor("blue")).toBe(hexForTagColor("blue"));
  });
});

describe("isTagColorKey", () => {
  it("accepts every palette key", () => {
    for (const key of TAG_COLOR_KEYS) expect(isTagColorKey(key)).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isTagColorKey("mauve")).toBe(false);
    expect(isTagColorKey("")).toBe(false);
  });
});

describe("hexForTagColor", () => {
  it("falls back to the default color for an unrecognized value", () => {
    expect(hexForTagColor("mauve")).toBe(hexForTagColor(DEFAULT_TAG_COLOR));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/tags/colors.test.ts`
Expected: FAIL — `./colors` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/lib/tags/colors.ts`:

```ts
import { solveLightnessForHue } from "@/lib/avatar";

/**
 * The curated set of tag colors, in the order a brand-new install's migration
 * cycles existing tags through (see `drizzle/0004_tag_colors.sql`) and the
 * order the swatch picker renders them in `<TagForm>`.
 */
export const TAG_COLOR_KEYS = [
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "violet",
  "pink",
] as const;

export type TagColorKey = (typeof TAG_COLOR_KEYS)[number];

/** What a brand-new tag starts as before anyone has picked a color. */
export const DEFAULT_TAG_COLOR: TagColorKey = "red";

/** Fixed across the palette; only the hue (and the lightness solved for it) vary. */
const SATURATION = 65;

const HUES: Record<TagColorKey, number> = {
  red: 0,
  orange: 25,
  amber: 40,
  yellow: 55,
  lime: 90,
  green: 140,
  teal: 175,
  cyan: 195,
  blue: 220,
  indigo: 245,
  violet: 270,
  pink: 330,
};

/** The foreground every swatch is solved to stay legible under, in both themes. */
export const TAG_COLOR_FOREGROUND = "#ffffff";

export function isTagColorKey(value: string): value is TagColorKey {
  return (TAG_COLOR_KEYS as readonly string[]).includes(value);
}

/**
 * The CSS color for a stored `tags.color` value.
 *
 * Falls back to `DEFAULT_TAG_COLOR` for a value that is not one of the twelve
 * keys -- defensive only, since the write path (the zod enum in
 * `src/lib/tags/fields.ts`) never lets an unrecognized one through, but a
 * render helper should degrade rather than throw over row data.
 */
export function hexForTagColor(value: string): string {
  const key = isTagColorKey(value) ? value : DEFAULT_TAG_COLOR;
  const hue = HUES[key];
  const lightness = solveLightnessForHue(hue, SATURATION);
  return `hsl(${hue} ${SATURATION}% ${lightness}%)`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/tags/colors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tags/colors.ts src/lib/tags/colors.test.ts
git commit -m "feat(tags): add the tag color palette"
```

---

### Task 3: Schema column, zod field, and the migration

**Files:**
- Modify: `src/lib/db/schema/feeds.ts:16-40` (the `tags` table)
- Modify: `src/lib/tags/fields.ts`
- Create: `drizzle/0004_tag_colors.sql` (via `drizzle-kit generate`, then hand-edited)

**Interfaces:**
- Consumes: `TAG_COLOR_KEYS` from `@/lib/tags/colors` (Task 2).
- Produces: `Tag` (from `typeof tags.$inferSelect`) now has `color: string`; `tagSchema` now parses an optional `color: TagColorKey`. Task 4 consumes both.

- [ ] **Step 1: Add the column to the schema**

In `src/lib/db/schema/feeds.ts`, in the `tags` table definition, add `color` right after `name`:

```ts
export const tags = sqliteTable(
  "tags",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    color: text("color").notNull().default("red"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`)
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("tags_name_user_unique").on(table.name, table.userId)],
);
```

No `CHECK` constraint: this mirrors `user_settings.theme`/`.language`, which are also plain, unconstrained text validated only at the zod layer, not the JSON-column precedent (this isn't structured data that can go silently poisonous the way malformed JSON does).

- [ ] **Step 2: Update the zod schema**

Replace `src/lib/tags/fields.ts` entirely:

```ts
import { z } from "zod";

import { TAG_COLOR_KEYS } from "./colors";

export const tagSchema = z.object({
  name: z.string().trim().min(1, "A name is required."),
  color: z.enum(TAG_COLOR_KEYS).optional(),
});

export type TagsSort = "name" | "createdAt";
export type TagsDir = "asc" | "desc";
```

- [ ] **Step 3: Generate the migration**

Run: `npx drizzle-kit generate --name tag_colors`

Expected: a new `drizzle/0004_tag_colors.sql` (a single `ALTER TABLE` — nothing is dropped alongside the new column, so this does not hit the 12-step-rebuild path) plus an updated `drizzle/meta/_journal.json` and a new snapshot file under `drizzle/meta/`. Read the generated file to confirm it is exactly one `ALTER TABLE \`tags\` ADD \`color\` ...` statement before continuing.

- [ ] **Step 4: Hand-add the backfill**

Append to the end of the generated `drizzle/0004_tag_colors.sql` (after the `ALTER TABLE` statement, separated the same way every other statement in this file already is):

```sql
--> statement-breakpoint
UPDATE `tags` SET `color` = CASE (`id` % 12)
  WHEN 0 THEN 'red'
  WHEN 1 THEN 'orange'
  WHEN 2 THEN 'amber'
  WHEN 3 THEN 'yellow'
  WHEN 4 THEN 'lime'
  WHEN 5 THEN 'green'
  WHEN 6 THEN 'teal'
  WHEN 7 THEN 'cyan'
  WHEN 8 THEN 'blue'
  WHEN 9 THEN 'indigo'
  WHEN 10 THEN 'violet'
  ELSE 'pink'
END;
```

This cycles every pre-existing tag through the palette by id, so an upgrading install looks finished immediately rather than gray until every tag is re-edited. It runs unconditionally, including against a fresh, empty test database, where it is a no-op `UPDATE` over zero rows.

- [ ] **Step 5: Manually verify the backfill SQL**

This migration's data transform has no automated test (see the design spec's Testing section) — verify it by hand against a throwaway database, from the repository root:

```bash
node -e '
const Database = require("better-sqlite3");
const fs = require("fs");
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`);
for (let i = 0; i < 14; i += 1) {
  db.prepare("INSERT INTO tags (name, user_id) VALUES (?, ?)").run(`tag-${i}`, "u1");
}
const sql = fs.readFileSync("drizzle/0004_tag_colors.sql", "utf8");
for (const statement of sql.split("--> statement-breakpoint")) {
  const trimmed = statement.trim();
  if (trimmed) db.exec(trimmed);
}
console.table(db.prepare("SELECT id, color FROM tags ORDER BY id").all());
'
```

Expected output: `id` 1-12 cycling `orange, amber, yellow, lime, green, teal, cyan, blue, indigo, violet, pink, red` (id % 12: 1, 2, 3, ... 11, 0), and `id` 13-14 continuing `orange, amber`. If the cycle looks wrong, fix the `CASE` in `drizzle/0004_tag_colors.sql` and rerun this check before moving on — this script is throwaway and is not committed.

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS. In particular `src/lib/db/schema.test.ts` and `src/lib/db/relations.test.ts` insert `tags` rows without specifying `color` (e.g. `INSERT INTO tags (id, name, user_id) VALUES (1, 'News', 'u1')`) — these must still pass because the column has a `DEFAULT`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/schema/feeds.ts src/lib/tags/fields.ts drizzle/0004_tag_colors.sql drizzle/meta/
git commit -m "feat(db): add tags.color with a backfilling migration"
```

---

### Task 4: `tags/actions.ts` reads and writes `color`

**Files:**
- Modify: `src/lib/tags/actions.ts`
- Modify: `src/lib/tags/actions.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_TAG_COLOR` from `@/lib/tags/colors` (Task 2); the updated `tagSchema` (Task 3).
- Produces: `createTag(input)` persists `color` (defaulting to `DEFAULT_TAG_COLOR` when omitted); `updateTag(id, input)` persists `color` only when the caller supplies one, leaving it untouched otherwise. Later tasks (feed queries, UI) read `Tag.color` off the result.

- [ ] **Step 1: Write the failing tests**

Add `DEFAULT_TAG_COLOR` to the imports at the top of `src/lib/tags/actions.test.ts`:

```ts
import { DEFAULT_TAG_COLOR } from "@/lib/tags/colors";
```

Add these `it` blocks inside the existing `describe("createTag", ...)`:

```ts
it("stores the given color", async () => {
  await currentUserId();
  const result = (await actions.createTag({ name: "News", color: "violet" })) as { id: number };
  expect((await queries.getTag(result.id))?.color).toBe("violet");
});

it("defaults to the standard color when none is given", async () => {
  await currentUserId();
  const result = (await actions.createTag({ name: "News" })) as { id: number };
  expect((await queries.getTag(result.id))?.color).toBe(DEFAULT_TAG_COLOR);
});

it("rejects an unrecognized color", async () => {
  await currentUserId();
  const result = await actions.createTag({ name: "News", color: "mauve" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errorKey).toBe("saveFailed");
});
```

Add these `it` blocks inside the existing `describe("updateTag", ...)`:

```ts
it("changes the color when one is given", async () => {
  await currentUserId();
  const { id } = (await actions.createTag({ name: "Keep" })) as { id: number };
  await actions.updateTag(id, { name: "Keep", color: "teal" });
  expect((await queries.getTag(id))?.color).toBe("teal");
});

it("leaves the color untouched when none is given", async () => {
  await currentUserId();
  const { id } = (await actions.createTag({ name: "Keep", color: "pink" })) as { id: number };
  await actions.updateTag(id, { name: "Renamed" });
  expect((await queries.getTag(id))?.color).toBe("pink");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/tags/actions.test.ts`
Expected: FAIL — the new tests expect a `color` the current `createTag`/`updateTag` never write, so `getTag(...)?.color` is `"red"` (the DB default) in every case rather than the value each test expects.

- [ ] **Step 3: Implement**

In `src/lib/tags/actions.ts`, add the import and update both functions:

```ts
import { DEFAULT_TAG_COLOR } from "./colors";
```

```ts
export async function createTag(input: unknown): Promise<CreateTagResult> {
  const parsed = tagSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errorKey: "saveFailed" };
  }

  const { name, color } = parsed.data;
  const userId = await currentUserId();

  return writeTransaction((tx) => {
    const clash = tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.userId, userId), sql`lower(${tags.name}) = lower(${name})`))
      .get();

    if (clash) {
      return { ok: false, errorKey: "nameTaken" };
    }

    const { id } = tx
      .insert(tags)
      .values({ name, userId, color: color ?? DEFAULT_TAG_COLOR })
      .returning({ id: tags.id })
      .get();

    revalidatePath("/tags");
    return { ok: true, id };
  });
}

export async function updateTag(id: number, input: unknown): Promise<TagsResult> {
  const parsed = tagSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errorKey: "saveFailed" };
  }

  const { name, color } = parsed.data;
  const userId = await currentUserId();

  return writeTransaction((tx) => {
    const clash = tx
      .select({ id: tags.id })
      .from(tags)
      .where(
        and(eq(tags.userId, userId), sql`lower(${tags.name}) = lower(${name})`, ne(tags.id, id)),
      )
      .get();

    if (clash) {
      return { ok: false, errorKey: "nameTaken" };
    }

    const result = tx
      .update(tags)
      .set({ name, ...(color ? { color } : {}) })
      .where(and(eq(tags.id, id), eq(tags.userId, userId)))
      .run();

    if (result.changes === 0) {
      return { ok: false, errorKey: "notFound" };
    }

    revalidatePath("/tags");
    return { ok: true };
  });
}
```

`deleteTags` and `tagUsage` are unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/tags/actions.test.ts`
Expected: PASS, including every pre-existing test in this file (`createTag({ name: "News" })` with no `color` must still succeed).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tags/actions.ts src/lib/tags/actions.test.ts
git commit -m "feat(tags): create and update a tag's color"
```

---

### Task 5: Carry `color` through the feed queries

**Files:**
- Modify: `src/lib/feeds/actions.ts:48-59` (`getFeed`), `src/lib/feeds/actions.ts:113-124` (`listFeeds`)

**Interfaces:**
- Consumes: `tags.color` (Task 3).
- Produces: `getFeed(id)` and `listFeeds(params)` now return `tags: (Tag)[]` including `color` — the shape `FeedListRow`/`FeedForm`/`feeds-table.tsx` already type as `Feed & { tags: Tag[] }`, so no type changes are needed downstream, only these two explicit column lists.

- [ ] **Step 1: Add `color` to both explicit selects**

In `src/lib/feeds/actions.ts`, `getFeed`'s `attachedTags` query:

```ts
  const attachedTags = db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      userId: tags.userId,
      createdAt: tags.createdAt,
      updatedAt: tags.updatedAt,
    })
    .from(feedTags)
    .innerJoin(tags, eq(feedTags.tagId, tags.id))
    .where(eq(feedTags.feedId, id))
    .all();
```

And the identical block inside `listFeeds`'s per-row loop:

```ts
    const attachedTags = db
      .select({
        id: tags.id,
        name: tags.name,
        color: tags.color,
        userId: tags.userId,
        createdAt: tags.createdAt,
        updatedAt: tags.updatedAt,
      })
      .from(feedTags)
      .innerJoin(tags, eq(feedTags.tagId, tags.id))
      .where(eq(feedTags.feedId, row.id))
      .all();
```

- [ ] **Step 2: Run the existing feeds test suite**

Run: `npm test -- src/lib/feeds/actions.test.ts`
Expected: PASS — this task adds a column to an already-passing query, no test assertions here inspect `color` so none should need changes.

- [ ] **Step 3: Commit**

```bash
git add src/lib/feeds/actions.ts
git commit -m "feat(feeds): include tag color in feed queries"
```

---

### Task 6: `<TagBadge>` and `<TagColorDot>`

**Files:**
- Create: `src/components/tags/tag-badge.tsx`
- Create: `src/components/tags/tag-color-dot.tsx`
- Test: `src/components/tags/tag-badge.test.tsx`

**Interfaces:**
- Consumes: `hexForTagColor`, `TAG_COLOR_FOREGROUND`, `DEFAULT_TAG_COLOR` from `@/lib/tags/colors` (Task 2); `Badge` from `@/components/ui/badge`; `cn` from `@/lib/utils`.
- Produces:
  - `export function TagBadge({ name, color, className }: { name: string; color: string; className?: string })` — a solid colored pill.
  - `export function TagColorDot({ color, className }: { color: string; className?: string })` — a small colored circle, `aria-hidden`.

  Tasks 7-11 render tag colors exclusively through these two.

- [ ] **Step 1: Write the failing test**

Create `src/components/tags/tag-badge.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DEFAULT_TAG_COLOR, hexForTagColor } from "@/lib/tags/colors";

import { TagBadge } from "./tag-badge";
import { TagColorDot } from "./tag-color-dot";

/**
 * jsdom's CSSOM normalizes any inline color it accepts (including `hsl(...)`)
 * to `rgb(...)` on read. Comparing two elements' `.style.backgroundColor`
 * (both normalized the same way) is what lets this compare *colors* rather
 * than assume a particular string form.
 */
function backgroundColorOf(hsl: string): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = hsl;
  return probe.style.backgroundColor;
}

describe("<TagBadge>", () => {
  it("paints the given color as its background", () => {
    render(<TagBadge name="News" color="blue" />);
    expect(screen.getByText("News").style.backgroundColor).toBe(backgroundColorOf(
      hexForTagColor("blue"),
    ));
  });

  it("falls back to the default palette color for an unrecognized value", () => {
    render(<TagBadge name="News" color="mauve" />);
    expect(screen.getByText("News").style.backgroundColor).toBe(
      backgroundColorOf(hexForTagColor(DEFAULT_TAG_COLOR)),
    );
  });
});

describe("<TagColorDot>", () => {
  it("is hidden from assistive tech -- the adjacent name already carries the meaning", () => {
    const { container } = render(<TagColorDot color="teal" />);
    expect(container.querySelector('span[aria-hidden="true"]')).toBeTruthy();
  });

  it("paints the given color", () => {
    const { container } = render(<TagColorDot color="teal" />);
    const dot = container.querySelector("span");
    expect(dot?.style.backgroundColor).toBe(backgroundColorOf(hexForTagColor("teal")));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/components/tags/tag-badge.test.tsx`
Expected: FAIL — neither `./tag-badge` nor `./tag-color-dot` exists yet.

- [ ] **Step 3: Write the implementations**

Create `src/components/tags/tag-badge.tsx`:

```tsx
import { Badge } from "@/components/ui/badge";
import { TAG_COLOR_FOREGROUND, hexForTagColor } from "@/lib/tags/colors";
import { cn } from "@/lib/utils";

/** A solid, colored pill for a tag -- the chip form used wherever tags render as tags. */
export function TagBadge({
  name,
  color,
  className,
}: {
  name: string;
  color: string;
  className?: string;
}) {
  return (
    <Badge
      className={cn("border-0", className)}
      style={{ backgroundColor: hexForTagColor(color), color: TAG_COLOR_FOREGROUND }}
    >
      {name}
    </Badge>
  );
}
```

Create `src/components/tags/tag-color-dot.tsx`:

```tsx
import { hexForTagColor } from "@/lib/tags/colors";
import { cn } from "@/lib/utils";

/**
 * A small colored circle with no text -- for contexts where a tag's name is
 * already rendered and only a color cue is needed beside it. `aria-hidden`
 * because the name is the accessible content; the color is decoration.
 */
export function TagColorDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2.5 shrink-0 rounded-full", className)}
      style={{ backgroundColor: hexForTagColor(color) }}
    />
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/components/tags/tag-badge.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/tags/tag-badge.tsx src/components/tags/tag-color-dot.tsx src/components/tags/tag-badge.test.tsx
git commit -m "feat(tags): add TagBadge and TagColorDot"
```

---

### Task 7: Color picker in `<TagForm>`, plus catalog keys

**Files:**
- Modify: `src/components/tags/tag-form.tsx`
- Modify: `messages/en.json` (`tags.form.color`, `tags.colors.*`)
- Modify: `messages/de.json` (same keys)
- Test: `src/components/tags/tag-form.test.tsx` (new)

**Interfaces:**
- Consumes: `TAG_COLOR_KEYS`, `DEFAULT_TAG_COLOR`, `hexForTagColor` from `@/lib/tags/colors` (Task 2); `createTag`/`updateTag` now accepting `color` (Task 4).
- Produces: `createTag`/`updateTag` are now always called with `{ name, color }` from this form — later tasks that read a tag's `color` off freshly-created rows rely on this.

- [ ] **Step 1: Add the catalog keys**

In `messages/en.json`, inside the `"tags"` object, change the `"form"` block to add `"color"`, and add a new sibling `"colors"` block (placed after `"form"`, before `"deleteAction"`):

```json
    "form": {
      "name": "Name",
      "color": "Color",
      "create": "Create tag",
      "save": "Save tag",
      "cancel": "Cancel",
      "created": "Tag created",
      "saved": "Tag saved"
    },
    "colors": {
      "red": "Red",
      "orange": "Orange",
      "amber": "Amber",
      "yellow": "Yellow",
      "lime": "Lime",
      "green": "Green",
      "teal": "Teal",
      "cyan": "Cyan",
      "blue": "Blue",
      "indigo": "Indigo",
      "violet": "Violet",
      "pink": "Pink"
    },
```

In `messages/de.json`, the same structure, translated:

```json
    "form": {
      "name": "Name",
      "color": "Farbe",
      "create": "Tag anlegen",
      "save": "Tag speichern",
      "cancel": "Abbrechen",
      "created": "Tag angelegt",
      "saved": "Tag gespeichert"
    },
    "colors": {
      "red": "Rot",
      "orange": "Orange",
      "amber": "Bernstein",
      "yellow": "Gelb",
      "lime": "Limette",
      "green": "Grün",
      "teal": "Türkis",
      "cyan": "Cyan",
      "blue": "Blau",
      "indigo": "Indigo",
      "violet": "Violett",
      "pink": "Pink"
    },
```

- [ ] **Step 2: Verify catalog parity**

Run: `npm test -- src/i18n/messages.test.ts`
Expected: PASS — both catalogs now define the same key set.

- [ ] **Step 3: Write the failing form test**

Create `src/components/tags/tag-form.test.tsx`:

```tsx
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setRouter } from "@/test/next-navigation";
import { renderWithProviders } from "@/test/render";

import { TagForm } from "./tag-form";

const { createTag, updateTag, deleteTags } = vi.hoisted(() => ({
  createTag: vi.fn(),
  updateTag: vi.fn(),
  deleteTags: vi.fn(),
}));
vi.mock("@/lib/tags/actions", () => ({ createTag, updateTag, deleteTags }));

const { refresh, replace } = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
setRouter({ refresh, replace });

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess, info: vi.fn() } }));

// This form's own usage indicator is not what this test file covers.
vi.mock("./use-tag-usage", () => ({ useTagUsage: () => ({ feeds: 0 }) }));

function submit(name: string) {
  fireEvent.submit(screen.getByRole("button", { name }).closest("form")!);
}

beforeEach(() => {
  vi.clearAllMocks();
  createTag.mockResolvedValue({ ok: true, id: 1 });
  updateTag.mockResolvedValue({ ok: true });
});

describe("<TagForm>", () => {
  it("creates a tag with the default color when no swatch was touched", async () => {
    renderWithProviders(<TagForm />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "News" } });
    submit("Create tag");

    await waitFor(() => expect(createTag).toHaveBeenCalled());
    expect(createTag).toHaveBeenCalledWith({ name: "News", color: "red" });
  });

  it("submits the swatch the operator picked", async () => {
    renderWithProviders(<TagForm />);

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "News" } });
    fireEvent.click(screen.getByRole("radio", { name: "Violet" }));
    submit("Create tag");

    await waitFor(() => expect(createTag).toHaveBeenCalled());
    expect(createTag).toHaveBeenCalledWith({ name: "News", color: "violet" });
  });

  it("preselects the tag's own color when editing", () => {
    renderWithProviders(
      <TagForm
        tag={{
          id: 1,
          name: "News",
          color: "teal",
          userId: "u1",
          createdAt: new Date(),
          updatedAt: new Date(),
        }}
      />,
    );

    expect(screen.getByRole("radio", { name: "Teal" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Red" }).getAttribute("aria-checked")).toBe("false");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npm test -- src/components/tags/tag-form.test.tsx`
Expected: FAIL — `<TagForm>` does not render any element with `role="radio"` yet, and `createTag`/`updateTag` are called with no `color`.

- [ ] **Step 5: Implement the swatch picker**

In `src/components/tags/tag-form.tsx`, add to the imports:

```ts
import { DEFAULT_TAG_COLOR, TAG_COLOR_KEYS, hexForTagColor } from "@/lib/tags/colors";
import { cn } from "@/lib/utils";
```

Add state, right after the existing `name` state:

```ts
  const [color, setColor] = useState<string>(tag?.color ?? DEFAULT_TAG_COLOR);
```

Change both `submit`'s calls to include `color`:

```ts
        const result = await attempt(() => updateTag(tag.id, { name, color }));
```

```ts
      const result = await attempt(() => createTag({ name, color }));
```

Add the swatch picker markup, right after the `name` field's closing `</div>` and before the buttons `<div className="flex flex-wrap gap-2">`:

```tsx
        <div className="grid gap-2">
          <Label>{t("form.color")}</Label>
          <div role="radiogroup" aria-label={t("form.color")} className="flex flex-wrap gap-2">
            {TAG_COLOR_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={color === key}
                aria-label={t(`colors.${key}`)}
                disabled={pending}
                onClick={() => setColor(key)}
                className={cn(
                  "size-7 rounded-full border-2 transition-colors",
                  color === key ? "border-foreground" : "border-transparent",
                )}
                style={{ backgroundColor: hexForTagColor(key) }}
              />
            ))}
          </div>
        </div>
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- src/components/tags/tag-form.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/tags/tag-form.tsx src/components/tags/tag-form.test.tsx messages/en.json messages/de.json
git commit -m "feat(tags): add a color swatch picker to the tag form"
```

---

### Task 8: Color dot in `<TagsTable>`

**Files:**
- Modify: `src/components/tags/tags-table.tsx`

**Interfaces:**
- Consumes: `TagColorDot` from `./tag-color-dot` (Task 6); `TagListRow` (= `Tag`, now carrying `color`) already flows in from `src/lib/tags/queries.ts` with no type change needed.

- [ ] **Step 1: Add the import and the dot**

In `src/components/tags/tags-table.tsx`, add the import:

```ts
import { TagColorDot } from "./tag-color-dot";
```

Change the `name` column's `cell`:

```tsx
    {
      key: "name",
      header: t("columns.name"),
      sortable: true,
      cell: (row) => (
        <Link
          href={`/tags/${row.id}`}
          className="inline-flex items-center gap-2 font-medium hover:underline"
        >
          <TagColorDot color={row.color} />
          {row.name}
        </Link>
      ),
    },
```

- [ ] **Step 2: Verify manually**

Run: `npm run dev`, sign in, open `/tags`, and confirm each row's name now has a colored dot beside it matching that tag's stored color. (No dedicated test is added here — `tags-table.tsx` has no existing test file and this is a one-line, already-tested-component wiring change; see the design spec's Testing section.)

- [ ] **Step 3: Commit**

```bash
git add src/components/tags/tags-table.tsx
git commit -m "feat(tags): show each tag's color in the tags list"
```

---

### Task 9: `<TagBadge>` in `<FeedsTable>`

**Files:**
- Modify: `src/components/feeds/feeds-table.tsx`

**Interfaces:**
- Consumes: `TagBadge` from `@/components/tags/tag-badge` (Task 6).

- [ ] **Step 1: Swap the badge**

In `src/components/feeds/feeds-table.tsx`, remove the now-unused import:

```ts
import { Badge } from "@/components/ui/badge";
```

Add:

```ts
import { TagBadge } from "@/components/tags/tag-badge";
```

Change the `tags` column's `cell`:

```tsx
    {
      key: "tags",
      header: t("columns.tags"),
      sortable: false,
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.tags.map((tag) => (
            <TagBadge
              key={tag.id}
              name={tag.name}
              color={tag.color}
              className="text-xs font-normal px-1.5 py-0 h-5"
            />
          ))}
        </div>
      ),
    },
```

- [ ] **Step 2: Verify manually**

Run: `npm run dev`, open `/feeds`, confirm the tags column now shows colored badges instead of uniform gray ones.

- [ ] **Step 3: Commit**

```bash
git add src/components/feeds/feeds-table.tsx
git commit -m "feat(feeds): show tag colors in the feeds table"
```

---

### Task 10: Colored chips and dots in `<FeedForm>`'s tag picker

**Files:**
- Modify: `src/components/feeds/feed-form.tsx`

**Interfaces:**
- Consumes: `TagBadge`, `TagColorDot` (Task 6).

- [ ] **Step 1: Add the imports**

```ts
import { TagBadge } from "@/components/tags/tag-badge";
import { TagColorDot } from "@/components/tags/tag-color-dot";
```

- [ ] **Step 2: Colored chips in the collapsed trigger**

Replace the trigger's tag-chip rendering (currently a `<span className="bg-secondary px-1 rounded">`):

```tsx
          <SelectTrigger id="tags">
            <SelectValue placeholder={t("form.tagsPlaceholder")}>
              {tagIds.length === 0 ? (
                <span className="text-muted-foreground">{t("form.tagsPlaceholder")}</span>
              ) : (
                <div className="flex gap-1 flex-wrap">
                  {tagIds.map((id) => {
                    const tag = allTags.find((t) => String(t.id) === id);
                    return tag ? (
                      <TagBadge
                        key={id}
                        name={tag.name}
                        color={tag.color}
                        className="text-[10px] px-1.5 h-4"
                      />
                    ) : null;
                  })}
                </div>
              )}
            </SelectValue>
          </SelectTrigger>
```

- [ ] **Step 3: Color dots in the dropdown list**

Replace the `SelectItem` list:

```tsx
          <SelectContent>
            {allTags.map((tag) => (
              <SelectItem key={tag.id} value={String(tag.id)}>
                <span className="flex items-center gap-2">
                  <TagColorDot color={tag.color} />
                  {tag.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
```

- [ ] **Step 4: Verify manually**

Run: `npm run dev`, open `/feeds/new` (or an existing feed's edit page), open the tags select, and confirm: the dropdown list shows a color dot beside each tag name, and picking tags shows colored chips in the collapsed trigger.

- [ ] **Step 5: Commit**

```bash
git add src/components/feeds/feed-form.tsx
git commit -m "feat(feeds): show tag colors in the feed form's tag picker"
```

---

### Task 11: An optional color dot in `SearchFilterBar`, and the articles page's tag filter

**Files:**
- Modify: `src/components/crud/search-filter-bar.tsx`
- Modify: `src/components/crud/search-filter-bar.test.tsx`
- Modify: `src/app/(app)/articles/page.tsx:39-42`

**Interfaces:**
- Consumes: `hexForTagColor` from `@/lib/tags/colors` (Task 2).
- Produces: `FilterSpec["options"][number]` gains an optional `color?: string`, rendered as a dot inside `SelectContent` only (never on the collapsed trigger). Every other consumer of `FilterSpec` (roles, aggregator, read/starred) leaves `color` unset and is unaffected.

- [ ] **Step 1: Write the failing tests**

Add to the top of `src/components/crud/search-filter-bar.test.tsx`:

```ts
import { hexForTagColor } from "@/lib/tags/colors";
```

Add these two `it` blocks inside the existing `describe("<SearchFilterBar>", ...)`:

```ts
  it("shows a color dot next to an option that has one", () => {
    const TAGS = {
      key: "tag",
      label: "Tag",
      options: [
        { value: "", label: "All tags" },
        { value: "1", label: "News", color: "blue" },
      ],
    };
    const { container } = renderWithProviders(
      <SearchFilterBar placeholder="Search articles" filters={[TAGS]} />,
    );

    fireEvent.click(container.querySelector('[data-slot="select-trigger"]')!);
    const option = screen.getByRole("option", { name: "News" });
    const probe = document.createElement("div");
    probe.style.backgroundColor = hexForTagColor("blue");
    expect(option.querySelector("span")?.style.backgroundColor).toBe(probe.style.backgroundColor);
  });

  it("shows no dot next to an option without a color", () => {
    const { container } = renderWithProviders(
      <SearchFilterBar placeholder="Search users" filters={[ROLES]} />,
    );

    fireEvent.click(container.querySelector('[data-slot="select-trigger"]')!);
    const option = screen.getByRole("option", { name: "Administrator" });
    expect(option.querySelector("span")).toBe(null);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/components/crud/search-filter-bar.test.tsx`
Expected: FAIL — `FilterSpec["options"]` has no `color` field yet (type error) and no dot is rendered.

- [ ] **Step 3: Implement**

In `src/components/crud/search-filter-bar.tsx`, add the import:

```ts
import { hexForTagColor } from "@/lib/tags/colors";
```

Widen the type:

```ts
export type FilterSpec = {
  /** The query-string key this filter occupies -- `?role=admin`. */
  key: string;
  /** Already translated, and used as the control's accessible name. */
  label: string;
  /**
   * Already translated. An option with `value: ""` clears the filter:
   * `buildListHref` omits empty values, so "All roles" produces a URL with no
   * `role` at all rather than `?role=all`.
   *
   * `color`, when present, renders as a small dot before the label -- inside
   * the open popup only, never on the collapsed trigger, which every filter
   * (this one included) still resolves the plain way through `items`. Most
   * filters (roles, aggregator, read/starred) never set it.
   */
  options: { value: string; label: string; color?: string }[];
};
```

Update the `SelectItem` mapping:

```tsx
          <SelectContent>
            {spec.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.color && (
                  <span
                    aria-hidden="true"
                    className="mr-2 inline-block size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: hexForTagColor(option.color) }}
                  />
                )}
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/components/crud/search-filter-bar.test.tsx`
Expected: PASS, including every pre-existing test in this file.

- [ ] **Step 5: Wire the articles page's tag filter**

In `src/app/(app)/articles/page.tsx`, change the `tagOptions` mapping:

```ts
  const tagOptions = tagsRes.rows.map((t) => ({
    value: String(t.id),
    label: t.name,
    color: t.color,
  }));
```

- [ ] **Step 6: Verify manually**

Run: `npm run dev`, open `/articles`, open the "Tag" filter, and confirm each tag option now shows a color dot, while the "Read"/"Starred" filters (which never set `color`) are unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/components/crud/search-filter-bar.tsx src/components/crud/search-filter-bar.test.tsx "src/app/(app)/articles/page.tsx"
git commit -m "feat(articles): show tag colors in the tag filter dropdown"
```

---

### Task 12: Document the convention, then full verification

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- None — this is documentation plus a whole-repo check, no code interface changes.

- [ ] **Step 1: Add a CLAUDE.md bullet**

In `CLAUDE.md`'s `## Conventions` section, immediately after the bullet beginning `"CHECK constraints mirror Django's field types, deliberately."`, add:

```markdown
- **`tags.color` stores a palette *key* (e.g. `"blue"`), never a raw hex
  value.** `src/lib/tags/colors.ts` defines the twelve legal keys and solves
  each one's lightness against a fixed white foreground using the same WCAG
  contrast math `src/lib/avatar.ts`'s `colourFor()` already uses (extracted
  into `solveLightnessForHue()` so neither copies the other). That is what
  lets a colored tag badge (`<TagBadge>`, `<TagColorDot>`) skip `dark:`
  variants entirely -- the swatch is legible under white regardless of theme,
  the same reasoning `<UserAvatar>` already relies on. The column carries no
  `CHECK` constraint -- like `user_settings.theme`/`.language`, it is
  validated only by the zod enum in `tagSchema`
  (`src/lib/tags/fields.ts`), because retuning the palette is a code change,
  not a migration. `createTag` defaults an omitted `color` to
  `DEFAULT_TAG_COLOR`; `updateTag` leaves the column untouched when the
  submitted `color` is omitted, so renaming a tag never silently resets its
  color. `drizzle/0004_tag_colors.sql` backfills every pre-existing tag by
  cycling it through the palette (`id % 12`), so an upgrading install looks
  finished immediately rather than gray until every tag is re-edited.
```

- [ ] **Step 2: Run the full CI-equivalent check**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`

Expected: all four PASS. Fix anything that does not before continuing — in particular, re-check for an unused `Badge` import in `src/components/feeds/feeds-table.tsx` (Task 9 should have removed it) and unused `isTagColorKey`/`TAG_COLOR_FOREGROUND` imports if any task ended up not needing one it was given.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the tags.color convention"
```

---

## Self-Review Notes

- **Spec coverage:** every row of the design spec's "Touch points" table has a task (schema/migration → Task 3; `tagSchema`/`actions.ts` → Tasks 3-4; `colors.ts`/`avatar.ts` → Tasks 1-2; both new components → Task 6; `tag-form.tsx` → Task 7; `tags-table.tsx` → Task 8; `feeds-table.tsx` → Task 9; `feed-form.tsx` → Task 10; `search-filter-bar.tsx` + `articles/page.tsx` → Task 11; the i18n keys → Task 7). The spec's "Out of scope" items (bulk recolor, a tags-list color filter, article-level tagging) have intentionally no task.
- **Type consistency:** `TagColorKey`/`TAG_COLOR_KEYS`/`DEFAULT_TAG_COLOR`/`hexForTagColor`/`isTagColorKey`/`TAG_COLOR_FOREGROUND` are defined once, in Task 2, and every later task imports them by these exact names — none are redefined or renamed downstream.
- **No placeholders:** every step above either shows the complete code to write or an exact, runnable command.
