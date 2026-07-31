# Spec 5: The Yana Content Format

> **Superseded by the Next.js migration (2026-07-30).** The Django implementation
> described here now lives in `old/`, read-only — paths like `core/…` are `old/core/…`
> today. This document is kept as a record of decisions that were correct when made,
> and its behavior descriptions remain the reference for porting them to TypeScript.
> See [the Next.js direction record](2026-07-30-nextjs-migration-direction.md).

**Date:** 2026-07-29
**Status:** Approved design, pending spec review
**Depends on:** Spec 4 (image hosting — supplies the `yana-img://<hash>` reference `image_ref` holds)
**Direction:** `2026-07-29-client-server-remigration-direction.md`

## Goal

Make the server store article bodies in the Yana content format — the typed block model the iOS
reader renders — instead of HTML. Three parts:

1. **Pin the format** as an explicit, versioned, language-neutral JSON schema.
2. **Port `BlockParser`** (HTML → blocks) from Swift to Python.
3. **Store blocks relationally** as `ArticleBlock` / `ArticleInlineRun` rows.

HTML does not disappear from the pipeline — it remains the intermediate representation between
extraction and block conversion. It stops being what we *store and serve*.

## Part 1 — Pinning the format

### The problem with the current format

iOS's `Block`, `Embed`, `InlineRun`, and `InlineStyle` (`../yana-ios/Yana/Reader/Block.swift`) use
Swift's **synthesized** `Codable` — there are no `CodingKeys` anywhere in the file. For an enum with
associated values, synthesis emits compiler-internal shapes:

```json
{"paragraph": {"_0": [ … ]}}            // unlabeled associated value → synthetic "_0"
{"heading": {"level": 2, "runs": [ … ]}} // labeled → real keys
```

`InlineStyle` is an `OptionSet` and serializes as a bare integer bitmask.

Making a Python server emit `_0` keys would tie the wire format to an undocumented Swift compiler
detail that can change between releases, and it is hostile to any non-Swift client. It happens to
work today only because one language reads and writes it.

### The pinned schema

Version the envelope and give every block an explicit `type` discriminator:

```json
{
  "version": 1,
  "blocks": [
    {"type": "paragraph", "runs": [{"text": "Hi", "styles": ["bold"], "link": null}]},
    {"type": "heading", "level": 2, "runs": []},
    {"type": "list", "ordered": false, "items": [[], []]},
    {"type": "blockquote", "blocks": []},
    {"type": "image", "ref": "yana-img://<sha256>", "caption": []},
    {"type": "embed", "provider": "youtube",
     "thumbnailRef": null, "externalURL": "https://…", "title": null},
    {"type": "codeBlock", "text": "…", "language": null},
    {"type": "divider"}
  ]
}
```

Decisions:

- **`styles` is a string array**, not an int bitmask. `["bold", "italic"]` is self-describing across
  languages; `3` is not. Valid members: `bold`, `italic`, `code`, `strikethrough`.
- **`version` is on the envelope**, not per block, so a future format change is one check.
- **`level` is clamped 1–6** by the producer, as iOS already does.
- **Nested structures are nested arrays** on the wire — `list.items` is an array of block arrays,
  `blockquote.blocks` is an array. The `list_item` row kind in Part 3 is a *storage* detail that never
  appears on the wire.
- **`provider`** is one of `youtube`, `dailymotion`, `video`, `tweet`, `generic`.
- **Unknown block types must be skipped, not fatal**, on both sides. This is what makes adding a
  block type later a non-breaking change.

### iOS-side work

Write explicit `init(from:)` / `encode(to:)` for `Block`, `Embed`, `InlineRun`, and `InlineStyle`
matching the schema above, plus a migration for already-stored `Article.blockData`.

The migration must **detect which format a stored blob is in** — synthesized (has a single key like
`"paragraph"` at each element, or a `"_0"` inside) versus pinned (has `"type"`) — and convert the old
to the new. There is an existing `BlockMigration` sweep in the iOS codebase that this can follow.

Decode every field with `decodeIfPresent`. This is not optional politeness: the iOS
`AggregatorOptions` file documents that SwiftData's composite decoder **traps (EXC_BREAKPOINT) rather
than throwing** on a missing key, and the same discipline applies here.

This iOS work is tracked here because it defines the contract, but it lands in the **iOS repo**. It is
the one item in this route that is not a server change.

## Part 2 — Porting `BlockParser`

