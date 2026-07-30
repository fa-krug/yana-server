# Phase 11a: Extraction Core & Image Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Structural. Task boundaries, interfaces and the verification contract are settled; per-file step lists must be refreshed against the Python immediately before execution, because the port is a line-by-line reading exercise and this document cannot substitute for the source.

**Goal:** Port the shared extraction foundation every aggregator inherits — the pipeline skeleton, HTTP fetching, content extraction, HTML cleaning, HTML→block conversion, and the image extract/compress/store chain — and prove it against phase 0's goldens.

**Architecture:** Straight port, module for module, from `core/aggregators/` to `src/lib/aggregators/`. The Python's Template Method pipeline becomes an abstract base class with the same six hooks, so phase 11c's scrapers override the same seams they override today. The comparison half of phase 0's normalization contract is implemented here in TypeScript.

**Tech Stack:** cheerio (htmlparser2 backend), sharp, undici/fetch, Vitest.

## Global Constraints

- **cheerio must use its default `htmlparser2` backend, never parse5.** Every Python parse site is `BeautifulSoup(html, "html.parser")` — the stdlib parser, not HTML5-spec-compliant. `htmlparser2` is lenient in the same way; parse5's spec compliance would diverge *further* on the malformed markup scraping actually encounters. Passing `xmlMode` or a parse5 option is a defect.
- Ported behaviour is defined by **the Python source, not this document**. Where they disagree, the Python wins and this document is wrong.
- Response caps port exactly: `fetch_html` at **8 MB**, `fetch_binary` at **2 MB**, both rejecting an oversized `Content-Length` before reading a byte and streaming otherwise.
- `fetch_single_image` currently reads unbounded and is the highest-volume path. A cap is added here, and it must be **generous** — iOS deliberately raised its own to 64 MB for large Reddit GIFs, so a tighter cap silently drops content that works today.
- The adaptive time-of-day quota takes an **injectable clock**. `core/aggregators/base.py:210` branches on `now.hour < 10`; a port reading the system clock directly is untestable.
- Image content hashes are SHA-256 over the **compressed** bytes, matching Python's rule. The hashes will differ from Python's and that is expected — phase 0's contract excludes them from comparison.
- Every module lands with its golden cases passing before the next begins. A "port everything then debug" approach makes a single divergence indistinguishable from thirty.

---

## File Structure

| Path | Ports from |
|---|---|
| `src/lib/aggregators/base.ts` | `core/aggregators/base.py` (624 LOC) |
| `src/lib/aggregators/http/fetcher.ts` | `utils/html_fetcher.py` (188) |
| `src/lib/aggregators/extract/content.ts` | `utils/content_extractor.py` (161) |
| `src/lib/aggregators/extract/clean.ts` | `utils/html_cleaner.py` (277) |
| `src/lib/aggregators/extract/format.ts` | `utils/content_formatter.py` (140) |
| `src/lib/aggregators/blocks/parser.ts` | `utils/block_parser.py` (668) |
| `src/lib/aggregators/blocks/types.ts` | `core/blocks/types.py` |
| `src/lib/aggregators/blocks/schema.ts` | `core/blocks/schema.py` |
| `src/lib/aggregators/blocks/storage.ts` | `core/blocks/storage.py` |
| `src/lib/aggregators/images/extractor.ts` | `services/image_extraction/extractor.py` (184) |
| `src/lib/aggregators/images/strategies.ts` | `services/image_extraction/strategies.py` (359) |
| `src/lib/aggregators/images/fetcher.ts` | `services/image_extraction/fetcher.py` (185) |
| `src/lib/aggregators/images/compression.ts` | `services/image_extraction/compression.py` (163) |
| `src/lib/aggregators/images/store.ts` | `services/image_store.py` (247) |
| `src/lib/aggregators/header/extractor.ts` | `services/header_element/*` (382) |
| `src/lib/aggregators/rss.ts` | `rss.py` + `utils/rss_parser.py` |
| `src/lib/aggregators/website.ts` | `website.py` (242) |
| `src/lib/parity/normalize.ts` | `parity/normalize.py` — the TypeScript half |
| `src/lib/parity/compare.ts` | New: golden assertion helper |

