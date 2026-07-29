# Spec 4: Image Hosting

**Date:** 2026-07-29
**Status:** Approved design, pending spec review
**Depends on:** Spec 2 (shares the same aggregator call sites)
**Direction:** `2026-07-29-client-server-remigration-direction.md`

## Goal

Stop converting images to base64 data URIs. Store them as files, content-addressed by hash, and
reference them by hash from article content. The client will download and cache them locally, as it
already does.

This spec establishes the **storage and reference contract**. Actually serving the bytes over HTTP is
the new API's job; this spec defines what that endpoint will serve and gives admin enough to verify
the data is right.

## Why

base64 data URIs exist because RSS readers needed self-contained article HTML — an image had to
render with no extra request and no auth. That constraint dies with the GReader API (Spec 0).

What it costs today:

- **~33% size inflation** on every image, inlined into `Article.content`, in the database.
- **No deduplication.** The same image across ten articles is stored ten times, ten times inflated.
- **Bodies that can't be block-converted cleanly** — Spec 5 needs an image *reference*, not a
  megabyte of base64 in the middle of the document tree.
- **No way to prune.** Nothing can find or delete an unused image because images aren't entities.

## Current state

`HeaderElementData.base64_data_uri` ([header_element/context.py:25](../../../core/aggregators/services/header_element/context.py:25))
is consumed in five aggregators:

| File | Line |
|---|---|
| `website.py` | 156 |
| `mein_mmo/aggregator.py` | 165 |
| `mactechnews/aggregator.py` | 186 |
| `reddit/aggregator.py` | 545, 606 |
| `heise/aggregator.py` | 205 |

Each does `header_data.base64_data_uri or header_data.image_url`. Plus `oglaf/aggregator.py` has its
own `convert_to_base64` option and inline encoding (lines 47, 84, 107–114), and
`services/config.py:63` has an `ENABLE_BASE64_ENCODING` flag.

## The model

Mirrors iOS's `StoredImage` (`contentHash`, `data`, `ext`, `createdAt`):

```python
class ArticleImage(models.Model):
    content_hash = models.CharField(max_length=64, unique=True, db_index=True)  # SHA-256 hex
    file         = models.FileField(upload_to="article_images/%Y/%m/")
    content_type = models.CharField(max_length=100)
    width        = models.PositiveIntegerField(null=True, blank=True)
    height       = models.PositiveIntegerField(null=True, blank=True)
    byte_size    = models.PositiveIntegerField()
    created_at   = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["-created_at"])]

    def __str__(self):
        return f"{self.content_hash[:12]} ({self.content_type}, {self.byte_size} B)"
```

**The hash is of the compressed bytes, not the original.** Compression must therefore be
deterministic for content-addressing to deduplicate — same input, same Pillow settings, same output.
Hashing the original instead would mean re-compressing on every encounter and storing duplicates
whenever compression settings changed. Worth an explicit test.

`upload_to` is date-sharded to keep directory sizes sane; the hash alone would put every image in one
directory.

### Storage flow

```
remote URL → fetch (existing image_extraction) → compress (existing compression.py)
          → sha256(compressed bytes) → get_or_create(content_hash=…)
          → return hash
```

`get_or_create` on `content_hash` gives free deduplication: the second article using an image finds
the existing row and stores nothing new. The unique constraint makes the race safe — two concurrent
runs hashing the same image collide on the DB constraint rather than writing two rows.

Reuse the existing compression (`services/image_extraction/compression.py`) and its configured limits
in `services/config.py` — 600×600 standard, 1200×1200 header, quality 65, WebP preferred. Those are
unchanged; only the destination changes.

## The reference format

Article content references images by hash, not URL:

```
yana-img://<sha256-hex>
```

This is iOS's existing scheme, and reusing it means the client's resolution path already works. The
client maps the hash to an API request and caches locally.

Storing a hash rather than an absolute URL means content survives the server changing hostname,
scheme, or port — which matters because article bodies are stored once and read for months.

Spec 5 carries this into `ArticleBlock.image_ref`, indexed, which is what makes orphan pruning a JOIN.

## What gets removed

- `HeaderElementData.base64_data_uri` — replaced by a `content_hash` field.
- All five `base64_data_uri or image_url` call sites → store the image, use the hash.
- `oglaf`'s `convert_to_base64` option, its form field, and its inline encoding. Oglaf's images go
  through the same store as everything else. **A data migration must drop the key from existing
  `Feed.options`.**
- `ENABLE_BASE64_ENCODING` in `services/config.py`.
- The `import base64` in `oglaf/aggregator.py`.

Note this reverses an item I originally planned for Spec 1: exposing `convert_to_base64` in oglaf's
config fields. It is already exposed, and it is deleted here instead.

## Backfill

Existing `Article.content` contains inline `data:` URIs. A management command,
`migrate_inline_images`, walks articles:

1. Find `data:image/...;base64,...` URIs in `content`.
2. Decode, hash, `get_or_create` an `ArticleImage`.
3. Replace the data URI with `yana-img://<hash>`.

Requirements:
- **Batched and idempotent** — re-running skips already-converted content. This will run over the
  whole article table; it must be resumable.
- `--dry-run` reporting how many articles and images would be affected, and the byte savings.
- `--limit` for a trial run.
- Decode failures log the article ID and leave that content untouched rather than aborting.

Run inside a transaction per batch, not per table — a partial backfill must be safe to resume.

## Orphan pruning

