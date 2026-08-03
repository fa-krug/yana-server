# Tag Colors

**Date:** 2026-08-03
**Status:** Approved design, pending spec review

## Goal

Give every tag a color, chosen from a small curated palette, and render that color everywhere a
tag's name already appears: the tags list, the tag form, the feeds table's tag badges, the feed
form's tag picker, and the articles page's tag filter.

## Why

Tags today (`src/lib/db/schema/feeds.ts`) are a bare `(name, userId)` pair. With more than a handful
of tags, a plain-text list and identical gray badges everywhere give no visual way to tell tags apart
at a glance — every consumer (`tags-table.tsx`, `feeds-table.tsx`, `feed-form.tsx`) renders the same
`variant="secondary"` badge regardless of which tag it is.

## The palette, not a color picker

A free-form `<input type="color">` was considered and rejected: an arbitrary hex value is more
flexible but produces inconsistent, sometimes illegible badges (a bright yellow with white text, for
instance) and no visual family across a user's tags. A curated palette keeps every tag legible and
keeps the set of tags looking like one system.

`src/lib/tags/colors.ts` defines 12 named hues:

```
red · orange · amber · yellow · lime · green · teal · cyan · blue · indigo · violet · pink
```

`tags.color` stores the **key** (`"blue"`), never a raw hex value or hue number — so retuning the
palette later is a change to one file, not a migration, and the stored value stays meaningful read
directly from the database.

### Contrast, reusing the avatar math

Each hue's lightness is solved once, at module load, for ≥4.6:1 contrast against a fixed white
foreground — the identical algorithm `src/lib/avatar.ts`'s `colourFor()` already uses for avatar
background colors (WCAG relative luminance, descending integer scan over a lightness window). That
function's lightness-solving loop is extracted into a new exported `solveLightnessForHue(hue,
saturation?)` so both call sites share one implementation; `colourFor()`'s own output is unchanged.

Because every swatch is solved to be legible under a **fixed** white foreground, a colored badge
looks correct in both light and dark theme with no `dark:` variant anywhere — the same reasoning
that already lets `<UserAvatar>` skip theme-awareness.

### Components

- `<TagBadge name color className?>` — a solid colored pill (wraps `Badge`, inline
  `backgroundColor`/`color` style, `border-0`). Used wherever tags render as chips.
- `<TagColorDot color className?>` — a small colored circle with no text. Used wherever a tag's name
  is already rendered as text and only a color cue is needed alongside it.

Both live in `src/components/tags/` and take a `color: string` (the raw DB value); an unrecognized
key (defensive only — nothing in the write path should ever produce one) falls back to the palette's
first entry rather than crashing.

## Schema change

```ts
color: text("color").notNull().default("red"),
```

on `tags` (`src/lib/db/schema/feeds.ts`). No `CHECK` constraint: this mirrors `user_settings.theme`
and `.language`, which are also plain, unconstrained text validated only at the zod/action layer —
not the JSON-column precedent, since this isn't structured data that can go silently poisonous.
`tagSchema` (`src/lib/tags/fields.ts`) gains `color: z.enum(TAG_COLOR_KEYS)`.

### Migration and backfill

`drizzle-kit generate` produces a plain `ALTER TABLE tags ADD COLUMN color ...` (no rebuild needed —
nothing is dropped alongside it). Immediately after, a hand-added statement backfills every
pre-existing tag by cycling through the palette by id:

```sql
UPDATE tags SET color = CASE (id % 12)
  WHEN 0 THEN 'red' WHEN 1 THEN 'orange' WHEN 2 THEN 'amber' WHEN 3 THEN 'yellow'
  WHEN 4 THEN 'lime' WHEN 5 THEN 'green' WHEN 6 THEN 'teal' WHEN 7 THEN 'cyan'
  WHEN 8 THEN 'blue' WHEN 9 THEN 'indigo' WHEN 10 THEN 'violet' ELSE 'pink' END;
```

so an existing install looks finished the moment it upgrades, not gray until every tag is re-edited.
This one `UPDATE` is verified by hand against a scratch copy of a database with pre-migration tag
rows, rather than with an automated test — there is no existing harness in this repo for applying a
partial prefix of the migration folder, seeding rows, then applying the rest, and building one is
disproportionate to a single 12-branch modulo assignment.

## Touch points

| File | Change |
|---|---|
| `src/lib/db/schema/feeds.ts` | add `color` column |
| `src/lib/tags/fields.ts` | `tagSchema` gains `color` |
| `src/lib/tags/actions.ts` | `createTag`/`updateTag` pass `color` through |
| `src/lib/tags/colors.ts` (new) | palette, `hexForTagColor()`, `TAG_COLOR_KEYS`, `DEFAULT_TAG_COLOR` |
| `src/lib/avatar.ts` | extract `solveLightnessForHue()`, reused by `colors.ts` |
| `src/components/tags/tag-badge.tsx` (new) | `<TagBadge>` |
| `src/components/tags/tag-color-dot.tsx` (new) | `<TagColorDot>` |
| `src/components/tags/tag-form.tsx` | swatch picker, submits `color` |
| `src/components/tags/tags-table.tsx` | `<TagColorDot>` beside the name |
| `src/components/feeds/feeds-table.tsx` | tag badges become `<TagBadge>` |
| `src/components/feeds/feed-form.tsx` | colored chips in the trigger, dots in the dropdown |
| `src/components/crud/search-filter-bar.tsx` | `FilterSpec.options[].color?`, rendered as a dot in `SelectContent` only |
| `src/app/(app)/articles/page.tsx` | `tagOptions` carries `color` |
| `messages/en.json`, `messages/de.json` | `tags.form.color`, `tags.colors.<key>` (12 entries) |

The collapsed trigger of any single-select `SearchFilterBar` filter (tag included) stays plain text —
adding a dot there would mean special-casing one of several filters sharing a generic component for
its collapsed state, not just its open one. Every other `FilterSpec` consumer (roles, aggregator,
enabled) leaves `color` unset and is unaffected.

## Testing

- `src/lib/tags/colors.test.ts` (new): every palette key resolves to a color meeting the contrast
  target; the palette has no duplicate keys.
- `src/lib/tags/actions.test.ts` (extend): `createTag`/`updateTag` persist a given color; an
  unrecognized color key is rejected the same way an empty name is today (`errorKey: "saveFailed"`).
- No component test changes are required by this feature alone, but `tags-table.test.tsx`-style
  coverage does not exist today for tags and is not added here — out of scope for a color addition.

## Out of scope

- Recoloring tags in bulk.
- A color filter on the tags list itself (only the existing name search).
- Any change to how tags attach to feeds, or to article-level tagging (articles have no direct tag
  relationship today — only through their feed).
