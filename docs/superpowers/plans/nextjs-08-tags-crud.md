# Phase 8: Tags CRUD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tags tab with the same shape as users — searchable list, bulk select with bulk delete behind confirmation, create and edit as subpages, delete on the edit page — but available to every user rather than admins only.

**Architecture:** A second consumer of phase 5's CRUD kit. The interesting parts are not the UI, which is the established pattern, but the two things tags do that users do not: they are scoped to the owning user with a per-user unique name, and deleting one detaches it from feeds without deleting those feeds.

**Tech Stack:** Phase 5's `src/components/crud/*`, Drizzle, Zod.

## Global Constraints

- **Not admin-only.** `requireUser()`, not `requireAdmin()`.
- Every query is **scoped to the owner**. A tag id from another user must behave as if it does not exist — 404, never 403, and never a cross-tenant read.
- `UNIQUE(name, userId)` from phase 2 means two users may both have a tag named "News". The uniqueness error must be reported as a field error, not a raw constraint violation.
- Deleting a tag **removes the `feed_tags` rows, never the feeds**. The `ON DELETE CASCADE` on `feedTags.tagId` does exactly this — the confirmation copy must say so, because "delete tag" reads like it might take feeds with it.
- Name comparison for uniqueness is case-insensitive and trims whitespace. "News", "news " and "NEWS" are the same tag from the operator's point of view.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/tags/queries.ts` | `listTags`, `getTag`, `tagUsage` |
| `src/lib/tags/actions.ts` | `createTag`, `updateTag`, `deleteTags` |
| `src/app/(app)/tags/page.tsx` | List |
| `src/app/(app)/tags/new/page.tsx` | Create |
| `src/app/(app)/tags/[id]/page.tsx` | Edit + delete |
| `src/components/tags/tag-form.tsx` | Shared create/edit form |

---

### Task 1: Queries and actions

**Interfaces:**
- Produces:
  - `listTags(params: ListParams): Promise<{ rows: (Tag & { feedCount: number })[]; total: number }>`
  - `getTag(id: number): Promise<Tag | null>` — owner-scoped; returns `null` for another user's tag
  - `createTag(input: unknown): Promise<{ ok: boolean; error?: string; field?: string; id?: number }>`
  - `updateTag(id: number, input: unknown): Promise<{ ok: boolean; error?: string; field?: string }>`
  - `deleteTags(ids: number[]): Promise<{ ok: boolean; error?: string; deleted: number }>`
  - `tagUsage(ids: number[]): Promise<{ feeds: number }>` — for the confirmation copy

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/tags/actions.test.ts
import { describe, expect, it } from "vitest";

import { createTag, deleteTags, updateTag } from "./actions";
import { getTag } from "./queries";

describe("createTag", () => {
  it("rejects a duplicate name for the same user as a field error", async () => {
    await createTag({ name: "News" });
    const result = await createTag({ name: "News" });
    expect(result).toMatchObject({ ok: false, field: "name" });
    // A raw SQLite constraint string must never reach the UI.
    expect(result.error).not.toMatch(/UNIQUE constraint/i);
  });

  it("treats differing case and surrounding space as the same name", async () => {
    await createTag({ name: "Tech" });
    expect((await createTag({ name: "  tech " })).ok).toBe(false);
  });

  it("rejects an empty name", async () => {
    expect((await createTag({ name: "   " })).ok).toBe(false);
  });

  it("allows the same name for a different user", async () => {
    // UNIQUE(name, userId) is per-user by design.
    await createTag({ name: "Shared" });
    await switchToOtherUser();
    expect((await createTag({ name: "Shared" })).ok).toBe(true);
  });
});

describe("getTag", () => {
  it("returns null for another user's tag", async () => {
    const { id } = await createTag({ name: "Mine" });
    await switchToOtherUser();
    expect(await getTag(id!)).toBeNull();
  });
});

describe("deleteTags", () => {
  it("detaches feeds without deleting them", async () => {
    const { id } = await createTag({ name: "Temp" });
    const feedId = await seedFeedWithTag(id!);
    await deleteTags([id!]);
    expect(await feedExists(feedId)).toBe(true);
    expect(await feedTagCount(feedId)).toBe(0);
  });

  it("refuses another user's tag", async () => {
    const { id } = await createTag({ name: "Mine" });
    await switchToOtherUser();
    expect((await deleteTags([id!])).deleted).toBe(0);
  });
});

describe("updateTag", () => {
  it("allows renaming a tag to its own current name", async () => {
    // Otherwise saving a form without changing the name fails as a duplicate.
    const { id } = await createTag({ name: "Keep" });
    expect((await updateTag(id!, { name: "Keep" })).ok).toBe(true);
  });
});
```

Write `switchToOtherUser`, `seedFeedWithTag`, `feedExists` and `feedTagCount` as fixtures in the test file.

- [ ] **Step 2: Implement, with uniqueness checked before insert**

```ts
// the load-bearing part of createTag / updateTag
const name = String(parsed.data.name).trim();
if (!name) return { ok: false, field: "name", error: "A name is required." };