`core/aggregators/utils/block_parser.py`, converting sanitized article HTML to blocks with
BeautifulSoup where iOS uses SwiftSoup.

The Swift original (`../yana-ios/Yana/Aggregators/Utils/BlockParser.swift`, 332 lines) is the
reference. Its structure translates directly.

### Tag handling

**Inline tags** — buffered into the surrounding paragraph rather than making a block:

```
a b strong i em code span mark u s strike del sub sup small abbr cite q time label font ins var kbd
```

**Dropped wholesale** — not recursed into, because recursing surfaces noise (table cells become
stray paragraphs):

```
table thead tbody tfoot tr td th form input button select textarea
script style noscript iframe audio svg canvas
```

**Mapped to blocks:**

| Tag | Result |
|---|---|
| `p` | `paragraph` — **plus** any `<img>` inside split out as separate `image` blocks after the text |
| `h1`–`h6` | `heading`, level clamped 1–6 |
| `ul` / `ol` | `list` |
| `blockquote` | `embed` if it is a recognizable tweet facade, else `blockquote` |
| `pre` | `codeBlock` (language always `null` — iOS never infers it) |
| `hr` | `divider` |
| `img` | `image` |
| `video` | `embed` |
| `figure` | figure handling (image with caption, or embed) |
| `br` | a `\n` inline run |
| anything else | **recursed into** — an unknown `div`/`section`/`header`/`article` is checked for an embed facade, then walked for known blocks and discarded |

Two subtleties worth carrying over exactly:

- **The `<p><img></p>` case.** Inline-run extraction drops images, so a paragraph wrapping media
  would vanish. Reddit emits Giphy, gallery, and inline images as exactly that. Images must be split
  out as their own blocks after the paragraph's text; a pure-image `<p>` yields just the image.
- **Drop vs. recurse is the whole design.** Unknown wrappers recurse (their children may be real
  content); known-noise tags drop (their children are never content). Getting this backwards either
  loses articles or fills them with table debris.

### `plain_text`

Port `BlockParser.plainText` — flatten blocks to visible text, sections joined by blank lines,
skipping empty segments. Stored on `Article.plain_text` (Part 3) for search.

### Where conversion runs

At **save time**, once, in the article-persisting path — mirroring iOS, where conversion happens in
`ArticleUpsert` at import and never on the render path. Blocks are written alongside the article in
the same transaction.

### The footer

`format_article_content` appends a `<footer>` with a source link
([content_formatter.py](../../../core/aggregators/utils/content_formatter.py)); iOS's equivalent
deliberately does not, because the reader exposes the source via its toolbar.

Converted naively that footer becomes a junk paragraph containing a bare URL at the end of every
article. **Stop emitting it.** With GReader gone there is no client that renders `Article.content`
directly, so the footer has no remaining audience. The article URL is already on
`Article.identifier`, so nothing is lost.

## Part 3 — Relational storage

```python
BLOCK_KINDS = [
    "paragraph", "heading", "list", "list_item", "blockquote",
    "image", "embed", "code_block", "divider",
]

class ArticleBlock(models.Model):
    article  = models.ForeignKey(Article, related_name="blocks", on_delete=models.CASCADE)
    parent   = models.ForeignKey("self", null=True, blank=True,
                                 related_name="children", on_delete=models.CASCADE)
    position = models.PositiveIntegerField()
    kind     = models.CharField(max_length=20, choices=[(k, k) for k in BLOCK_KINDS])

    level    = models.PositiveSmallIntegerField(null=True, blank=True)   # heading
    ordered  = models.BooleanField(null=True, blank=True)                # list
    text     = models.TextField(blank=True, default="")                  # code_block
    language = models.CharField(max_length=50, blank=True, default="")   # code_block
    image_ref = models.TextField(blank=True, default="")                 # image

    embed_provider      = models.CharField(max_length=20, blank=True, default="")
    embed_thumbnail_ref = models.TextField(blank=True, default="")
    embed_external_url  = models.TextField(blank=True, default="")
    embed_title         = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["position"]
        constraints = [
            models.UniqueConstraint(fields=["article", "parent", "position"],
                                    name="uniq_block_position"),
        ]
        indexes = [
            models.Index(fields=["article", "parent", "position"]),
            models.Index(fields=["image_ref"]),
            models.Index(fields=["embed_provider"]),
        ]

class ArticleInlineRun(models.Model):
    block    = models.ForeignKey(ArticleBlock, related_name="runs", on_delete=models.CASCADE)
    position = models.PositiveIntegerField()
    text     = models.TextField()
    # One field per style. Do NOT write `bold = italic = … = BooleanField(…)` — chained
    # assignment binds a single field instance to four names and Django mishandles it.
    bold          = models.BooleanField(default=False)
    italic        = models.BooleanField(default=False)
    code          = models.BooleanField(default=False)
    strikethrough = models.BooleanField(default=False)
    link     = models.TextField(blank=True, default="")

    class Meta:
        ordering = ["position"]
        indexes = [models.Index(fields=["block", "position"])]
```

