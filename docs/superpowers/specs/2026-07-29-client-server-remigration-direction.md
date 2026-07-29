# Direction: Re-migrating Yana to Client/Server

**Date:** 2026-07-29
**Status:** Direction record — not a build spec
**Scope:** Why we are moving back to client/server, what the end state is, and which specs get us there.

## Background

Yana began as this Django server with a Google Reader–compatible API. The iOS/macOS app
(`fa-krug/yana`, checked out at `../yana-ios`) was created *from* this project as a **standalone**
version: it reimplemented the aggregation pipeline in Swift, stored articles in SwiftData, and
synced between a user's own devices via CloudKit. No server required.

Since the fork, the two codebases have diverged in both directions. Server → iOS syncing has been
done deliberately and is documented in `../yana-ios/docs/plans/port-server-aggregator-updates.md`
(server commits up to `4a17759`). The reverse direction — iOS → server — **has never happened**.
The iOS app has since accumulated 180 commits touching `Yana/Aggregators/` alone, including new
sources, extraction improvements, and scraper fixes the server does not have.

## Decision

**Aggregation returns to the server, exclusively.**

The server becomes the single place where content is fetched, extracted, converted, and stored.
The iOS/macOS app becomes a client that reads what the server produces. `Yana/Aggregators/` on iOS
is slated for deletion once the server is authoritative.

Rationale: every scraper fix currently has to be written twice, in two languages, and in practice
only ever gets written once — which is why the server is behind on six scraper fixes and two whole
sources. One implementation means a broken selector is fixed in one place.

Consequences accepted:

- The app requires a server to function. Standalone mode goes away.
- CloudKit device-to-device sync is replaced by server sync.
- Per-user API credentials (Reddit, YouTube, AI providers) move server-side.

## End state

```
┌────────────────────────── server (authoritative) ──────────────────────────┐
│  aggregators → HTML (internal) → BlockParser → ArticleBlock rows           │
│                                → images → content-addressed ArticleImage    │
│  new tailored API ──────────────────────────────────────────────────────────┤
└─────────────────────────────────────┬───────────────────────────────────────┘
                                      │
                        ┌─────────────▼─────────────┐
                        │  iOS / macOS client       │
                        │  renders [Block] natively │
                        │  caches images locally    │
                        └───────────────────────────┘
```

- **Content format.** The server stores the *Yana content format* — the same typed block model the
  iOS reader renders (`../yana-ios/Yana/Reader/Block.swift`). Article bodies are block trees, not
  HTML. HTML remains internal pipeline state between extraction and block conversion.
- **Images.** The server hosts images, content-addressed by hash, and serves them via the API. The
  client downloads and stores them locally, as it already does. No more base64 data URIs inlined
  into article content.
- **API.** The Google Reader API is **removed** and replaced by a self-tailored API. This branch
  does not ship with GReader in it.

## Why the GReader API goes away

It exists to serve third-party RSS readers (Reeder, NetNewsWire, FeedMe). Once the first-party
client is the only consumer, the compatibility surface is pure cost: it constrains the article model
to what GReader can express, forces HTML bodies, forces images to be fetchable by a plain `<img>`
tag with no auth header, and imposes offset-based pagination that cannot support reliable
incremental sync.

Removing it unlocks several things at once — block bodies, authenticated image endpoints, and a
proper monotonic sync cursor.

## Guiding principle for this phase

**Collect and store the data correctly. Verify through Django admin.**

This phase is about the pipeline and the data model, not about serving anyone. There is no client
consuming the server until the new API exists, so admin *is* the verification surface: every new
structure this route introduces must be legible in admin, and `test_aggregator` remains the
per-feed debugging tool. Specs 4 and 5 therefore each carry an explicit admin requirement — block
trees and hosted images have to be inspectable by eye, not only by test assertion.

A consequence worth stating plainly: after Spec 0 and until the new API lands, **the server has no
HTTP API at all** — only admin and the management commands. That is intentional, not a gap.

## Route

```
Spec 0 (remove GReader) ─→ Spec 1 ─→ Spec 2 ─→ Spec 4 (images) ─→ Spec 5 (content format)
                            │                                             │
                            └── Spec 3 ──── parallel ────┘                 ▼
                                                                    [new API] ─→ ship
```

| Spec | Title | Depends on |
|---|---|---|
| 0 | `…-remove-greader-api-design.md` | — |
| 1 | `…-aggregator-parity-1-extraction-core-design.md` | 0 |
| 2 | `…-aggregator-parity-2-scrapers-and-types-design.md` | 1 |
| 3 | `…-aggregator-parity-3-feed-authoring-design.md` | 0 (then parallel; its AI-selector item also needs 1) |
| 4 | `…-image-hosting-design.md` | 2 |
| 5 | `…-yana-content-format-design.md` | 4 |
| — | **new tailored API** — not yet specced | 5 |

