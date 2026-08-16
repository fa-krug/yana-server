# Article Blocks Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove dead weight from the article-blocks format's server side (unused index, unreachable render branches, decorative surrogate key), make the always-empty `code_block.language` field live end-to-end, and pin the `writeBlocks` articleId invariant with a test.

**Architecture:** Six independent tasks against the existing block pipeline (`src/lib/aggregators/blocks/` → `article_blocks`/`article_inline_runs` → `src/lib/blocks/tree.ts` → `src/components/articles/block-node.tsx`). Two tasks carry Drizzle migrations (index swap; composite PK on inline runs), the rest are code-only. No wire-format (`schema.ts`) changes — the wire stays byte-compatible with the iOS twin.

**Tech Stack:** Next.js 16 / TypeScript, SQLite via Drizzle + better-sqlite3, Vitest (two projects: `.test.ts` = node/real SQLite, `.test.tsx` = jsdom), drizzle-kit for migrations.

**Spec:** No separate spec document — this plan implements the findings of a code audit recorded in its own task rationales below. Each task's opening paragraph is the spec for that task.

## Global Constraints

- Before every commit the four CI checks must pass: `npm run lint && npm run format:check && npm run typecheck && npm test`.
- Migrations are generated with `npx drizzle-kit generate` and are applied by the server at startup and by tests via `applyMigrationsAt()` — never hand-roll a loader or run them manually.
- A table that gains AND loses columns in one `drizzle-kit generate` prompts interactively and aborts without a TTY. Neither migration in this plan does both (Task 4 is index-only; Task 6 only loses a column), so both generate non-interactively. Do not merge the two schema edits into one generate run.
- Style: line length 100, double quotes, semicolons, trailing commas. Prettier owns formatting.
- Commit messages: `<type>(<scope>): <description>` (types: feat, fix, docs, style, refactor, test, chore).
- Every user-facing string comes from the message catalogs — no task in this plan adds user-facing strings, so `messages/*.json` must not change.
- The `.test.ts` extension runs in the node/real-SQLite project; `.test.tsx` runs in jsdom. Do not mix them up.

---

### Task 1: Parse `language` off `<pre><code class="language-…">`

`code_block.language` exists in the type, the wire format, the DB column and the renderer (`block-node.tsx:198` emits `language-${…}` for syntax-highlighting hooks) — but the one and only emitter, the `<pre>` handler in `parser.ts`, hard-codes `language: ""`, so the whole chain is dead. Populate it from the conventional `language-*` / `lang-*` class on the inner `<code>` element. Everything downstream (storage write at `storage.ts:107`, read at `storage.ts:287`, wire encode at `schema.ts:116`, render at `block-node.tsx:198`) already handles a non-empty value and needs no change.

**Files:**
- Modify: `src/lib/aggregators/blocks/parser.ts:762-769` (the `<pre>` handler)
- Test: `src/lib/aggregators/blocks/parser.test.ts`

**Interfaces:**
- Consumes: `parseBlocks(html: string, baseUrl?: string): Block[]` (existing export, unchanged signature).
- Produces: `code_block` blocks whose `language` is the first `language-<x>` or `lang-<x>` class token on the first `<code>` inside the `<pre>`, else `""`. No other task consumes this; the existing render path does.

- [ ] **Step 1: Write the failing tests**

Add to the `describe("parseBlocks", ...)` block in `src/lib/aggregators/blocks/parser.test.ts` (the file already imports `CodeBlock` from `./types`):

```ts
it("extracts the language from a language- class on pre > code", () => {
  const blocks = parseBlocks(`<pre><code class="language-ts">const x = 1;</code></pre>`);
  expect(blocks).toHaveLength(1);
  const code = blocks[0] as CodeBlock;
  expect(code.kind).toBe("code_block");
  expect(code.language).toBe("ts");
});

it("accepts the short lang- prefix and ignores unrelated classes", () => {
  const blocks = parseBlocks(`<pre><code class="hljs lang-python numbered">x = 1</code></pre>`);
  const code = blocks[0] as CodeBlock;
  expect(code.language).toBe("python");
});

it("leaves language empty when pre has no code class", () => {
  const blocks = parseBlocks(`<pre><code>plain</code></pre>`);
  expect((blocks[0] as CodeBlock).language).toBe("");

  const bare = parseBlocks(`<pre>no code element</pre>`);
  expect((bare[0] as CodeBlock).language).toBe("");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/aggregators/blocks/parser.test.ts -t "language"`
Expected: FAIL — `expected '' to be 'ts'` (and `'python'`); the empty-language test passes already, which is fine.

