# Feed identifier field, shaped per aggregator

**Date:** 2026-08-03
**Status:** Approved design, pending spec review

## Goal

Today [feed-form.tsx](../../../src/components/feeds/feed-form.tsx) renders the same plain text
`identifier` input for every one of the 16 aggregators. That's wrong for most of them: the retired
Django implementation (`old/core/aggregators/*/aggregator.py`) encodes a real per-aggregator
taxonomy — some aggregators have no configurable identifier at all, some offer a fixed list of feed
variants, and two (YouTube, Reddit) need a live search against an external API. This spec ports that
taxonomy into the Next.js feed form.

## The four identifier modes

Derived from data already ported into `src/lib/aggregators/sites/*` (each class already has
`getIdentifierChoices()` / `getDefaultIdentifier()`, just not exposed to the client-safe half of the
registry):

| Mode | Meaning | Aggregators |
|---|---|---|
| `none` | One hardcoded feed URL. Nothing to configure. | `explosm`, `dark_legacy`, `caschys_blog`, `mactechnews`, `oglaf`, `mein_mmo`, `the_verge` |
| `url` | Free-form URL, normalized/resolved server-side. | `full_website`, `feed_content`, `podcast` |
| `choice` | A fixed dropdown of named feed variants. | `heise`, `merkur`, `tagesschau`, `ars_technica` |
| `search` | Live autocomplete against an external API. | `youtube`, `reddit` |

The mode is **derived, not declared**, so it can never drift from the data it's derived from:

```ts
function identifierModeFor(spec: AggregatorSpec): "none" | "url" | "choice" | "search" {
  if (spec.identifierSearch) return "search";
  if (spec.identifierChoices.length === 0) return "url";
  if (spec.identifierChoices.length === 1) return "none";
  return "choice";
}
```

## Data model — `src/lib/aggregators/specs.ts`

Add to `AggregatorSpec`:

- `identifierChoices: { value: string; label: string }[]` — copied verbatim from each aggregator's
  `getIdentifierChoices()` (empty for `url`/`search` modes, one entry for `none`, several for
  `choice`). `specs.ts` imports nothing but `zod` (see the comment at the top of the file) and must
  stay that way, so this is a **hand-kept duplicate** of the data already in
  `src/lib/aggregators/sites/*` — same category as the `better-sqlite3` override CLAUDE.md documents
  for a different pair of files. A test (see Testing) pins the two copies against each other so they
  can't drift silently.
- `identifierSearch?: "youtube" | "reddit"` — reuses the same capability-key type as `OptionSpec.requires`.

Export `identifierModeFor()` from this module, so the form and the server actions share one
implementation.

`identifierRequired`/`identifierLabel`/`identifierHelp` are unchanged and still used by the `url` and
`search` modes.

## Form — `src/components/feeds/feed-form.tsx`

The identifier section switches on `identifierModeFor(spec)`:

- **`none`** — render nothing. No label, no input, no help text.
- **`url`** — today's plain `<Input>`, unchanged.
- **`choice`** — a `<Select>` populated from `spec.identifierChoices`, defaulting to the first entry.
- **`search`** — the new `<IdentifierAutocomplete>` (below).

`handleAggregatorChange` additionally resets `identifier` to the new aggregator's default: `""` for
`url`/`search`, `spec.identifierChoices[0]?.value ?? ""` for `none`/`choice`.

**Aggregator picker gating.** The `<Select>` of aggregators excludes any aggregator whose
`identifierSearch` capability (`capabilities.youtube` / `capabilities.reddit`) is currently false —
**except** it always keeps the feed's *own* current aggregator in the list when editing, so an
existing feed never vanishes from its own form. That's the only way this branch is reachable:

- New feed, integration off → aggregator isn't offered. Nothing else to design.
- Existing feed, integration was later turned off → aggregator stays selected, and the identifier
  field renders **disabled**, showing the feed's stored raw identifier, with a banner: *"This feed's
  {youtube|reddit} integration is not configured. You can configure it in
  [Integrations](/integrations)."* — reusing the `missingGuards` banner already in this file for
  AI-gated options, same wording pattern.

## Live search — new pieces

**`src/components/ui/autocomplete.tsx`** — a new shadcn-style primitive wrapping Base UI's
`Autocomplete` (already an installed dependency, alongside `select`/`combobox`), styled to match
`select.tsx`: `render` prop composition, no `asChild`.

**`src/components/feeds/identifier-autocomplete.tsx`** — `{ aggregator: "youtube" | "reddit", value,
onValueChange, disabled }`. Debounces input (300ms), searches only once the query is 2+ characters,
shows loading/empty states, and on selection displays the result's label while storing its `value` as
the identifier. When editing an existing feed, the input starts showing the feed's raw stored
identifier as plain text (no reverse lookup to a friendly label — consistent with every other
identifier mode, which all show the raw stored value on load).