Add to `Article`:

```python
plain_text = models.TextField(blank=True, default="")   # flattened blocks, for search
```

### Design notes

- **`list_item` encodes `[[Block]]`.** A `list` block's children are `list_item` blocks; each
  `list_item`'s children are the actual content blocks. This is the one synthetic kind, and it exists
  purely because a list holds *sequences*, not blocks. It never appears on the wire.
- **Styles are real booleans**, not a bitmask int. The entire reason for choosing rows over a JSON
  document is that the database understands the data; an opaque integer would give that back.
- **`UniqueConstraint(article, parent, position)`** makes sibling ordering unambiguous, but only for
  non-`NULL` parents: SQLite treats `NULL`s as distinct in a unique index, so root-level blocks are
  **not** protected by it. Enforce root ordering in the writer instead, and note the limitation
  rather than pretending the constraint covers it.
- **`image_ref` is indexed**, which turns Spec 4's orphan pruning from a text scan of every article
  body into a JOIN. Spec 4's `prune_orphaned_images` command should be rewritten against this index
  once this spec lands — that rewrite is called out in Spec 4 and belongs to this one.
- **`embed_provider` is indexed** so "articles containing video" is answerable.

### Reading efficiency

The cost concern with rows is reassembling trees. It is bounded to **two queries per batch,
regardless of nesting depth**:

```python
blocks = (ArticleBlock.objects
          .filter(article__in=article_ids)
          .prefetch_related("runs")
          .order_by("article", "parent_id", "position"))
```

Then group by `parent_id` in Python and attach children. No recursive CTE, no N+1.

Two things keep this off the hot path entirely: article **lists** need only title/date/feed and no
blocks at all, and search uses `plain_text` rather than traversing rows. Bodies load when an article
is opened.

Writing uses `bulk_create` per depth level — parents before children, since children need parent PKs.

### Does `Article.content` survive?

Keep the column for **one release**, populated as before, purely so block conversion can be diffed
against the HTML it came from during verification. It is no longer a contract. Drop it once blocks are
trusted; a follow-up migration, not part of this spec.

`Article.raw_content` stays indefinitely — it is the pre-extraction source and remains the most useful
thing to have when debugging a scraper.

## Backfill

`convert_articles_to_blocks` management command:

1. For each article with `content` but no blocks, run the parser.
2. Write blocks, runs, and `plain_text`.
3. Batched, idempotent, resumable — re-running skips articles that already have blocks.
4. `--dry-run` reporting article counts and block-count distribution, `--limit` for trials.
5. A parse failure logs the article ID and leaves it blockless rather than aborting the run.

Order matters: run this **after** Spec 4's `migrate_inline_images`, so bodies already carry
`yana-img://` refs rather than base64 blobs. Converting first would embed data URIs into `image_ref`.
State that ordering in the command's help text.

## Admin — the verification surface

This phase has no client, so admin has to make block trees legible. Without this, "collect and store
the data correctly" is unverifiable.