---

### Task 1: The block format — types, wire schema, storage

Ported first because everything downstream produces it, and because it is the one module with an existing byte-exact contract: `core/tests/fixtures/blocks_golden_v1.json` is the fixture the iOS client tests against too.

**Interfaces:**
- Produces: the `Block` discriminated union (`Paragraph`, `Heading`, `ListBlock`, `Blockquote`, `ImageBlock`, `EmbedBlock`, `CodeBlock`, `Divider`), `InlineRun`, `encodeDocument(blocks): WireDocument`, `decodeDocument(payload): Block[]`, `writeBlocks(articleId, blocks)`, `readBlocks(articleId)`.

- [ ] Read `core/blocks/types.py` and `core/blocks/schema.py` in full. The wire encoding is explicit for a reason — every block carries a `type` discriminator, `styles` is a string array in `STYLE_NAMES` order, optional strings are `null` on the wire and `""` in memory.
- [ ] Port the types, keeping `""`-means-absent in memory and `null` on the wire. Do not "improve" this to `undefined`: the asymmetry is the contract.
- [ ] Port `encodeDocument`/`decodeDocument`, preserving both extensibility rules — **an unknown block `type` is skipped, never fatal; an unknown style name is ignored, never fatal.** These are load-bearing on both sides of the wire.
- [ ] Copy `core/tests/fixtures/blocks_golden_v1.json` into the TypeScript test fixtures and assert `encodeDocument(decodeDocument(golden)) === golden`. This is a round-trip identity test against the same file iOS uses.
- [ ] Port `storage.ts`, including the root-position uniqueness the database cannot enforce (phase 2's `uniq_block_position` does not cover `parentId IS NULL`, because SQLite treats NULLs as distinct). Write `list_item` rows for list children — the synthetic kind that encodes `[[Block]]` as rows.
- [ ] Test: writing then reading a tree containing nested lists and a blockquote-wrapping-a-list returns an identical structure.

---

### Task 2: The parity comparison harness

Built before the porting work so every subsequent task has a pass/fail signal from its first line.

**Interfaces:**
- Produces:
  - `normalizeDocument(document, hashToUrl): { document, images }` — the TypeScript half of phase 0's contract
  - `compareToGolden(caseId, actual): { ok: boolean; diff?: string }`
  - `loadCases(): Case[]` — reads `parity/cases.json`

- [ ] Implement `normalizeDocument` to phase 0's stated algorithm **exactly**: depth-first pre-order walk; `list.items` outer-then-inner then `blockquote.blocks` in order; inspect `ref` on `image` and `thumbnailRef` on `embed`; only values starting `yana-img://` are candidates; keys assigned in first-encounter order from `img:0`; the same hash always reuses its key; non-matching values untouched.
- [ ] Port phase 0's normalization tests to Vitest verbatim — the five cases in `core/tests/test_parity_normalize.py`. Both languages passing the same cases is what makes the contract real rather than aspirational.
- [ ] Implement `compareToGolden` asserting per phase 0's table: block tree deep-equal after normalization; `plainText`, title, identifier, author, date exact; image `contentType` and `width`/`height` exact; `byteSize` within **±25%**; `contentHash` not compared at all.
- [ ] On mismatch, produce a **readable** diff — the first differing path and both values, not a dumped pair of documents. This harness is the primary debugging tool for the rest of phase 11, and a bad diff makes every failure expensive.

---

### Task 3: HTTP fetching

**Interfaces:** `fetchHtml(url, options?): Promise<string>`, `fetchBinary(url, options?): Promise<Buffer>`, `NetworkError`, `ResponseTooLarge`.

- [ ] Read `utils/html_fetcher.py`. Record the retry count, backoff, timeout, user-agent, and redirect policy — all four are behaviour the goldens cannot check, since fixtures never hit the network.
- [ ] Port with the caps enforced twice: reject an oversized `Content-Length` before reading, and abort mid-stream if the actual body exceeds the cap. A server may lie or omit the header.
- [ ] Port the retry policy exactly, including which status codes retry and which fail immediately. Retrying a 404 wastes time; not retrying a 503 loses articles.
- [ ] Tests with a stubbed `fetch`: retries on the retryable statuses, gives up after the ported limit, rejects on an oversized declared length without reading, aborts mid-stream on a lying header, and honours the timeout.

---

### Task 4: Content extraction, cleaning and formatting

The first place parser divergence will bite. Expect a tail of fixes here rather than a clean first pass.

**Interfaces:** `extractContent(html, selectors, options)`, `cleanHtml(html, options)`, `formatContent(html)`.

- [ ] Read all three Python modules in full before writing anything. `html_cleaner.py` in particular encodes many small decisions about which tags and attributes survive.
- [ ] Port `extractContent`, preserving `uses_first_content_match` semantics — whether the body is taken from one known container or accumulated across matches. Getting this backwards produces plausible-looking output with duplicated or missing sections.
- [ ] Port `cleanHtml` decision by decision. Where Python relies on `html.parser` behaviour for malformed input, add a fixture for that input rather than assuming cheerio agrees.
- [ ] Port `formatContent`.
- [ ] Run the goldens for the simplest cases first — `oglaf/basic` (3.8 KB), then `dark_legacy`, `explosm`. Small fixtures make a divergence legible.
- [ ] For each divergence: determine whether it is a **port bug** or a **parser difference**. A port bug is fixed. A genuine parser difference is fixed by matching Python's observable output, with a comment naming the divergence — never by regenerating the golden, which would silently redefine correct.

---

### Task 5: HTML → blocks

The largest single module (668 LOC) and the one whose output the goldens check most directly.

**Interfaces:** `parseBlocks(html, context): Block[]`, `plainTextOf(blocks): string`.

- [ ] Read `utils/block_parser.py` in full, including the legacy `/api/youtube-proxy` and `/api/dailymotion-proxy` URL recognition. Those patterns exist solely to read legacy `Article.content` written before the proxy endpoints were removed. **This port does not need them** — phase 2 never creates `Article.content`, so there is no legacy content to read. Omit them and note the omission.
- [ ] Port structural handling first — paragraphs, headings, lists, blockquotes, dividers, code blocks — and get those golden cases passing before touching images or embeds.
- [ ] Port inline-run extraction, including how nested styling collapses into flat runs and how whitespace is normalized. Whitespace is where a port most often differs invisibly until a golden catches it.
- [ ] Port `plainTextOf`, matching Python's flattening exactly — `plainText` is compared exactly by the golden contract.
- [ ] Leave `image` and `embed` block emission as declared stubs that Task 6 and phase 11b fill. Attempting all three at once makes failures ambiguous.

---

### Task 6: The image pipeline

**Interfaces:** `extractImages(html, context)`, `fetchImage(url)`, `compressImage(buffer, options)`, `storeImage(buffer, contentType)`, `refFor(hash)`.

- [ ] Read the four Python modules. `compression.py` is the important one: it picks WEBP/PNG/JPEG by source type and transparency, resizes with high-quality resampling, and encodes at fixed quality settings.
- [ ] Port `compressImage` to sharp, matching Python's **decisions** — chosen output format, target dimensions, whether transparency is preserved — while accepting that the bytes differ. Format choice and dimensions are compared exactly by the goldens; bytes are not.
- [ ] Port `storeImage`: SHA-256 over the **compressed** bytes, insert-or-reuse on `articleImages.contentHash`, write under `media/article_images/<yyyy>/<mm>/`, return `yana-img://<hash>`.
- [ ] Add a cap to `fetchImage`, generous enough not to drop large Reddit GIFs. Record the chosen value and its reasoning in the commit message — this is the one deliberate behaviour change in the phase.
- [ ] Port `extractImages` and its strategies (359 LOC — the largest strategy set, covering `srcset`, lazy-loading attributes, and per-domain overrides).
- [ ] Wire image blocks into Task 5's parser, then run every golden case with images. Expect `contentType`, `width` and `height` to match exactly and `byteSize` to land inside the band; a `byteSize` far outside it means a different resize or quality decision, not merely a different encoder.

---

### Task 7: Header element extraction

**Interfaces:** `extractHeaderElement(html, context): Promise<{ imageRef: string } | null>`

- [ ] Port `services/header_element/` (382 LOC across extractor, strategies and file handler). This is what writes `articles.icon`.
- [ ] Note that current Python tests patch this away entirely, so the goldens phase 0 generated **do** exercise it while the Python unit tests did not. Treat golden failures here as real findings rather than harness noise.

---

### Task 8: The pipeline base class and the two generic aggregators

**Interfaces:**
- `abstract class BaseAggregator` with the six hooks — `validate()`, `fetchSourceData()`, `parseToRawArticles()`, `filterArticles()`, `enrichArticles()`, `finalizeArticles()` — plus `getCurrentRunLimit(clock)`.
- `class RssAggregator extends BaseAggregator`, `class FullWebsiteAggregator extends RssAggregator`.

- [ ] Port `base.py`, keeping the hook names and call order identical so phase 11c's overrides map one-to-one.
- [ ] Port the adaptive quota with the clock injected. Test the `hour < 10` branch and its complement by passing a fixed clock, which is impossible if the port reads `new Date()` directly.
- [ ] Choose the feed-parser library **by golden pass rate**: run `rss/basic`, `podcast/basic` and `full_website/basic` against each candidate and pick the one that passes. `feedparser` is extremely lenient and reputation is not evidence here. Record the comparison in the commit message.
- [ ] Port `rss.ts` and `website.ts`, including `uses_first_content_match`.
- [ ] Run the whole golden corpus. Cases belonging to phase 11b (embeds) and 11c (scrapers) will still fail — that is expected. Every `rss`, `podcast`, `full_website` and structural case must pass.

---

### Task 9: Gate the corpus in CI

- [ ] Add a Vitest suite iterating `loadCases()`, skipping cases whose aggregator is not yet ported, and asserting `compareToGolden` for the rest.
- [ ] Maintain the skip list as an **explicit array with a comment per entry** naming the phase that will unskip it. An implicit skip is indistinguishable from a silently passing no-op.
- [ ] Add the suite to `ci-next.yml` as its own step, mirroring how phase 0 gated the Python side.
- [ ] Assert the skip list **shrinks** — a test that fails if a case is skipped whose aggregator has a registered implementation. Otherwise a case can be skipped forever and the corpus quietly stops meaning anything.

---

## Self-Review

**Spec coverage.** Against the direction record's 11a scope: `base.py`, `html_fetcher`, `content_extractor`, `html_cleaner`, `block_parser`, and the image extract/compress/store chain — Tasks 1, 3, 4, 5, 6, 8. The TypeScript half of the normalization contract, deferred from phase 0 — Task 2. The ±25% byte-size band, also deferred from phase 0 — Task 2. Header extraction, which the file inventory includes — Task 7.

**Placeholder scan.** This plan is deliberately structural, as the direction record's planning decision allows for later phases. It contains no code, because a port's correctness lives in the source it is ported from and inventing plausible TypeScript here would produce something an engineer would trust over the Python. What it does pin exactly: task order and why, every interface signature, the parser-backend decision and its reasoning, the comparison contract, the injectable clock, the legacy-proxy omission, and the rule that a divergence is fixed by matching Python rather than by regenerating a golden.

**Type consistency.** `Block` and `InlineRun` from Task 1 flow to Tasks 5–6 and phases 11b–11c. `normalizeDocument`'s signature matches phase 0's `normalize_document` argument-for-argument. `BaseAggregator`'s six hooks match `base.py`'s method names exactly, which is what makes phase 11c a set of overrides rather than a rewrite.

**Two known risks.**

1. **Task 4 and Task 5 carry the parser-divergence tail.** The mitigation is ordering — smallest fixtures first — and the rule that goldens are never regenerated to make a failure disappear. If a case cannot be made to match, it must be escalated rather than skipped, because the same divergence will affect every scraper in 11c.
2. **Task 8's feed-parser choice is unresolved by design.** It is decided empirically against the goldens. If no candidate passes, the fallback is porting the leniency behaviour explicitly on top of a stricter parser — more work, and worth knowing early, which is why it is Task 8 rather than a late discovery in 11c.