const userId = await currentUserId();
const clash = db
  .select({ id: tags.id })
  .from(tags)
  .where(
    and(
      eq(tags.userId, userId),
      // Case-insensitive: "News" and "news" are the same tag to the operator.
      sql`lower(${tags.name}) = lower(${name})`,
      // On update, the tag's own row is not a clash with itself.
      id === undefined ? undefined : ne(tags.id, id),
    ),
  )
  .get();

if (clash) return { ok: false, field: "name", error: "You already have a tag with that name." };
```

Checking first rather than catching the constraint error is what produces a usable field error instead of a raw SQLite string — the `UNIQUE` index remains as the backstop against a race.

`deleteTags` filters by `userId` in the `where`, so another user's ids simply do not match and `deleted` reports the true count.

- [ ] **Step 3: Run and commit**

```bash
cd yana-next && npm test -- tags
cd .. && git add yana-next && git commit -m "feat(next): Add tag queries and actions

Uniqueness is checked before insert rather than caught afterwards, so the UI gets
a field error instead of a raw SQLite constraint string; the UNIQUE index stays as
the race backstop. Comparison is case-insensitive and trimmed, because 'News' and
'news ' are the same tag to the operator.

Renaming a tag to its own current name is allowed -- otherwise saving an unchanged
form fails as a duplicate. Deletion detaches feeds via the feed_tags cascade and
never removes the feeds themselves."
```

---

### Task 2: The three routes

- [ ] **Step 1: The list page**

`requireUser()`, `parseListParams`, `<SearchFilterBar>` with no filter specs (search alone is enough for tags), and a `<Suspense>`-wrapped `<TagsTable>` with `<TableSkeleton>`.

Columns: name, feed count, created date. The feed count comes from `listTags`'s join — not from a per-row query, which would be N+1 at exactly the point a tag list gets long.

`DataTable`'s `rowId` is `(row) => String(row.id)` — tags key on an integer while the kit's selection contract is `string[]`, which the generic signature already accommodates.

- [ ] **Step 2: Create and edit**

`/tags/new` and `/tags/[id]`, both rendering `<TagForm>`. The form surfaces `field: "name"` errors inline on the name input rather than only as a toast.

The edit page's delete button uses `ConfirmDestructive` with copy from `tagUsage`: *"Delete "News"? It will be removed from 12 feeds. The feeds themselves are kept."* The second sentence is the point — without it the operator cannot tell.

- [ ] **Step 3: Bulk delete**

One bulk action, mirroring phase 5: `tagUsage` for the copy, then `deleteTags`, then `router.refresh()` and a toast with the count.

- [ ] **Step 4: Add message keys**

Both catalogs under `tags`. Phase 3's parity test enforces EN/DE alignment.

- [ ] **Step 5: Verify by hand**

Create a tag, attach it to a feed via the database, delete the tag, confirm the feed survives with no tag rows. Create a duplicate and confirm the inline field error. Sign in as a second user and confirm the same name is available and the first user's tag ids 404.

- [ ] **Step 6: Run every check and commit**

```bash
cd yana-next && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
cd .. && git add yana-next && git commit -m "feat(next): Add the tags tab

Second consumer of the phase 5 CRUD kit, confirming the kit is actually generic.
Feed counts come from a join rather than per-row queries, which would be N+1
exactly when a tag list grows.

The delete confirmation states that feeds are kept -- 'delete tag' otherwise reads
as though it might take the feeds with it."
```

---

## Self-Review

**Spec coverage.** Against bullet 8 ("tags crud tab like users crud (no admin)"): list with search (Task 2), create/edit subpages (Task 2), bulk select and bulk delete with confirmation (Task 2), delete on edit page (Task 2), not admin-gated (Task 2 Step 1). Complete.

**Placeholder scan.** Task 2 describes routes that follow phase 5's now-concrete pattern, with the tag-specific decisions stated explicitly (no filter specs, join for counts, `String(row.id)`, the "feeds are kept" copy). Task 1 — where the real logic lives — carries full tests and the load-bearing implementation.

**Type consistency.** `ListParams` comes from phase 5's `src/lib/crud/params.ts`. `Tag` is phase 2's inferred type. Ids are `number` throughout the tag layer, converted to `string` only at the `DataTable` boundary, which is where the kit's contract requires it. The action result adds an optional `field` to phases 3–7's `{ ok, error? }` shape — a widening, so existing consumers are unaffected.

**One note for phase 9.** Phase 9's feed form needs a tag multi-select, and it should reuse `listTags` rather than adding its own query. The `feedCount` column is superfluous there but harmless, and a second query path would be the more expensive mistake.