- [ ] **Step 3: Implement the extraction**

In `src/lib/aggregators/blocks/parser.ts`, replace the `<pre>` handler (currently lines 762-769):

```ts
    if (tag === "pre") {
      flush();
      const $pre = $(node as Element);
      const text = $pre.text();
      if (text.trim()) {
        // The `language-*` (and shorter `lang-*`) class on `<pre><code>` is the
        // de-facto fenced-code convention (highlight.js, Prism, CommonMark output).
        const codeClass = $pre.find("code").first().attr("class") ?? "";
        const languageMatch = /(?:^|\s)(?:language|lang)-([A-Za-z0-9_+-]+)/.exec(codeClass);
        blocks.push({ kind: "code_block", text, language: languageMatch?.[1] ?? "" });
      }
      continue;
    }
```

- [ ] **Step 4: Run the parser tests to verify they pass**

Run: `npx vitest run src/lib/aggregators/blocks/parser.test.ts`
Expected: PASS, including the pre-existing `preserves code block whitespace verbatim in pre tags` test.

- [ ] **Step 5: Run the four checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add src/lib/aggregators/blocks/parser.ts src/lib/aggregators/blocks/parser.test.ts
git commit -m "feat(aggregator): populate code_block.language from language-* classes"
```

---

### Task 2: Tighten `EmbedBlock.provider` to `EmbedProvider`

`EmbedBlock.provider` is typed `EmbedProvider | string` (`types.ts:79`), which collapses to `string` and buys nothing. Both real entry points already coerce unrecognized values to `"generic"` — `decodeBlock` (`schema.ts:206-209`) and `blockForRow` (`storage.ts:270-273`) — and the parser only ever emits the five members of `EMBED_PROVIDERS`. Narrowing the type is a compile-time-only change.

**Files:**
- Modify: `src/lib/aggregators/blocks/types.ts:79`

**Interfaces:**
- Consumes: `EmbedProvider` union (existing, same file).
- Produces: `EmbedBlock.provider: EmbedProvider`. Later tasks don't depend on this; existing coercion sites already produce `EmbedProvider`-typed values.

- [ ] **Step 1: Narrow the type**

In `src/lib/aggregators/blocks/types.ts`, change:

```ts
export interface EmbedBlock {
  kind: "embed";
  provider: EmbedProvider | string;
```

to:

```ts
export interface EmbedBlock {
  kind: "embed";
  provider: EmbedProvider;
```

- [ ] **Step 2: Typecheck — the compiler is the test here**

Run: `npm run typecheck`
Expected: PASS. If any call site fails, it is constructing an embed with a provider outside `EMBED_PROVIDERS` — inspect it rather than widening the type back; the correct fix at such a site is coercing to `"generic"` the way `decodeBlock` does. (Audit says there are none: the parser emits only `"video"`, `"generic"`, `"youtube"`, `"dailymotion"`, `"tweet"`.)

- [ ] **Step 3: Run the four checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add src/lib/aggregators/blocks/types.ts
git commit -m "refactor(aggregator): tighten EmbedBlock.provider to the EmbedProvider union"
```

---

### Task 3: Remove the unreachable `runs` render branches in `block-node.tsx`

`runsForNode()` (`storage.ts:118-126`) attaches inline runs only to `paragraph`, `heading` and `image` rows — `list_item` and `blockquote` rows never get runs; their content is child blocks. Yet `<BlockNode>` renders `node.runs` for both kinds (`block-node.tsx:93-95` and `105-107`). Those branches are unreachable and misleadingly imply the kinds carry text. Remove them; children rendering stays.

**Files:**
- Modify: `src/components/articles/block-node.tsx:90-111`
- Test: `src/components/articles/block-tree.test.tsx` (existing tests are the safety net; one new test pins the child rendering)

**Interfaces:**
- Consumes: `BlockNode` component and `BlockNodeType` from `@/lib/blocks/tree` (unchanged).
- Produces: same component; `list_item` and `blockquote` render children only. No later task consumes this.

- [ ] **Step 1: Read the existing test harness**

Read `src/components/articles/block-tree.test.tsx` to see how it builds `BlockNode` fixtures (it constructs `ArticleBlock`-shaped rows). Reuse its fixture helper/style for the next step rather than inventing a new one.

- [ ] **Step 2: Add a pinning test for blockquote/list_item child rendering**

Add a test (adapting fixture construction to the file's existing helper — the shape below shows the intent; `ArticleBlock` rows need the full column set, so copy how the existing tests build them):

```tsx
it("renders blockquote and list_item content from child blocks", () => {
  // blockquote (id 1) -> paragraph child (id 2) with one run "quoted text"
  // list (id 3, ordered=false) -> list_item (id 4) -> paragraph (id 5) with run "item text"
  // Build rows via the file's existing fixture pattern, then:
  render(<BlockTree blocks={blocks} runs={runs} />);
  expect(screen.getByText("quoted text")).toBeDefined();
  expect(screen.getByText("item text")).toBeDefined();
});
```

- [ ] **Step 3: Run it to verify it passes against current code**

Run: `npx vitest run src/components/articles/block-tree.test.tsx`
Expected: PASS (this is a pin, not a red test — the branches being removed are dead, so no behavior changes; the pin proves the *live* path survives the removal).

- [ ] **Step 4: Remove the dead branches**

In `src/components/articles/block-node.tsx`, change the `list_item` case (lines 90-100) to:

```tsx
    case "list_item":
      return (
        <li>
          {node.children?.map((child) => (
            <BlockNode key={child.id} node={child} />
          ))}
        </li>
      );
```

and the `blockquote` case (lines 102-111) to:

```tsx
    case "blockquote":
      return (
        <blockquote className="border-l-4 border-muted pl-4 italic space-y-2">
          {node.children?.map((child) => (
            <BlockNode key={child.id} node={child} />
          ))}
        </blockquote>
      );
```

- [ ] **Step 5: Run the component tests to verify nothing regressed**

Run: `npx vitest run src/components/articles/block-tree.test.tsx`
Expected: PASS, including the new pin from Step 2.

- [ ] **Step 6: Run the four checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add src/components/articles/block-node.tsx src/components/articles/block-tree.test.tsx
git commit -m "refactor(articles): drop unreachable runs rendering on list_item and blockquote"
```

---

### Task 4: Swap the `article_blocks` embed indexes

`article_blocks_embed_provider_idx` (`schema/articles.ts:148`) has no reader anywhere — the "articles containing video" query its comment promises was never written — while `embedThumbnailRef`, which `GET /api/v1/images/[hash]` queries on equality for its ownership path 3 (`route.ts:140`), has no index and scans. Drop the dead index, add the missing one, and fix the schema doc comment (`articles.ts:111`) that justifies the dead one.

**Files:**
- Modify: `src/lib/db/schema/articles.ts:106-148`
- Create: `drizzle/0015_<generated-name>.sql` (via `npx drizzle-kit generate` — never hand-written)
- Test: `src/lib/aggregators/blocks/storage.test.ts`

**Interfaces:**
- Consumes: `articleBlocks` table object (existing).
- Produces: index `article_blocks_embed_thumbnail_ref_idx` on `embed_thumbnail_ref`; index `article_blocks_embed_provider_idx` no longer exists. Task 6's migration is generated after this one and builds on this journal state.

- [ ] **Step 1: Write the failing index test**

Add to the `describe("block storage", ...)` block in `src/lib/aggregators/blocks/storage.test.ts` (the file already has the `raw()` helper and per-test migrated databases):

```ts
it("indexes embedThumbnailRef for the images ownership query, not embedProvider", () => {
  const names = raw(client.getDb())
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'article_blocks'`)
    .all()
    .map((row) => (row as { name: string }).name);
  expect(names).toContain("article_blocks_embed_thumbnail_ref_idx");
  expect(names).not.toContain("article_blocks_embed_provider_idx");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/aggregators/blocks/storage.test.ts -t "indexes embedThumbnailRef"`
Expected: FAIL — `article_blocks_embed_thumbnail_ref_idx` is not in the list yet.

- [ ] **Step 3: Edit the schema**

In `src/lib/db/schema/articles.ts`, replace line 148:

```ts
    index("article_blocks_embed_provider_idx").on(table.embedProvider),
```

with:

```ts
    // GET /api/v1/images/[hash] ownership path 3 queries embedThumbnailRef on
    // equality (an embed's localized poster is stored there); without this it scans.
    index("article_blocks_embed_thumbnail_ref_idx").on(table.embedThumbnailRef),
```

And update the table doc comment (lines 106-112) — the sentence `embedProvider is indexed ("articles containing video" becomes answerable)` is now false. Replace the comment with:

```ts
/**
 * One node of an article body in the Yana content format.
 *
 * Typed rows rather than an opaque JSON document, so the database understands
 * the data: imageRef and embedThumbnailRef are indexed because the images
 * route's ownership check joins on them (orphan pruning too, for imageRef).
 */
```

- [ ] **Step 4: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new `drizzle/0015_*.sql` containing exactly two statements — `DROP INDEX` for `article_blocks_embed_provider_idx` and `CREATE INDEX article_blocks_embed_thumbnail_ref_idx` — plus updated `drizzle/meta/` files. Index-only, no table rebuild, no interactive prompt. Read the generated SQL and confirm this before proceeding; if it contains anything else, stop and investigate.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/aggregators/blocks/storage.test.ts`
Expected: PASS — `applyMigrationsAt()` runs the same journal the server uses, so the new migration is exercised for real.

- [ ] **Step 6: Run the four checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add src/lib/db/schema/articles.ts src/lib/aggregators/blocks/storage.test.ts drizzle/
git commit -m "feat(db): index embedThumbnailRef instead of the unread embedProvider"
```

---

### Task 5: Pin the `writeBlocks` articleId invariant

`article_blocks.articleId` is a deliberate denormalization on nested rows (flat delete, two-query read, single-join ownership check) — but nothing in the schema enforces that a child's `articleId` matches its parent's. Today only `writeBlocks`'s level-by-level threading keeps them agreed, and a divergent row would silently vanish from both articles on read (the reader filters by `articleId`, then groups by `parentId`). A `CHECK` cannot express a self-join, so pin the invariant with a real-database test.

**Files:**
- Test: `src/lib/aggregators/blocks/storage.test.ts`

**Interfaces:**
- Consumes: `writeBlocks(articleId: number, blocks: Block[]): Promise<number>` and the existing `TREE` fixture + `articleId` seeded in `beforeEach` (all already in this test file).
- Produces: nothing — test-only task.

- [ ] **Step 1: Write the test**

Add to the `describe("block storage", ...)` block in `src/lib/aggregators/blocks/storage.test.ts`:

```ts
it("threads the article's own id onto every row at every depth", async () => {
  await storage.writeBlocks(articleId, TREE);

  const rows = client.getDb().select().from(schema.articleBlocks).all();

  // The fixture nests three levels deep (list -> list_item -> list), so this
  // exercises the threading, not just the root insert.
  expect(rows.some((row) => row.parentId !== null)).toBe(true);
  for (const row of rows) {
    expect(row.articleId).toBe(articleId);
  }
});
```

- [ ] **Step 2: Run it to verify it passes**

Run: `npx vitest run src/lib/aggregators/blocks/storage.test.ts -t "threads the article"`
Expected: PASS. This is a pin: to see it fail, temporarily change `rowForNode`'s `articleId` parameter use to `articleId + 1` for nested rows, watch it fail, revert (per this repo's convention that a new structural assertion is checked against the defect it describes).

- [ ] **Step 3: Run the four checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add src/lib/aggregators/blocks/storage.test.ts
git commit -m "test(db): pin writeBlocks threading one articleId through every level"
```

---

### Task 6: Composite primary key on `article_inline_runs`

`article_inline_runs.id` is a decorative surrogate: nothing has a foreign key pointing at the table, `(blockId, position)` is unique by construction and is what every read orders by, and the only consumer is a React key that already carries an index fallback (`block-node.tsx:55`). Replace `id AUTOINCREMENT` with a composite PK `(blockId, position)` — which also sheds the `sqlite_sequence` bookkeeping and makes `article_inline_runs_block_idx` redundant (the PK covers the same leading columns), so drop that index too.

**Files:**
- Modify: `src/lib/db/schema/articles.ts:166-185`
- Modify: `src/components/articles/block-node.tsx:55`
- Create: `drizzle/0016_<generated-name>.sql` (via `npx drizzle-kit generate`)
- Test: existing suites (`storage.test.ts`, `block-tree.test.tsx`, `src/app/(app)/articles` and `/api/v1` tests) are the net; one new uniqueness test

**Interfaces:**
- Consumes: journal state after Task 4 (generate order matters for the migration number, nothing else).
- Produces: `ArticleInlineRun` (`$inferSelect`) no longer has an `id` field. Any code reading `run.id` must switch to positional identity. Audit found exactly one reader: `renderInlineRun`'s React key.

- [ ] **Step 1: Confirm the audit — find every `id` reader on inline runs**

Run: `grep -rn "run\.id\|runs\[0\]\.id\|inlineRuns\.id\|articleInlineRuns.id" src --include="*.ts" --include="*.tsx"`
Expected: only `src/components/articles/block-node.tsx:55` (`key={run.id ?? index}`). If anything else appears, list it and update it in Step 3 alongside.

- [ ] **Step 2: Edit the schema**

In `src/lib/db/schema/articles.ts`, add `primaryKey` to the existing `drizzle-orm/sqlite-core` import, then change `articleInlineRuns` to:

```ts
export const articleInlineRuns = sqliteTable(
  "article_inline_runs",
  {
    blockId: integer("block_id")
      .notNull()
      .references(() => articleBlocks.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    bold: integer("bold", { mode: "boolean" }).notNull().default(false),
    italic: integer("italic", { mode: "boolean" }).notNull().default(false),
    code: integer("code", { mode: "boolean" }).notNull().default(false),
    strikethrough: integer("strikethrough", { mode: "boolean" }).notNull().default(false),
    link: text("link").notNull().default(""),
  },
  (table) => [
    // (blockId, position) is the natural key: nothing FKs into this table, and
    // every read orders by exactly these columns. The PK also serves the index
    // the dropped article_inline_runs_block_idx used to provide.
    primaryKey({ columns: [table.blockId, table.position] }),
    check("article_inline_runs_position_positive", sql`"position" >= 0`),
  ],
);
```

- [ ] **Step 3: Update the one React-key consumer**

In `src/components/articles/block-node.tsx`, change line 55 from:

```tsx
  return <React.Fragment key={run.id ?? index}>{content}</React.Fragment>;
```

to:

```tsx
  return <React.Fragment key={index}>{content}</React.Fragment>;
```

(Runs within one block are an ordered, immutable projection — the whole body is rewritten wholesale by `writeBlocks` — so positional keys are exact here, not a lint-appeasing compromise.)

- [ ] **Step 4: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new `drizzle/0016_*.sql` performing the SQLite table-rebuild dance for `article_inline_runs` (create `__new_article_inline_runs` with the composite PK, `INSERT INTO ... SELECT block_id, position, text, bold, italic, code, strikethrough, link FROM article_inline_runs`, drop old, rename, recreate the check) and dropping `article_inline_runs_block_idx`. The table only *loses* a column (`id`) and gains none, so no interactive prompt fires. Read the generated SQL: confirm the copy step preserves all eight remaining columns and that `foreign_keys` handling is drizzle's standard `PRAGMA foreign_keys=OFF/ON` wrap. If the generated SQL drops rows or misses a column, stop.

- [ ] **Step 5: Write the uniqueness pin**

Add to `src/lib/aggregators/blocks/storage.test.ts`:

```ts
it("refuses two runs at the same (blockId, position)", async () => {
  await storage.writeBlocks(articleId, TREE);

  const firstRun = client.getDb().select().from(schema.articleInlineRuns).all()[0];
  expect(firstRun).toBeDefined();

  expect(() =>
    client.writeTransaction((tx) => {
      tx.insert(schema.articleInlineRuns)
        .values({ blockId: firstRun.blockId, position: firstRun.position, text: "dup" })
        .run();
    }),
  ).toThrow(/UNIQUE|PRIMARY/i);
});
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS across both projects. Pay attention to `src/lib/db/relations.test.ts` (relation traversals), the articles page/API tests, and `block-tree.test.tsx` — these are the places a missed `id` reader would surface. A TypeScript error anywhere `run.id` survives is the compiler doing Step 1's job again; fix the site to positional identity.

- [ ] **Step 7: Run the four checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add src/lib/db/schema/articles.ts src/components/articles/block-node.tsx src/lib/aggregators/blocks/storage.test.ts drizzle/
git commit -m "refactor(db): natural (blockId, position) key on article_inline_runs"
```

---

## Explicitly out of scope

- **Wire format (`schema.ts`) trimming** — `language` and `thumbnailRef` stay on the wire; they mirror the iOS twin, and Task 1 makes `language` live anyway.
- **Dropping `article_blocks.language`** — resolved the opposite way by Task 1 (the column becomes useful).
- **A trigger enforcing child/parent articleId agreement** — the test in Task 5 was chosen over a trigger; revisit only if a second writer besides `writeBlocks` ever appears.

## Self-review notes

- Coverage: audit items → tasks: index swap (4), dead render branches (3), dead language hook (1, as "make live"), provider typing (2), inline-run surrogate key (6), articleId invariant (5), wire-format restraint (out-of-scope section). All covered.
- Ordering constraint: Task 6's generate must run after Task 4's so migration numbering is linear; tasks 1–3 and 5 are order-free.
- Type consistency: `ArticleInlineRun` loses `id` only in Task 6, and Task 6 owns the single consumer fix; Tasks 3's edits to `block-node.tsx` touch different lines (90-111) than Task 6's (55) — no merge conflict in content, but if executed by different agents, Task 6 should re-read the file rather than patch by stale line numbers.
