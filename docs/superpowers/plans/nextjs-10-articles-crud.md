# Phase 10: Articles CRUD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An articles tab with a general section (title, feed, date, added date) and a content section listing the article's blocks.

**Architecture:** Phase 5's CRUD kit again, with one genuinely new piece: a block-tree renderer. Blocks are **derived data** — rebuilt wholesale from `rawContent` whenever an article is reprocessed — so the content section is a read-only inspector, not an editor. This is the admin-parity surface the direction record calls for: block trees have to be legible by eye, not only by test assertion.

**Tech Stack:** Phase 5's CRUD kit, Drizzle, phase 2's block schema.

## Global Constraints

- **Blocks are read-only.** Editing them would be overwritten on the next reprocess, and there is no path from edited blocks back to `rawContent`. The UI must not offer editing.
- Editable general fields are **title, feed, date** only. `createdAt` is displayed but never editable — it is the sync cursor phase 13 builds on, and rewriting it would corrupt incremental sync.
- Owner-scoped through `feedId`. Another user's article behaves as nonexistent.
- The article list is the largest table in the app. Every query is paginated and uses an index from phase 2 — no unbounded scans, no `plainText` in list queries.
- The block tree loads as its **own** `<Suspense>` boundary, separate from the general section. A 200-block article must not delay the title.
- Images referenced as `yana-img://<hash>` resolve through a media route; the renderer never fabricates a URL from the hash inline.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/articles/queries.ts` | `listArticles`, `getArticle`, `getBlockTree` |
| `src/lib/articles/actions.ts` | `updateArticle`, `deleteArticles`, `setRead`, `setStarred` |
| `src/lib/blocks/tree.ts` | `buildTree(rows)` — flat rows to nested nodes |
| `src/components/articles/block-tree.tsx` | Read-only block renderer |
| `src/components/articles/block-node.tsx` | One block, recursive |
| `src/app/(app)/articles/{page,[id]/page}.tsx` | List, detail |
| `src/app/media/images/[hash]/route.ts` | Serves `article_images` by hash |

---

### Task 1: Rebuild the tree from flat rows

`articleBlocks` stores a parent pointer and a position; rendering needs nesting. `list_item` is the synthetic kind that encodes a list's `[[Block]]` shape, so it appears in rows but must not render as a block of its own.

**Interfaces:**
- Produces:
  - `type BlockNode = ArticleBlock & { children: BlockNode[]; runs: ArticleInlineRun[] }`
  - `buildTree(blocks: ArticleBlock[], runs: ArticleInlineRun[]): BlockNode[]`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/blocks/tree.test.ts
import { describe, expect, it } from "vitest";

import { buildTree } from "./tree";

const block = (id: number, parentId: number | null, position: number, kind: string) =>
  ({ id, parentId, position, kind, text: "", level: null, ordered: null,
     imageRef: "", embedProvider: "", embedThumbnailRef: "", embedExternalUrl: "",
     embedTitle: "", language: "", articleId: 1 }) as never;

describe("buildTree", () => {
  it("returns root blocks in position order", () => {
    const tree = buildTree(
      [block(2, null, 1, "paragraph"), block(1, null, 0, "heading")],
      [],
    );
    expect(tree.map((node) => node.id)).toEqual([1, 2]);
  });

  it("nests a list's items and their content", () => {
    const tree = buildTree(
      [
        block(1, null, 0, "list"),
        block(2, 1, 0, "list_item"),
        block(3, 2, 0, "paragraph"),
      ],
      [],
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].kind).toBe("list_item");
    expect(tree[0].children[0].children[0].kind).toBe("paragraph");
  });

  it("attaches runs to their block in position order", () => {
    const tree = buildTree(
      [block(1, null, 0, "paragraph")],
      [
        { id: 2, blockId: 1, position: 1, text: "b", bold: false, italic: false,
          code: false, strikethrough: false, link: "" },
        { id: 1, blockId: 1, position: 0, text: "a", bold: false, italic: false,
          code: false, strikethrough: false, link: "" },
      ] as never,
    );
    expect(tree[0].runs.map((run) => run.text)).toEqual(["a", "b"]);
  });

  it("drops a block whose parent is missing rather than losing the whole tree", () => {
    // Defensive: an orphan should cost one block, not the render.
    const tree = buildTree([block(1, null, 0, "paragraph"), block(2, 99, 0, "paragraph")], []);
    expect(tree).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement**

Single pass building an id→node map, second pass attaching each node to its parent's `children` or to the roots, then sort every `children` array and the roots by `position`. Runs are grouped by `blockId` in one pass and sorted by `position`.

Orphans — a `parentId` with no matching row — are skipped, not thrown on: one corrupt row should cost one block, not the whole article view.

- [ ] **Step 3: Run and commit**

```bash
npm test -- tree
git add -A && git commit -m "feat(next): Rebuild block trees from flat rows