Content-addressed storage needs a reaper: an `ArticleImage` whose referencing articles are all gone
is dead weight. iOS built exactly this client-side (commit `a58e962`, "Prune orphaned StoredImage rows
and disk blobs").

Add a `prune_orphaned_images` management command:

- Find `ArticleImage` rows referenced by no article content.
- Delete the row and its file.
- `--dry-run` and a `--min-age` guard (default e.g. 7 days) so an image stored moments before its
  article is written isn't collected in a race.

**Efficiency caveat:** until Spec 5, finding references means scanning `Article.content` text for
each hash — acceptable for a periodic maintenance command, not for anything hot. After Spec 5 this
becomes a JOIN against the indexed `ArticleBlock.image_ref`, and the command should be rewritten then.
Note that in the command's docstring so the inefficiency is understood as temporary.

## Serving

Deferred to the new API spec, which owns auth. What this spec fixes is the contract it must satisfy:

- Lookup is **by content hash**, the primary key of the reference format.
- Responses are **immutable and infinitely cacheable** — a hash identifies exactly one byte sequence,
  so `Cache-Control: immutable` with a long max-age is correct and the client never needs to
  revalidate.
- Requests are **authenticated as part of the API**. There is no plain-`<img>` constraint anymore, so
  ordinary bearer-token auth works; no capability-hash or signed-URL scheme is needed.

For this phase, admin serves images via the existing `/media/` route, which is enough to eyeball them.

## Admin — the verification surface

Images are only verifiable if they are visible, so admin registration is part of this spec, not an
afterthought.

- **Register `ArticleImage`** with a list view showing a thumbnail, the short hash, content type,
  dimensions, byte size, and created-at, ordered newest first.
- **Filter by content type** and search by hash prefix.
- **Read-only.** Rows are derived from aggregation; hand-editing a content-addressed row makes the
  hash a lie. Deletion stays available for manual cleanup.
- On the Article change page, show which images the article references, so a missing image is
  traceable to its article.
- Add a **byte-size total** to the changelist (a sum in the admin view or a small report) — that
  number is how the base64 savings become visible.

## Error handling

- **Fetch failure**: no `ArticleImage`, no hash. Callers must handle a `None` hash by omitting the
  image — the article still publishes. This is the same failure shape as Spec 2's A5 Reddit fix, and
  the two must agree: a failed header image means *no header*, not *no article* and not *no body
  image*.
- **Compression failure**: fall back to storing the original bytes rather than dropping the image, and
  log it. A stored-but-large image beats a missing one.
- **Hash collision on different content**: cryptographically implausible for SHA-256; treated as a
  hard error rather than silently overwriting.
- **Missing file, present row**: `ArticleImage` exists but its file is gone from disk (manual
  deletion, failed storage). The serving layer returns 404; add a `verify_image_store` check to the
  pruning command reporting such rows.
- **Oversized image**: the existing size handling applies. Note the server has **no HTTP response
  size cap** (deferred; see the direction doc) — a hostile image response is currently unbounded.
  Flagged, not fixed here.

## Testing

**Model / storage**
- Same bytes stored twice → one `ArticleImage`, same hash returned.
- Different bytes → two rows.
- Hash is over **compressed** output: compressing the same source twice yields an identical hash.
- Concurrent `get_or_create` on one hash → one row (simulate via the unique constraint).
- `byte_size`, `content_type`, `width`, `height` populated correctly.

**Aggregator integration** — for each of the five former base64 call sites, the produced content
contains `yana-img://<hash>` and **no** `data:image` substring. That last assertion is the regression
guard; add it as a shared helper so all five use it.

**Oglaf** — images stored via the shared path; `convert_to_base64` absent from config fields; the
options migration removes the key from existing feeds.

**Backfill command** — converts a data URI to a hash reference; is idempotent across two runs; a
malformed base64 payload is skipped with the article left untouched; `--dry-run` writes nothing;
`--limit` honored.

**Pruning** — an unreferenced image older than `--min-age` is deleted with its file; a referenced one
is kept; one younger than `--min-age` is kept; `--dry-run` deletes nothing; a row whose file is
missing is reported.

## Verification via admin

1. `python3 manage.py migrate`.
2. `python3 manage.py test_aggregator <heise id> --first 1 --verbose` — the content field contains
   `yana-img://…` references and no `data:image` blobs.
3. In admin, the new **Article Images** list shows rows with sensible hash, content type, and byte
   size; each row's file opens via `/media/` and displays the right image.
4. Aggregate a second feed that shares an image (or re-run the same feed) — confirm the image count
   does **not** grow, proving deduplication.
5. `python3 manage.py migrate_inline_images --dry-run` — reports the article/image counts and the
   expected byte savings. Then run it for real and confirm `Article.content` no longer contains
   `data:image`.
6. `python3 manage.py prune_orphaned_images --dry-run` on a fresh DB — reports zero orphans.
7. Check the database size before and after the backfill; it should drop noticeably.
8. `ruff check core/ --fix && ruff format core/ && mypy core/ && pytest`.

## Out of scope

- The HTTP image endpoint and its auth (new API spec).
- Migrating feed logos from Spec 3's `ImageField` into `ArticleImage` — a reasonable follow-up, not a
  dependency.
- Thumbnail or responsive-variant generation.
- External object storage (S3 and friends); `FileField` on local disk matches the current deployment.
- HTTP response size caps — deferred, see the direction doc.
