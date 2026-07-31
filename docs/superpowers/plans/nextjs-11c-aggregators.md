# Phase 11c: The Sixteen Aggregators — Implementation Plan

> **Path note (post folder swap):** the Next.js app is the repository root and the
> Django tree is `old/`. Read Python paths below — `core/…`, `yana/…` — as
> `old/core/…` / `old/yana/…`, and treat `uv run …` commands as historical: `old/`
> is read-only reference and is not runnable as configured.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Structural. One task per aggregator, each independently verifiable against its golden cases — which makes this the phase most suited to parallel execution.

**Goal:** Port all sixteen aggregator implementations, closing every remaining golden case, and provide a per-aggregator npm script replacing `test_aggregator`.

**Architecture:** Each aggregator is a subclass overriding the same hooks it overrides in Python, registered in a `Record<AggregatorKey, AggregatorConstructor>` mirroring `core/aggregators/registry.py`. Because phases 11a–11b established the shared base and the goldens gate each case, the aggregators are genuinely independent: sixteen tasks with no ordering constraint between them beyond the three that carry extra machinery.

**Tech Stack:** Phase 11a's base classes and image pipeline, phase 11b's embed registry, Vitest.

## Global Constraints

- Every aggregator overrides only hooks its Python counterpart overrides. A behaviour implemented at the wrong level diverges everywhere else that level is used.
- Selector lists, `selectors_to_remove` and `uses_first_content_match` are **copied verbatim** from Python. A selector rewritten "more cleanly" is a behaviour change that the goldens may not catch if the fixture happens not to exercise it.
- The registry must be **exhaustive over `AGGREGATOR_KEYS`**, enforced by a test. Phase 9's form already assumes every key resolves.
- No golden may remain skipped when this phase completes. 11a Task 9's shrink assertion enforces it.
- `npm run aggregator:<key>` replaces `test_aggregator <key>`, supporting `--dry-run`, `--limit`, `--verbose` and `--first`. It is the primary debugging tool and must exist before the harder scrapers are attempted, not after.
- Per-aggregator AI options (`ai_summarize`, `ai_improve_writing`, `ai_translate`) call phase 7's configured provider. When AI is unconfigured the option is absent by phase 9's guard, so the pipeline must treat a missing option as "skip", never as an error.

---

## File Structure

`src/lib/aggregators/sites/<name>.ts` per aggregator, plus:

| Path | Responsibility |
|---|---|
| `src/lib/aggregators/registry.ts` | `AGGREGATORS: Record<AggregatorKey, AggregatorConstructor>` |
| `src/lib/aggregators/sites/reddit/{aggregator,content,markdown,urls,types}.ts` | Reddit, ported from its five modules |
| `src/lib/aggregators/sites/youtube/{aggregator,client}.ts` | YouTube + API client |
| `src/lib/aggregators/sites/mein_mmo/{aggregator,extraction,multipage}.ts` | MeinMMO |
| `scripts/aggregator.ts` | The CLI backing `npm run aggregator:*` |
| `src/lib/ai/run.ts` | `applyAiOptions(article, options)` |

---

### Task 1: The registry and the CLI

Built first because every subsequent task uses the CLI to debug.

- [ ] Port `core/aggregators/registry.py` to a `Record` keyed by `AggregatorKey`, with `identifierField` and `getIdentifierFromRelated` preserved — phase 2's feed save path relies on the equivalent behaviour.
- [ ] Test that the registry covers every `AGGREGATOR_KEYS` entry, and that each entry's `key` matches its record key.
- [ ] Write `scripts/aggregator.ts` mirroring `test_aggregator`'s flags. Read `core/management/commands/test_aggregator.py` for its output format — matching it makes the two directly comparable during the port, which is the whole point.
- [ ] Add one npm script per aggregator plus a generic `aggregator` accepting a key or feed id.
- [ ] Verify against a real feed for one already-ported aggregator (`rss`, from 11a) before proceeding.

---

### Task 2: AI option application

- [ ] Port `core/ai_client.py`'s request path plus retry, timeout and inter-request delay, driven by phase 7's `userSettings` values.
- [ ] Implement `applyAiOptions` handling the flat `ai_summarize` / `ai_improve_writing` / `ai_translate` / `ai_translate_language` keys. The direction record notes iOS nests these under `ai` and defers harmonization to phase 13 — keep them flat here.
- [ ] A missing or false option is a no-op. An unconfigured provider with a truthy option is also a no-op, with a warning log — not an exception, or one misconfigured feed fails every run.
- [ ] Port the assertions from `test_ai_processing.py`, `test_ai_client_retry.py`, `test_ai_json_extraction.py` and `test_ai_client_logging.py`.

---

### Tasks 3–8: The straightforward scrapers

One task each. Each is: read the Python, port the class, run its golden cases, run the CLI against the live site, commit.