Two passes plus a sort, with runs grouped by block. An orphaned block -- a parentId
with no matching row -- is skipped rather than raising, so one corrupt row costs one
block instead of the whole article view."
```

---

### Task 2: The image route and block renderer

**Interfaces:**
- Produces: `GET /media/images/[hash]` serving `article_images` bytes; `<BlockTree nodes={...} />`.

- [ ] **Step 1: Write the image route**

Looks up `articleImages` by `contentHash`, streams the file with the stored `contentType`, and sets `Cache-Control: public, max-age=31536000, immutable` — safe precisely because the URL *is* the content hash, so the bytes at a given URL can never change.

Returns 404 for an unknown hash. Validates the hash is 64 hex characters before touching the filesystem, so a path-traversal attempt never reaches a file read.

- [ ] **Step 2: Write the renderer**

`<BlockNode>` switches on `kind`:

| Kind | Rendering |
|---|---|
| `paragraph` | `<p>` with runs |
| `heading` | `<h1>`–`<h6>` from `level`, clamped 1–6 |
| `list` | `<ol>`/`<ul>` from `ordered`, children are `list_item` |
| `list_item` | `<li>` wrapping its children — never rendered standalone |
| `blockquote` | `<blockquote>` wrapping children |
| `image` | `<img>` from `imageRef`, with the caption runs below |
| `embed` | thumbnail plus provider badge, linking to `embedExternalUrl` |
| `code_block` | `<pre><code>` with `language` shown |
| `divider` | `<hr>` |
| unknown | **skipped silently** — the format's extensibility rule is that an unknown kind is never fatal |

Runs render nested spans by style, with `link` becoming an `<a>` carrying `rel="noreferrer noopener"`.

An `imageRef` starting `yana-img://` maps to `/media/images/<hash>`; anything else is used as a URL directly, since `ImageBlock.ref` may legitimately hold a remote URL.

- [ ] **Step 3: Add a debug affordance**

Above the tree, a toggle switching between the rendered view and the raw JSON of the block rows. This is what makes the block model inspectable by eye — the requirement the direction record carries forward from the admin phase — and it is how the phase 11 port gets diagnosed.

- [ ] **Step 4: Verify and commit**

Seed an article with every block kind, including nested lists and a blockquote containing a list, and confirm each renders. Confirm an unknown `kind` row is skipped without breaking the page.

```bash
git add -A && git commit -m "feat(next): Add the block renderer and content-addressed image route

Unknown block kinds are skipped rather than raising, matching the format's
extensibility rule on both sides of the wire.

Images cache immutably for a year, which is safe because the URL is the content
hash -- the bytes at a URL can never change. The hash is validated as 64 hex
characters before any filesystem access.

A raw-JSON toggle sits above the tree: it is what makes the block model
inspectable by eye, and it is how the phase 11 port will be diagnosed."
```

---

### Task 3: Queries, list and detail

**Interfaces:**
- Produces:
  - `listArticles(params: ListParams): Promise<{ rows: (Article & { feedName: string })[]; total: number }>`
  - `getArticle(id: number): Promise<(Article & { feed: Feed }) | null>`
  - `getBlockTree(articleId: number): Promise<BlockNode[]>`
  - `updateArticle(id: number, input: unknown)`, `deleteArticles(ids: number[])`

- [ ] **Step 1: Write the query with explicit column selection**

```ts
// the load-bearing part of listArticles
// plainText is deliberately absent: it is the largest column on the table and no
// list column shows it. Selecting it would multiply the payload for nothing.
const rows = db
  .select({
    id: articles.id, name: articles.name, date: articles.date,
    createdAt: articles.createdAt, read: articles.read, starred: articles.starred,
    author: articles.author, feedId: articles.feedId, feedName: feeds.name,
  })
  .from(articles)
  .innerJoin(feeds, eq(articles.feedId, feeds.id))
  .where(and(eq(feeds.userId, userId), ...conditions))
  .orderBy(desc(articles.date))
  .limit(params.pageSize)
  .offset((params.page - 1) * params.pageSize)
  .all();
```

Search matches `name` and `plainText` with `like`. Note in a comment that this is a scan, and that a proper solution is FTS5 — deliberately deferred, not overlooked, since it needs its own index and migration.

- [ ] **Step 2: Build the list page**

Filters: feed, read, starred, tag (through `feed_tags`). Columns: title, feed, date, added, read/starred indicators. Bulk actions: delete (confirmed), mark read/unread, star/unstar. Phase 12 adds reload.

- [ ] **Step 3: Build the detail page**

Two sections, each its own `<Suspense>` boundary:

- **General** — editable title, feed `Select`, date picker; `createdAt` shown read-only with a note that it is the sync ordering key.
- **Content** — `<Suspense fallback={<TableSkeleton rows={12} columns={1} />}>` around the async block tree. Separate boundary so a 200-block article does not delay the title.

- [ ] **Step 4: Verify and commit**

Confirm the general section streams before the block tree on a large article (`curl -N`, as phase 3 established). Confirm `createdAt` has no editable control. Confirm another user's article id 404s.

```bash
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
git add -A && git commit -m "feat(next): Add the articles tab

The block tree gets its own Suspense boundary so a 200-block article does not delay
the title. List queries omit plainText -- the largest column, shown in no list
column -- and select columns explicitly rather than the whole row.

createdAt is displayed but not editable: it is the ordering key phase 13's sync
cursor builds on, and rewriting it would corrupt incremental sync. Free-text search
is a LIKE scan; FTS5 is deferred deliberately, since it needs its own migration."
```

---

## Self-Review

**Spec coverage.** Against bullet 10: general section with title, feed, date and added date (Task 3), content section listing blocks (Tasks 1–3). Complete.

**Placeholder scan.** Task 2's renderer is specified as a kind→rendering table rather than full JSX; every kind is enumerated including the synthetic `list_item` and the skip-unknown rule, and the `yana-img://` versus remote-URL distinction is stated. Task 1 — the part with real logic and a real failure mode — carries complete tests.

**Type consistency.** `BlockNode` is declared in Task 1 and consumed by `getBlockTree` and `<BlockTree>`. Column names match phase 2 exactly (`imageRef`, `embedProvider`, `embedThumbnailRef`, `embedExternalUrl`, `embedTitle`, `parentId`). `ListParams` and the CRUD kit come from phase 5.

**Two deliberate deferrals, recorded so they are not mistaken for gaps.** FTS5 search (needs its own migration) and the article reload bulk action (needs phase 11c's pipeline, so it belongs to phase 12).