Specs 1–3 bring the server to feature parity with iOS. That is a hard prerequisite: aggregation
cannot move server-side while the server produces worse articles than the client it would replace.

### Ordering rationale

- **GReader removal first** (0): pure deletion, and it removes constraints that would otherwise
  complicate three later specs — Spec 1 would have had to keep `stream_format.py`'s timestamps
  coherent, Spec 4 would have had to serve images to unauthenticated `<img>` tags, and Spec 5 would
  have had to preserve HTML bodies as a wire contract. Deleting it first makes all three simpler.
  Doing it *last* would mean building compatibility shims and then throwing them away.
- **Extraction before scrapers** (1 → 2): the selector and extraction changes are shared base code
  every aggregator inherits. Landing them first means the scraper fixes are written once against
  the final extraction behavior.
- **Scrapers before images** (2 → 4): removing base64 touches the same aggregator call sites as the
  scraper fixes. Sequencing avoids conflicting edits to the same five aggregators.
- **Images before content format** (4 → 5): `ArticleBlock.image_ref` has no meaning until the image
  hosting contract exists.
- **Feed authoring in parallel** (3): touches feed configuration and identifier resolution, not the
  article pipeline. No overlap with 1, 2, 4, or 5.

## The new API — required next brainstorm

Shipping is gated on this, and it is deliberately **not** specced yet. It needs its own session
rather than an appendix here. Open questions to resolve there:

- Endpoint surface and resource shapes (feeds, groups, articles, blocks, images, settings).
- Authentication and per-device session model.
- **Incremental sync**: cursor design, and what a client sends to catch up after being offline.
  Spec 1 establishes `Article.created_at` as the monotonic ordering key this will build on.
- Read/starred state reconciliation, including conflicts between two devices.
- Deletion and retention propagation (tombstones vs. full resync).
- Image download and cache-invalidation protocol.
- Migration of each existing iOS install's SwiftData store onto the server, and what happens to
  articles that exist only on-device.
- Whether CloudKit is removed outright or kept transitionally.

## Deferred, with rationale

Not in scope for this route. Recorded so they are not mistaken for oversights.

| Item | Why deferred |
|---|---|
| HTTP response size caps | iOS streams under 25 MB (HTML) / 64 MB (image) caps; server `html_fetcher` has **no limit**, so one hostile or broken response can exhaust memory. Explicitly deferred — a known robustness gap, not an accident. |
| Retention cleanup | iOS deletes articles past a retention window, exempting starred. Server keeps articles forever. Needed once the server is the store of record for all clients, but it deletes user data and wants its own design (configurable window, dry-run). |
| Flat run limit | iOS uses `dailyLimit − collectedToday`; the server's adaptive time-of-day quota is retained deliberately. Drip-feed pacing is more appropriate for a always-on server than for an app that syncs in bursts. |
| AI provider expansion | iOS supports 7 providers (adds Mistral, Qwen, DeepSeek, Apple Intelligence) and maintains current model lists, noting the server's are stale. Server supports 3. This is the AI layer, cleanly separable from aggregation. |
| AI options shape | Server uses flat `ai_summarize` / `ai_improve_writing` / `ai_translate` / `ai_translate_language` keys; iOS nests them under `ai`. Harmonize when the API spec pins the options contract. |
| Deleting iOS `Yana/Aggregators/` | Happens after the new API ships and the server is proven authoritative. Premature deletion would leave no fallback mid-migration. |

## Not portable to the server

Client concerns that stay client-side, listed so nobody tries to port them:

`BlockParser`'s SwiftUI rendering (`ArticleBlockView`), CloudKit machinery (`ImageSync`,
`StoredImage`, `LibraryDedup`, `NativeCloudKitMigration`), `AggregationWriter`'s `@ModelActor`
write pipeline, `StarredRegistry`, `ArticleSearch` (the server has a database), and the local
`ImageStore` (which becomes the client-side cache for server-hosted images).

Note that `BlockParser` itself — the HTML → `[Block]` conversion — **is** ported (Spec 5). Only its
rendering half is client-only.

## Repository note

`fa-krug/Yana` is the **iOS/macOS client**; `fa-krug/yana-server` is this project. GitHub's
case-insensitive redirect resolves `Yana` → `yana`, which has already caused one misconfigured
`origin` remote here and a stale path reference in
`../yana-ios/docs/plans/port-server-aggregator-updates.md` (it points at a non-existent
`/Users/skrug/PycharmProjects/Yana`). Always write `yana-server` when you mean this repo.