**`src/lib/aggregators/search.ts`** (new, server-only, `"use server"`) —
`searchFeedIdentifier(aggregator: AggregatorKey, query: string)`. Guards: aggregator must be
`youtube`/`reddit`; that integration must be enabled (`getSettings()`), else a translated
`errorKey`; query under 2 characters returns `{ ok: true, results: [] }` without a call. Never
throws — same contract as the existing integration probes, and reuses their `PROBE_TIMEOUT_MS` /
`transportFailure()` from `src/lib/integrations/probe.ts`. No provider response text is ever
returned to the client (same rule `src/lib/integrations/probe.ts`'s `detail` field follows).

- **YouTube**: `GET /youtube/v3/search?part=id&q={query}&type=channel&maxResults=10` with the user's
  stored `youtubeApiKey`, then a batched `GET /youtube/v3/channels?part=snippet&id=...` for
  title/`customUrl`. Result: `{ value: channelId, label: "{title} ({handle or channelId})" }`. Ported
  from `old/core/aggregators/youtube/aggregator.py`'s `search_channels()`.
- **Reddit**: the same client-credentials token exchange as `testRedditCredentials()` in
  `src/lib/integrations/reddit.ts` (factor the token fetch out so both share it), then
  `GET https://oauth.reddit.com/subreddits/search?q={query}&limit=10` with the resulting Bearer
  token. Result: `{ value: display_name, label: "r/{display_name}: {title} ({subscribers} subs)" }`.
  Ported from `old/core/aggregators/reddit/aggregator.py`'s `get_identifier_choices()`, translated
  from PRAW's `subreddits.search()` to the plain REST endpoint it wraps.

## Server-side persistence — `src/lib/feeds/actions.ts`

- `createFeed`/`updateFeed`: for `none`/`choice` modes, snap the submitted identifier to a valid
  `identifierChoices` value — if it's empty or not one of them, fall back to the first choice. Mirrors
  Python's `normalize_identifier()`. `search`/`url` modes are validated exactly as today
  (`identifierRequired` check, unchanged).
- `createFeed` additionally rejects creating a **new** feed with `youtube`/`reddit` when that
  integration isn't currently enabled — defense in depth, the same shape as the existing
  `stripUnavailable()` guard on AI/YouTube/Reddit-gated *options*. `updateFeed` applies the same
  rejection only when the request **changes** the aggregator to `youtube`/`reddit`
  (`spec.key !== feed.aggregator`) while it's disabled — assigning the aggregator for the first time
  is the same act as creating with it. Saving a feed that **already has** that aggregator (aggregator
  unchanged, or omitted from the request) is never rejected, however the integration's current state:
  that's what keeps an existing feed editable after its integration is disabled, per the
  disabled-with-banner UI decision above.

## i18n

New catalog keys, `feeds` namespace: identifier-search placeholder/loading/empty-results text, and
the missing-integration banner sentence for the identifier field (reusing the existing banner's
wording pattern, not its exact string, since it needs to name the field rather than "options"). Added
to both `messages/en.json` and `messages/de.json` per the existing parity rule.

## Testing

- **`src/lib/aggregators/specs.test.ts`** (new) — table-driven: assert `identifierModeFor()` returns
  the mode listed in this doc's table for all 16 keys, and assert every `choice`/`none` aggregator's
  `identifierChoices` in `specs.ts` matches `getIdentifierChoices()` on its corresponding class in
  `src/lib/aggregators/sites/*` byte-for-byte — this is what keeps the hand-kept duplicate honest.
- **`src/components/feeds/feed-form.test.tsx`** — per mode, the right control renders; switching
  aggregator resets the identifier to that aggregator's default; the aggregator picker hides
  YouTube/Reddit for a new feed when the integration is off but keeps it for an existing feed of that
  type; the disabled-field-plus-banner state renders for that edit case.
- **`src/lib/aggregators/search.test.ts`** (node) — real-database `user_settings` row with
  YouTube/Reddit enabled and fake credentials, `fetch` stubbed (same style as the existing
  `src/lib/integrations/*.test.ts` probe tests) to return canned API payloads; assert the mapped
  `{value, label}` shape, the disabled-integration guard, the under-2-characters no-op, and that a
  transport failure returns a catalog key rather than throwing.

## Out of scope

- The unused `redditSubredditId`/`youtubeChannelId` FK columns and the `redditSubreddits` /
  `youtubeChannels` reference tables ([schema/feeds.ts](../../../src/lib/db/schema/feeds.ts),
  [schema/references.ts](../../../src/lib/db/schema/references.ts)) are not populated by this
  feature. Search results are ephemeral, not cached — Django's `update_search_results()` side-effect
  upsert is not ported. Revisit if a later feature needs to join against searched-but-not-selected
  channels/subreddits.
- Actually implementing the YouTube/Reddit/podcast **aggregation** (fetching articles, not searching
  for an identifier) is a separate, already-tracked gap — those three aren't yet in
  `IMPLEMENTED_AGGREGATORS` ([registry.ts](../../../src/lib/aggregators/registry.ts)). This feature
  only makes it possible to *pick* a channel/subreddit correctly; running the resulting feed is
  untouched.