| Task | Aggregator | Python | LOC |
|---|---|---|---|
| 3 | `oglaf` | `oglaf/` | small |
| 4 | `dark_legacy` | `dark_legacy/` | small |
| 5 | `explosm` | `explosm/` | small |
| 6 | `caschys_blog` | `caschys_blog/aggregator.py` | 207 |
| 7 | `merkur` | `merkur/aggregator.py` | 201 |
| 8 | `the_verge` + `ars_technica` | both | small |

These are grouped last-first by size deliberately: the small ones validate that the 11a base is correct before a large scraper's complexity can mask a base-level bug.

Note for Task 8: `the_verge` and `ars_technica` are the two aggregators whose fixtures phase 0 had to capture fresh, so their goldens are the youngest in the corpus and the most likely to reflect current site structure.

---

### Tasks 9–12: The substantial scrapers

| Task | Aggregator | Python | LOC | Extra machinery |
|---|---|---|---|---|
| 9 | `mactechnews` | `mactechnews/aggregator.py` | 245 | multipage |
| 10 | `tagesschau` | `tagesschau/aggregator.py` | 293 | 11b's media processor |
| 11 | `heise` | `heise/aggregator.py` | 411 | — |
| 12 | `mein_mmo` | `mein_mmo/` | 220 + 402 + 181 + 149 | multipage, embeds, custom extraction |

- [ ] `mein_mmo` is the project's stated reference implementation and the most intricate. Port it **last** of the scrapers: by then every mechanism it combines is already proven individually.
- [ ] `mactechnews` and `mein_mmo` both have `combine_pages` golden cases. Verify the multipage path against the `mactechnews/multipage` case specifically.
- [ ] Commit `9feacda` recovered text and figcaptions dropped inside media figures, and `7ddb325` fixed double-emitted images from dropped-tag subtrees. Read both before porting — they are exactly the kind of fix a fresh port silently loses.

---

### Tasks 13–15: The API-backed aggregators

| Task | Aggregator | Python | LOC |
|---|---|---|---|
| 13 | `podcast` | `podcast/aggregator.py` | 261 |
| 14 | `youtube` | `youtube/aggregator.py` + `utils/youtube_client.py` | 462 + 328 |
| 15 | `reddit` | `reddit/` (five modules) | 820 + 346 |

- [ ] `youtube`: port the API client with quota awareness. Phase 6's probe already validates the key; this consumes it. Port `test_youtube_facade.py`'s assertions — the facade behaviour is 11b's, exercised here.
- [ ] `reddit`: the largest single aggregator. Five modules — `aggregator`, `content`, `markdown`, `urls`, `types` — plus `images`. Port module by module in that order; `urls` and `types` are pure and testable first.
  - Replace `praw` with direct OAuth calls, per the direction record. The used surface is small: token acquisition, subreddit listing, and comment fetching.
  - Port the assertions from `test_reddit_aggregator.py`, `test_reddit_comments.py`, `test_reddit_posts.py`, `test_reddit_types.py` and `test_reddit_urls.py` — five files, and the markdown-to-blocks path in particular has no other coverage.

---

### Task 16: Close the corpus

- [ ] Run the full golden suite. **Zero skips.**
- [ ] Delete the skip list from 11a Task 9 entirely rather than leaving it empty — an empty list invites refilling.
- [ ] Run `npm run aggregator:<key>` against a live feed for all sixteen and compare output with `uv run python manage.py test_aggregator <key>` side by side. The goldens prove fixture parity; this is the only check of live parity, and it is the last moment Python is available to compare against.
- [ ] Record any live divergence in the commit message. A fixture-passing, live-diverging aggregator means the fixture no longer represents the site — which is information for a future fixture refresh, not a blocker.

---

## Self-Review

**Spec coverage.** All sixteen `AGGREGATOR_CHOICES` entries have a task: `rss` and `full_website` in 11a Task 8, the remaining fourteen in Tasks 3–15. Per-aggregator npm commands in Task 1. AI options in Task 2.

**Placeholder scan.** Structural by design, and legitimately so — each task is "port this named module and make its named golden cases pass", which is complete as an instruction because the oracle is mechanical. What this document adds beyond the file list: the ordering rationale (small before large, `mein_mmo` last, pure modules first within Reddit), the four prior fixes a fresh port would lose, the flat-versus-nested AI options decision, and the live-comparison step that must happen before Python is deleted.

**Type consistency.** `AggregatorKey` from phase 2. `AggregatorConstructor` produces a `BaseAggregator` from 11a Task 8. The registry's `identifierField` mirrors the Python attribute phase 2's feed save path depends on.

**Two risks.**

1. **Task 16's live comparison is the last chance to check against Python.** Phase 14 deletes it. If a divergence surfaces after that, the only remaining oracle is the frozen corpus, which by construction cannot detect site drift. This step is therefore not optional, and it should not be deferred into phase 14.
2. **Reddit is 1.1k LOC across six modules and the single largest risk in the phase.** It is scheduled last for that reason, but if it slips, the pragmatic fallback is shipping phase 12 with Reddit unported and its goldens skipped — which contradicts Task 16's zero-skip rule and so needs an explicit decision rather than a silent skip.
