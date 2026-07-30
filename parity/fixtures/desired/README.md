# Desired fixtures — the target output format

One file per aggregator, 16 in total. Each holds the **block document the TypeScript aggregator
should produce** for that article, in the Yana content format (wire version 1).

These are a **specification**. They were produced by running the real pipeline against 16 live feeds,
finding the defects that output revealed, **fixing the pipeline**, and re-running. So they are not a
recording of buggy behaviour dressed up by a cleanup script — 12 of the 16 need no post-processing at
all, and the curation rules that remain remove site furniture, not pipeline bugs.

## How to use them

Develop each TypeScript aggregator until its output deep-equals `document.blocks` here.

Two fields are **not** part of the comparison contract:

| Field | Why excluded |
|---|---|
| `images[].contentHash`, and the hash inside `yana-img://<hash>` | Hashes are SHA-256 over *compressed* bytes. Python compresses with Pillow, TypeScript with sharp/libvips, and different encoders emit different bytes for identical input. Compare by position and order, not by hash. |
| `images[].byteSize` | Same reason. A ±25% sanity band is the most that is meaningful. |

`contentType`, `width` and `height` **are** compared exactly — output dimensions come from our own
integer arithmetic, which is portable across encoders.

## Invariants these fixtures encode

Every one of these was a real bug found by generating this corpus, and each is now fixed in the
Python pipeline and covered by tests. The TypeScript port must satisfy them too.

1. **The header image never appears in the body.** It is persisted to `article.icon` and nothing else.
   Embeds and video players inside a `<header>` DO survive — Reddit tweet/YouTube cards and the
   Tagesschau player live only there and have no `icon` counterpart, so suppression is by block
   *kind*, not by dropping the element.
2. **`article.icon` is populated whenever a header image was extracted** — including on re-runs that
   update an existing article, not only on first insert.
3. **Every body image is stored and referenced as `yana-img://<hash>`.** No fixture carries a remote
   `http(s)://` ref. Relative `src` values are resolved against the article URL first.
4. **A stray `<body>` element must not void the document.** A sanitized fragment can contain one
   (TorrentFreak emits `<p><body></body></p>` mid-table); selecting it as the container silently
   discarded whole articles.
5. **Table content is preserved.** There is no table block kind, so each `<tr>` flattens to one
   paragraph with cells joined by `" — "`, `<th>` cells bold, and images in cells emitted as sibling
   image blocks after the row.
6. **Titles and authors are decoded plain text.** Some feeds double-encode, so a literal `&#8217;`
   survives naive parsing. Text is stored decoded and escaped at the point it becomes markup — never
   the reverse.
7. **Article bodies are not truncated to their first matching container.** Vox's Duet CMS emits one
   body div per paragraph group; taking only the first kept 12% of the article.

## Curation rules still applied

Only 13 removals remain across all 16 fixtures, in 4 of them. Each is recorded per fixture in `curation.removed`
with the rule that fired and the removed text, so nothing is deleted silently.

| Rule | Removes | Why it is not a pipeline fix |
|---|---|---|
| **R2** | A heading or leading paragraph repeating the article title | The title is carried by `article.name`. Affects `full_website` and `feed_content`, both generic aggregators with no site-specific selectors to hang a fix on. |
| **R3** | Bylines (`today by X`), breadcrumbs (`Home > …`), tag footers (`Tags: a, b, c`), share/subscribe prompts | Site furniture. Same reason: the generic aggregators cannot carry per-site removal selectors. |
| **R7** | A trailing lone paragraph after a single image, folded into that image's `caption` | Content is preserved, moved to the semantically correct slot. Applies to comics. |
| **R8** | Leading/trailing whitespace on outer inline runs; blocks left with no text | Only outer edges, so bold/link run boundaries survive. |
| **sponsored** | Paid/partner boxes, matched on content (`Content-Partnerschaft`, …) | Content-matched, not index-matched — see the warning below. |
| **inline-related** | A mid-article `Related` heading and its link list | Distinguished from a real tail by position. |
| **tail** | A related/promo marker in the last 30% of the body, and everything after it | Only fires near the end. |

### A warning to anyone editing these rules

Three separate bugs in this tool silently deleted **real article content** before being caught:

- **Index-based ranges are unsafe.** Re-collecting changes which article is sampled, so a stale range
  deletes whatever now sits at those positions. One removed two genuine paragraphs from a merkur
  article about Crete. All removals are now matched by content, so a rule either fires on the thing it
  names or does nothing.
- **"Related" does not always mean "tail".** The Verge puts a `Related` box mid-article and then
  continues; treating it as a tail deleted three real paragraphs. Hence `TAIL_MIN_POSITION = 0.70`.
- **Some chrome is a feature.** A pattern removing `Duration: … | Download Episode` was deleting
  `PodcastAggregator`'s `include_download_link` output, which defaults to on. Check whether a
  suspicious line is generated by our own code before removing it.

Prefer fixing the aggregator over adding a rule here. A rule is right only when the aggregator has no
way to know better — which in practice means the generic `full_website` and `feed_content` paths.

## Coverage

Block kinds exercised: `paragraph`, `heading`, `list`, `blockquote`, `image`, `embed`.

**Not covered: `code_block` and `divider`** — no article in the sampled corpus produces either. Adding
a developer-blog feed whose posts contain `<pre><code>` would close the `code_block` gap. `list_item`
is absent correctly: it is storage-only and never appears in the wire format.

The article chosen per feed is the one exercising the most distinct block kinds, not the newest —
these are a teaching corpus, so breadth beats recency. Empty articles and oversized outliers are
excluded by rule (heise runs a recurring product-comparison listicle that yields ~9,600 blocks and
~2,300 images for a single article).

## Regenerating

```bash
# 1. collect against live feeds, then export one article per feed
uv run python parity/tools/curate_fixtures.py   # reads exports/, writes this directory
```

Never hand-edit a fixture — the rules and the output would drift apart. Change the rules in
`parity/tools/curate_fixtures.py` and re-run.