- **Inline `ArticleBlock` on the Article admin**, ordered, showing kind, position, and a short content
  preview per row (first runs' text, or `image_ref`, or `embed_external_url`).
- A **read-only rendered preview** on the Article change page: walk the block tree and render it as
  simple indented HTML. This is what makes a wrong conversion obvious at a glance — a missing image,
  a paragraph that swallowed a heading, leftover chrome.
- Show `plain_text` as a read-only field.
- Blocks are **read-only in admin**. They are derived data; hand-editing them would be silently
  overwritten on the next aggregation and invites inconsistent trees.
- A **"Re-convert blocks"** admin action on selected articles, re-running the parser from `content`.
  This is the iteration loop for tuning the parser: change the parser, re-convert, look.

## Error handling

- **Unparseable HTML** → zero blocks, article still saved, warning logged with the article ID. An
  article with no body beats a failed run.
- **Unknown tag** → recursed (unknown wrapper) or dropped (known noise), never fatal.
- **Unknown block `type` on decode** → skipped, not fatal, on both sides. This is what makes the
  format extensible.
- **Malformed `list` nesting** (a `list` whose children aren't `list_item`) → wrap the strays in a
  synthetic `list_item` rather than dropping them.
- **Empty blocks** — a paragraph with no runs, a list with no items — are **not persisted**. iOS
  already suppresses these (`if !runs.isEmpty`); persisting them would produce visible blank gaps.
- **Orphaned rows**: `on_delete=CASCADE` on both FKs means deleting an article removes its blocks and
  runs. Deleting a `list` block removes its `list_item` children and their subtrees.

## Testing

**Parser (unit, mirroring the Swift tests)**
- Each mapped tag produces its block kind; `h1`–`h6` clamp correctly.
- Inline tags buffer into one paragraph; `<br>` becomes a newline run.
- Nested styles combine (`<b><i>` → both flags on one run).
- Links become runs with `link` set, resolved absolute against the article URL.
- Dropped tags produce nothing, and their **children** produce nothing (table cells must not leak).
- Unknown wrappers are recursed: a `<div><p>x</p></div>` yields the paragraph.
- **`<p><img></p>` yields an image block** — the Reddit/Giphy regression guard.
- A `<p>` with text *and* an image yields a paragraph then an image, in that order.
- Nested lists round-trip through `list_item`.
- A tweet-facade `blockquote` becomes an `embed`; an ordinary one becomes a `blockquote`.
- Empty paragraphs and empty lists are omitted.
- `plain_text` flattens in document order, blank-line separated, skipping empties.

**Schema**
- Every block kind round-trips through encode → decode unchanged.
- `styles` encodes as a string array; an unknown style name is ignored, not fatal.
- An unknown block `type` is skipped and surrounding blocks survive.
- A payload missing an optional key decodes with defaults.
- Golden-file test: a fixture JSON document decodes to the expected tree. This is the artifact the
  iOS side tests against too — the shared contract check.

**Storage**
- A tree writes and reads back identical, including nesting order.
- Reading N articles issues a **bounded** query count independent of depth (assert with
  `assertNumQueries`).
- Deleting an article cascades to blocks and runs.
- Deleting a `list` cascades to its `list_item` subtree.

**Backfill**
- Converts an article with content; idempotent across two runs; `--dry-run` writes nothing; a parse
  failure leaves that article blockless and continues; ordering guard — an article still containing
  `data:image` is reported rather than silently embedding it in `image_ref`.

## Verification via admin

1. `python3 manage.py migrate`.
2. `python3 manage.py test_aggregator <mein_mmo id> --first 1` — a rich article with images, embeds,
   and lists.
3. Open it in admin: block inline shows a sensible tree; the rendered preview reads like the article;
   no trailing bare-URL paragraph (the footer is gone).
4. Compare against the `content` field (still populated this release) — nothing meaningful missing.
5. Run the same for a Reddit feed with a Giphy post and confirm the image block is present.
6. `python3 manage.py convert_articles_to_blocks --dry-run`, then for real; spot-check several
   articles across different aggregators.
7. Use **Re-convert blocks** on one article and confirm the tree is rebuilt identically.
8. Confirm `plain_text` is populated and readable.
9. `ruff check core/ --fix && ruff format core/ && mypy core/ && pytest`.

## Revisiting the embed proxies

Spec 0 deliberately left `youtube_proxy_view` and `dailymotion_proxy_view` in place because the HTML
pipeline still produced proxy-backed embed markup.

Now that embeds are typed `embed` blocks carrying `provider` and `externalURL`, and the client plays
them with its own player, the proxies have no remaining consumer. **Delete both views, their routes
in `core/urls/default.py`, and their exports from `core/views/__init__.py`** — after confirming no
`embed` block's `externalURL` points at a proxy path. Keep `health_check`.

## Out of scope

- The API that serves blocks (new API spec).
- Dropping `Article.content` — a follow-up once blocks are trusted.
- New block kinds (tables, footnotes). Tables are dropped today, deliberately; adding them is a
  format-version bump.
- Server-side rendering of blocks back to HTML. Nothing needs it once GReader is gone.
- FTS5 or any search index over `plain_text` — the column is created here, indexing it is separate.
