# Phase 13: The Yana Client API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> ## ⚠ This plan is intentionally incomplete
>
> **Do not execute it as written.** This phase needs its own brainstorming session before it can be planned properly, and this document exists to record *why* and to carry the open questions forward — not to be worked through.
>
> The prior direction record, [2026-07-29-client-server-remigration-direction.md](../specs/2026-07-29-client-server-remigration-direction.md), already states the client API "needs its own session rather than an appendix here" and lists eight unresolved questions. None have been answered since, and this migration adds a ninth. Every one of them changes the endpoint shapes, so writing task-level detail now would produce work that gets thrown away.
>
> **Required before execution:** run `superpowers:brainstorming` on the client API, resolve the questions below, write a design spec, then rewrite this plan.

**Goal (as far as it is settled):** A tailored HTTP API serving the first-party iOS/macOS client — feeds, tags, articles as block trees, images, settings — with authenticated per-device sessions and reliable incremental sync.

## What is already decided

These come from the prior direction record and this migration's pinned decisions, and are not open:

- The Google Reader API is **not** coming back. It constrained the article model to what GReader could express, forced HTML bodies, forced unauthenticated image fetches, and imposed offset pagination that cannot support reliable incremental sync.
- Article bodies go over the wire as **block trees in the version 1 wire format** (`src/lib/aggregators/blocks/schema.ts`, ported in 11a), pinned by `blocks_golden_v1.json` — the same fixture the iOS client tests against.
- Images are **content-addressed** and served by hash. The client caches locally, as it already does.
- `articles.createdAt`, indexed with `id` as tie-breaker (phase 2), is the **monotonic ordering key** any cursor design builds on.
- The API is **multi-tenant**: every response is scoped to the authenticated user.
- Embeds are typed `embed` blocks carrying canonical public URLs, never proxied ones.

## Open questions

The eight carried from the prior direction record:

1. **Endpoint surface and resource shapes** — feeds, groups, articles, blocks, images, settings.
2. **Authentication and the per-device session model.** Phase 4 chose Better Auth with cookie sessions for the *web* UI. Whether a native client uses the same cookie sessions, bearer tokens, or a separate device-credential flow is unresolved — and it determines whether phase 4's configuration needs extending.
3. **Incremental sync** — cursor design, and what a client sends to catch up after being offline.
4. **Read/starred reconciliation**, including conflicts between two devices. Phase 2 put `read`/`starred` on the article row with no per-device state, which is sufficient for last-write-wins and insufficient for anything better.
5. **Deletion and retention propagation** — tombstones versus full resync. Phase 12's retention deletes rows outright, leaving no record for a client to learn from. If tombstones are needed, that is a **schema change**, and it is the highest-impact open question here.
6. **Image download and cache-invalidation protocol.** Content-addressing makes invalidation trivial for image *bytes*; what is unresolved is how a client learns an article's image set changed.
7. **Migrating each existing iOS install's SwiftData store** onto the server, and what happens to articles that exist only on-device.
8. **Whether CloudKit is removed outright or kept transitionally.**

And the ninth, added by this migration:

9. **A feed's tags are now an array, not a single group.** The tenancy decision made tags many-per-feed (phase 2), so any resource shape the iOS client already expects for grouping is wrong. This also interacts with question 7: an existing install's local groups must map onto server tags somehow.

## Structural shape

Recorded only so the dependency direction is clear. Every detail is subject to the brainstorm.

| Path | Responsibility |
|---|---|
| `src/app/api/v1/**/route.ts` | The endpoints |
| `src/lib/api/auth.ts` | Client authentication, per question 2 |
| `src/lib/api/serializers.ts` | Row → wire shapes |
| `src/lib/api/sync.ts` | Cursor encode/decode, per question 3 |

The block encoder already exists and must be **reused, not reimplemented** — `blocks_golden_v1.json` is a cross-language contract, and a second encoder is a second thing to keep in sync with iOS.

## Why this is not planned yet

Three of the open questions can force changes *outside* this phase:

- Question 5 (tombstones) is a schema change, touching phase 2.
- Question 2 (device sessions) may extend phase 4's auth configuration.
- Question 4 (per-device read state) would add a table phase 2 deliberately omitted, since multi-tenancy made a per-user join table unnecessary.

Planning tasks against unresolved versions of those three would produce a plan whose foundations move. The honest artifact is this record.

## Self-Review

**Spec coverage.** Bullet 13 is acknowledged and scoped, not implemented. The direction record explicitly marks this phase structural-only, so an incomplete plan here is the specified outcome rather than an omission.

**Placeholder scan.** This document is deliberately without task-level content, and says so at the top in terms that cannot be mistaken for an oversight. Everything that *is* settled is stated as settled; everything open is stated as open, with its blast radius named.

**One sequencing consequence.** Phase 14 (folder swap) and phase 15 (npm package) depend on phase 13 in the route diagram — but only in the sense that shipping a client-less server is pointless, not because they touch API code. If the client API brainstorm takes time, **14 and 15 can proceed first**. Nothing in either depends on the endpoints existing. Worth knowing, because the alternative is blocking two small, well-understood phases behind one large unresolved one.
