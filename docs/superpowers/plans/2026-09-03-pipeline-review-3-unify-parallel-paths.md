# Pipeline Review 3 — Unify the Parallel Paths Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** plans `2026-09-03-pipeline-review-1-correctness.md` and
`-2-data-integrity.md` complete, with `npm test` green in the working tree.
Nothing is merged between plans (see "Execution model" below). Several tasks
here delete the second copy of a rule whose *first* copy those plans just fixed
— doing it in the other order re-introduces the bug.

**Goal:** Eliminate the class of defect the 2026-09-03 review found, rather than
its instances. Every high-severity bug in plans 1 and 2 was a place where one
rule was implemented twice and one copy drifted, often under a comment asserting
that it could not. This plan collapses those pairs into single implementations.

**Architecture:** Nine consolidations. Each replaces N implementations with one,
and each must be **behaviour-preserving except where a plan-1/2 fix defined the
correct behaviour** — in which case the surviving implementation is the fixed
one. Expect the diff to be large and the test suite to be the safety net; do not
batch unrelated consolidations into one commit.

**Tech Stack:** TypeScript, cheerio, Drizzle ORM + better-sqlite3, Vitest.

## Execution model — read this first

All four plans run in **one session on one branch**, with the model's context
cleared repeatedly along the way. **Nothing is merged until the last change of
plan 4.** Two consequences, and neither is optional:

- **This file is the progress record.** Tick each `- [ ]` to `- [x]` as you
  finish it, in the same commit as the work. After a context clear, the only
  reliable answer to "where am I" is this file plus `git log`. A finished step
  left unticked will be redone; an unfinished step ticked early will be skipped.
- **Commit per task, never per plan.** Use the message prefix
  `refactor(review-N): Task M — <what>` (or `fix(...)`/`test(...)` as
  appropriate) so `git log --oneline` reconstructs progress at a glance. A
  single giant commit is unbisectable, and with no intermediate merge there is
  no CI run to catch a bad one.

### Resuming after a context clear

1. `git log --oneline -20` — find the last `review-N` commit.
2. Open this file and find the first unticked `- [ ]`.
3. If the two disagree, trust `git log` and the working tree, not the
   checkboxes — then correct the checkboxes.
4. `git status` must be clean before starting a new task. If it is not, the
   previous task was interrupted mid-edit: finish or revert it first.
5. Re-read the task's own "The bug" preamble before touching code. Every task
   here restates its evidence with `file:line` precisely so a cleared context
   does not have to trust a summary.

### Verification, given nothing merges

`npm run lint && npm run format:check && npm run typecheck && npm test` must be
green **at the end of every task**, not just at the end of the plan. With no
intermediate merge there is no CI safety net, so the local suite is the only
signal — and a break introduced in plan 1 that surfaces in plan 4 is
expensive to locate. Do not defer verification to "the end".

Full context for all four plans:
`docs/superpowers/specs/2026-09-03-pipeline-review-findings.md`.

## Global Constraints

- **Behaviour-preserving.** Any behaviour change must be deliberate, called out
  in the commit message, and covered by a test. A consolidation that quietly
  changes output is worse than the duplication it removes.
- Characterisation tests first: before collapsing N implementations, pin the
  current output of each with a test. Then collapse. Then confirm the pins still
  pass.
- Every write goes through `writeTransaction()`, callback synchronous.
- Real-database tests only. Four CI checks before pushing.
- `messages/en.json` / `messages/de.json` stay key-for-key identical.

---

### Task 1: One HTML sanitizer, not six

**The duplication.** The same 21-line sanitizer is written six times, verified
byte-identical (whitespace-normalised) in the first five:

| file:line | name |
|---|---|
| `sites/mactechnews/comments.ts:15-36` | `sanitizeCommentHtml` |
| `sites/mein_mmo/comments.ts:15-36` | `sanitizeCommentHtml` |
| `sites/heise.ts:27-48` | `sanitizeCommentHtml` |
| `sites/youtube/aggregator.ts:48-69` | `sanitizeCommentBodyHtml` |
| `sites/reddit/markdown.ts:375-396` | `sanitizeMarkdownHtml` |
| `sites/podcast.ts:20-43` | `sanitizeShowNotesHtml` (differs by a temp variable) |

Each does: `cleanHtml` → `cheerio.load` → `sanitizeHtmlAttributes` →
`removeSanitizedAttributes` → strip unsafe `href` → drop unsafe `img` → return
`body.html()`.

**This is security-relevant.** It is the last line of defence before
user-supplied comment HTML is stored and served by
`/api/v1/articles/[id]/content`. Maintained in six places, a hardening applied
to one copy protects one site.

**Files:** create the shared export in `src/lib/aggregators/extract/clean.ts`;
modify the six sites; modify their tests.

- [x] **Step 1:** Pin current output for each of the six with a characterisation
      test over a fixture containing a script tag, an `onclick`, a
      `javascript:` href, a `data:` image and a normal link.
- [x] **Step 2:** Export one `sanitizeUntrustedFragment(html: string): string`
      from `extract/clean.ts`. Take the strictest behaviour where the six
      differ, and note any deliberate widening in a comment.
- [x] **Step 3:** Replace all six call sites. Confirm the pins pass.
- [x] **Step 4:** While in `clean.ts` — the "walk every element including self"
      idiom is written out four times (`clean.ts:103,182,198,256`) as
      `typeof soup === "function" ? soup("*") : soup.find("*").addBack("*")`.
      Extract it to one helper.

---

### Task 2: One comment-section builder, not four

**The duplication.** Four implementations of "emit
`<section><h3>comments-link</h3>` + N `<blockquote>`":
`sites/mactechnews/comments.ts`, `sites/mein_mmo/comments.ts` (lines 1-37 and
82-133 are **byte-identical** between the two; only five selector strings and
the author/timestamp reads differ), plus `sites/reddit/content.ts:220-262` and
`sites/youtube/aggregator.ts:304-322`.

They differ only in where the comment list comes from (DOM scrape vs API) and
which empty-state label they emit (`null`, `noCommentsYet`, `commentsDisabled`,
`commentsUnavailable`).

**Do this task *after* plan 1 Task 2**, which fixed the Reddit/YouTube
comment-hash bug. The shared builder is the right home for that fix: it should
return the section for the caller to hand to `formatArticleContent`'s
`commentsContent` slot, making it structurally impossible for a fifth site to
forget.

**Files:** create `src/lib/aggregators/comments/section.ts`; modify the four
sites and their tests.

- [x] **Step 1:** Characterisation tests pinning all four sites' current comment
      HTML.
- [x] **Step 2:** Define the descriptor, in the style of
      `src/lib/integrations/define.ts` (the precedent this repo already uses for
      "one declaration, shared sequence"):

```ts
interface CommentSpec<T> {
  list(source): T[];
  author(c): string;
  timestamp?(c): string;
  bodyHtml(c): string;
  anchorUrl(c): string;
  emptyLabel?: keyof ChromeLabels;
}
buildCommentsSection<T>(spec, source, sectionUrl, max, labels): string | null
```

- [x] **Step 3:** Convert MacTechNews and Mein-MMO to ~25-line selector
      descriptors, Reddit and YouTube to ~15-line adapters.
- [x] **Step 4:** Comment-extraction failures are currently swallowed with no
      log anywhere — `heise.ts:391-404,460-462`,
      `mactechnews/aggregator.ts:219-228`, `mein_mmo/aggregator.ts:208-217` all
      use `catch { /* ignore */ }`. `website.ts:216-218` was explicitly changed
      to log for this reason. Have the shared builder log via `onLog` on
      failure — this is the most selector-fragile code in the tree and currently
      the one place with no signal at all.

---

### Task 3: One YouTube URL module, not six

**The duplication and the bug.** Six YouTube-ID extractors disagree on which URL
forms they accept:

| # | location | nocookie | `/live/` |
|---|---|---|---|
| 1 | `extract/format.ts:16-30` | no | no |
| 2 | `images/strategies.ts:19-35` | no | no |
| 3 | `embeds/youtube.ts:25-60` (`youtubeIdFrom`) | **yes** | **yes** |
| 4 | `blocks/parser.ts:73-76` | yes | no |
| 5 | `sites/mein_mmo/embeds.ts:61` | yes | no |
| 6 | `components/articles/block-node.tsx:14` | yes | no |

Copies 1 and 2 are byte-for-byte identical. `isYoutubeUrl` also exists twice
(`website.ts:57`, `embeds/youtube.ts:68`) with identical bodies, as does the
thumbnail-URL builder (`embeds/youtube.ts:63` vs `images/strategies.ts:36`).

**The live bug.** `website.ts:85-96` gates on `isYoutubeUrl()` — whose list
**includes** `youtube-nocookie.com` — then calls `extractYoutubeVideoId()` from
`format.ts`, which has **no** nocookie pattern. So a
`<iframe src="https://www.youtube-nocookie.com/embed/ID">` passes the gate,
yields `null`, and is left untouched — no facade, no localized thumbnail, no log
line. Heise, Merkur and Mein-MMO then carry
`iframe:not([src*='youtube.com']):not([src*='youtu.be'])` in
`selectorsToRemove`, which nocookie matches neither of — so the embed is
**deleted outright**. A privacy-embedded YouTube video vanishes silently. Same
for `youtube.com/live/ID`.

**Files:** consolidate into a new, dependency-free
`src/lib/aggregators/embeds/youtube-url.ts` (not `embeds/youtube.ts` itself —
that module imports `storeImageRefFromUrl` and re-exports from `../website`,
both server-only, so `block-node.tsx` cannot import it directly;
`embeds/youtube.ts` re-exports everything from the new module unchanged);
modify `extract/format.ts`, `images/strategies.ts`, `website.ts`,
`components/articles/block-node.tsx`, `blocks/parser.ts`,
`sites/mein_mmo/embeds.ts`, `header/strategies.ts`, `sites/reddit/images.ts`,
`sites/reddit/aggregator.ts`; modify tests.

- [x] **Step 1:** Failing test — a nocookie iframe and a `/live/` URL both
      produce a facade rather than being dropped.
- [x] **Step 2:** Make `youtubeIdFrom` (the only complete one) the single export.
      Delete copies 1, 2 and the `isYoutubeUrl`/thumbnail twins.
- [x] **Step 3:** Copies 4 and 5 have tighter `{6,}`/`{11}` length constraints
      and are defensible as separate inline patterns — but they must at minimum
      share the domain alternation. Export it as a constant.
- [x] **Step 4:** Copy 6 is a client component; check the import does not drag
      server-only code into the browser bundle before wiring it up.
- [x] **Step 5:** Same treatment for `isTwitterUrl`, which exists at
      `extract/format.ts:74-80` and `images/strategies.ts:41-45`. Note the
      `format.ts` one uses `url.includes(domain)`, so
      `https://evil.example.com/?ref=twitter.com` is "a Twitter URL"; the
      parser's version (`parser.ts:635`) correctly parses the hostname. Keep the
      hostname-parsing one.

---

### Task 4: One provider table in `run.ts`

**The duplication.** `src/lib/ai/run.ts:334-492` — 159 lines. Five of the seven
`callXxx()` methods (openai, mistral, qwen, deepseek, openrouter) are the same
12-line shape: read `enabled`, read `apiKey`, warn-and-return, read `model`,
read `timeout`, call `callOpenaiCompatible` with a base URL.

Everything needed to make this data already exists: `AI_COLUMNS`
(`src/lib/ai/columns.ts:50-87`) maps provider → column names and is already
`satisfies Record<AiProviderKey, AiColumns>`, so a missing provider is a compile
error. `providers.ts` holds every base URL and default model.
`src/lib/ai/probes.ts:52-62` is this exact pattern, already done, for the probe
half.

**Files:** modify `src/lib/ai/run.ts`, `src/lib/ai/run.test.ts`.

- [ ] **Step 1:** Characterisation tests pinning the exact request URL, headers
      and body for all seven providers.
- [ ] **Step 2: Delete the dead snake_case surface.** `AiRuntimeSettings`
      (`run.ts:26-55`) declares 29 snake_case fields, read via 38
      `this.settings.xxxYyy ?? this.settings.xxx_yyy` chains. **No production
      caller supplies one** — `aggregate.ts:35`, `reload.ts:135` and
      `api/v1/ai/prompt/route.ts:27-31` all pass a full Drizzle `UserSettings`
      row, and the only object literals using those keys are raw-SQL row
      assertions in tests. The module doc justifies keeping it for "whatever
      *does* hand this a snake_case row"; nothing does, and nothing can, because
      every call site reads a Drizzle row.

      Note `aiMaxRetryTime`/`ai_max_retry_time` has **no column in either
      spelling**, so the retry-time budget is permanently the hardcoded `60`.
      Decide explicitly: add a column, or make the constant a named constant and
      say so. Do not leave a settings-shaped value that no setting reaches.

- [ ] **Step 3: Collapse the seven branches** into one table:

```ts
Record<AiProviderKey, {
  url: string | ((s: AiRuntimeSettings) => string);
  shape: "openai-compatible" | "anthropic" | "gemini";
}>
```

Anthropic and Gemini keep their own request/response envelopes but read their
columns from the same table.

- [ ] **Step 4: Deduplicate `requestWithRetry`'s 429 handling.** Lines 166-186
      (429 response) and 199-217 (caught error with `.status === 429`) are the
      same ~19 lines, behaviourally identical. **The second is unreachable** —
      undici rejections are `TypeError`/`DOMException` with `.code`/`.cause`,
      never `.status`, and `ProviderUnauthorizedError` is rethrown before the
      check. It is a literal port of Python `requests`' `raise_for_status()`
      idiom. Delete lines 199-217 and the `errorStatus()` helper.

- [ ] **Step 5: Make the client agree with `activeProvider()`.** `run.ts:117`
      sets `this.provider` from the raw `activeAiProvider` column, and
      `run.ts:742`'s guard is a bare truthiness test — but `activeProvider()`
      (`queries.ts:103-106`), documented as "the *only* place that decision is
      made", **also requires the provider's `*Enabled` flag**.

      So with `activeAiProvider = "openai"` and `openaiEnabled = false` (a
      re-probe classified the key unauthorized, or the operator pressed Remove —
      both deliberately leave the preference in place), `/ai` correctly reports
      no active provider while `applyAiToBlocks` passes its guard, dispatches,
      hits `!enabled` and reports `providerError` — telling the operator the
      provider failed when nothing was ever sent.
      `POST /api/v1/ai/prompt` does not have this bug because it calls
      `activeProvider()` first (`route.ts:48`) — which is itself the
      inconsistency. Route both through `activeProvider()`.

- [ ] **Step 6: Route the seven "not enabled or configured" warnings through
      `this.warn()`.** They currently use bare `console.warn`
      (`run.ts:338,354,398,447,460,472,485`, plus `run.ts:437`), so the one
      message that explains why an article was skipped is the one message that
      never reaches the job log. `this.warn()` (`run.ts:124`) is what mirrors
      into `onLog`.

- [ ] **Step 7: Two smaller fixes in the same function.**
      (a) `clearTimeout` is skipped on the throw path (`run.ts:139-159`), so a
      failed attempt leaves a timer armed. (b) The abort timeout does not cover
      the response body — `clearTimeout` fires before `await response.json()`
      in all three shapes, so a provider that sends headers then stalls the body
      hangs the job indefinitely. Use `AbortSignal.timeout`, as every probe
      already does.

- [ ] **Step 8: Guard `openaiApiUrl = ""`.** `run.ts:342` uses `??`, which does
      not catch an empty string; `testOpenaiKey` (`openai.ts:61`) uses
      `apiUrl?.trim() || DEFAULT` and is immune. Match the probe.

---

### Task 5: One article write, one transaction

**The problem.** `aggregate.ts` writes the row (`:215`), then `writeBlocks()`
(`:263`), then `contentHash` (`:277`) — three separate transactions with
`await`s between them. `reload.ts` uses the opposite order (blocks then row).

**`writeBlocks()` is already synchronous** — `blocks/storage.ts:157-215` goes
through `writeTransaction()` with a synchronous callback and contains no
`await`. So `await writeBlocks(...)` yields only to the microtask queue and no
HTTP handler can observe the gap. The `async` is cosmetic.

But a **process crash** between the three is durably observable: for an insert,
the row exists with zero blocks and `contentHash = null`. That self-heals on the
next run — unless the entry has aged out of the feed window, in which case the
article stays permanently bodyless. It can also reach `/api/v1` sync's `new`
stream (cursored on `createdAt`) bodyless, and the `new` cursor advances past it.

**Files:** modify `src/lib/aggregators/blocks/storage.ts`,
`src/lib/jobs/handlers/aggregate.ts`, `reload.ts`, and their tests.

- [ ] **Step 1:** Extract `writeBlocksIn(tx, articleId, blocks)` from
      `writeBlocks()`; keep `writeBlocks()` as a thin wrapper for other callers.
- [ ] **Step 2:** In `aggregate.ts`, do the row write, block write and hash write
      in **one** `writeTransaction`. This is strictly less code, removes two
      lock acquisitions per article, and makes the article atomically visible.
      The "hash written last" reasoning in `schema/articles.ts:48-51` survives
      unchanged — within one transaction it is automatic.
- [ ] **Step 3:** Align `reload.ts` to the same single-transaction shape.
- [ ] **Step 4:** Drop the cosmetic `async` from `writeBlocks`,
      `loadBlocksForArticles` and `readBlocks` if no caller needs it.
- [ ] **Step 5: Fix the read-path chunking asymmetry.** `storage.ts:142-147`
      chunks inserts at 100 to survive a 999-variable
      `SQLITE_MAX_VARIABLE_NUMBER` build, with a comment noting "a long-form
      scraped article can produce thousands of blocks". Twelve lines later,
      `loadBlocksForArticles` binds every block id in one `inArray`
      (`:322`, `:333`) — unchunked. On the build the write side defends against,
      reading back an article it just wrote throws. Chunk both.
- [ ] **Step 6: Note the `RETURNING` order assumption.** `storage.ts:182-203`
      pairs `insertedRows[i].id` positionally with `level[i]`. SQLite documents
      `RETURNING` row order as **undefined**; it holds in practice under
      better-sqlite3, but the failure mode is a silently scrambled tree. Either
      re-read keyed on `position`, or add a comment recording the assumption
      explicitly. Do not leave it implicit.

---

### Task 6: Make `canonicalBlocks` satisfy its own contract

**The bug (proven, not reasoned).** `canonicalRuns()`
(`src/lib/ai/block-text.ts:210-217`) applies its trailing-space trim **before**
the empty-run filter. When the last run trims to `""` it is dropped and the new
last run keeps its trailing space; a second pass trims that one too.

Verified in-tree:

```
input runs: [{"  b  c\nd", bold}, {"a  b  ", italic}, {"   "}]
pass1 last run: "a b "
pass2 last run: "a b"
IDEMPOTENT: false
```

329 of 20,000 fuzzed trees are non-idempotent this way. The module doc at
`block-text.ts:46` states idempotence as the specification — "which is what lets
the rewrite path trust a returned document it did not build" — and `run.ts:894`'s
echo detection depends on it. `block-text.test.ts:81-86` pins idempotence
against one hand-picked string that happens not to hit it.

**Second half: empty blocks.** `canonicalBlocks` never drops a block that
canonicalizes to nothing, but `textToBlocks` skips blank lines, so it always
does. Consequences (all measured): an empty paragraph is lost and the text is
unstable; a `heading level:2 runs:[]` becomes a paragraph `"##"`; a list with an
empty first item becomes a paragraph plus a one-item list. And the echo
predicate false-negatives — a perfect echo containing an empty paragraph is
reported as *changed*.

Reachable today: `parseBlocks()` never emits an empty block, so the echo path is
safe — but `textToBlocks` **does** emit them from model answers (`<b></b>` → an
empty paragraph; `[](L0)` → an empty paragraph), and that tree is stored and
rendered.

**Files:** modify `src/lib/ai/block-text.ts`, `block-text.test.ts`.

- [ ] **Step 1:** Add the failing idempotence test using the exact input above.
- [ ] **Step 2:** Move the edge trim **after** the filter, or loop until stable.
- [ ] **Step 3:** Have `canonicalBlocks` drop blocks that canonicalize to empty,
      making it agree with `textToBlocks`. Per the blocks audit this single
      change resolves the idempotence failure, the empty-block round trip and
      the `.text` half of the `blocksToText(canonicalBlocks(b)) ≠ blocksToText(b)`
      divergence at once.
- [ ] **Step 4:** Fix the `.opaque` divergence: `serializeBlocks`
      (`block-text.ts:275-285`) pushes the **raw** block into `doc.opaque` while
      serializing a *canonicalized* caption into the text, so the two sides
      disagree about the same image. Canonicalize once, up front.
- [ ] **Step 5:** Add a fuzz test (the audit's harness generated 20,000 trees
      with nested lists, quotes-in-lists, summaries, and adversarial run text)
      asserting round-trip text stability and structural equality. This is the
      only way to keep this module honest.
- [ ] **Step 6:** Clamp `heading.level` in **one** place. It is currently clamped
      at `block-text.ts:295` and `storage.ts:70`, and **not** in
      `canonicalBlocks` or `blockForRow` (`storage.ts:232`), so a `level: 7`
      heading round-trips to 6 while `canonicalBlocks` leaves it at 7.
- [ ] **Step 7:** `dropImageBlocks` (`parser.ts:425-454`) recurses into
      `blockquote` and `list` but not `summary`, unlike every other tree walk in
      the codebase (`block-text.ts:158`, `plain-text.ts:35`, `storage.ts:30`,
      `storage.ts:257`). Add it.
- [ ] **Step 8:** `serializeRun` does `links.indexOf(run.link)` per run
      (`block-text.ts:246`) — O(n²) on link-dense articles. Use a `Map`.

---

### Task 7: Report what the AI actually dropped

**The bug.** `OPAQUE_LINE = /^\[\[M(\d+)\]\](?:\s+(.*))?$/`
(`block-text.ts:529`) requires the placeholder to be the entire line, and
`state.seen` is a `Set` with no count. Measured consequences:

| model answer | result | reported? |
|---|---|---|
| `[[M0]]` with the caption omitted | image kept, **caption silently deleted** | no |
| `As shown in [[M0]] the sales rose.` | image lost **and `[[M0]]` stored as visible prose** | image only |
| `[[M0]] …\n\n[[M0]] …` | **image stored twice**, the other image lost | the loss only |

`pinLeadMedia` (`run.ts:594`) de-duplicates only the lead block, so the
duplication case is exactly the bug its own comment describes as fixed — still
live for non-lead media.

Separately, `run.ts:932-939` logs `droppedOpaque` and then reports
`{status: "applied"}`, so `aggregate.ts` writes the article **and its
`contentHash`** — and because the hash is over the unchanged *source*, the next
run matches and skips. **The images the model dropped are gone for the life of
that source article.**

- [ ] **Step 1:** Tests for all three rows of the table above.
- [ ] **Step 2:** Count occurrences instead of `Set.has`; report duplicates.
- [ ] **Step 3:** Report a caption that was non-empty on the way out and empty on
      the way back.
- [ ] **Step 4:** Strip or refuse a `[[Mn]]` token that survives into run text —
      storing the literal placeholder as prose is never right.
- [ ] **Step 5: Decide the policy for `droppedOpaque.length > 0`.** Given
      `aggregate.ts`'s own stated rule for a failed AI stage ("write nothing at
      all, so the next run can store the article whole"), dropped media should
      either land in the failure arm or at minimum **suppress the `contentHash`
      write** so the next cycle retries. Recommend the latter — it is the
      smaller change and it removes the permanence, which is the actual harm.
      Put the choice to the owner if it is not obvious in context.
- [ ] **Step 6: Make the two callers agree about `failed`.** `applyAiToBlocks`
      documents a deliberate asymmetry — `missingDocument` returns the input
      untouched, `missingSummary` **keeps a rewrite that did come back**. But
      `aggregate.ts:180-206` discards `ai.blocks` entirely on any failure, so
      the carefully preserved rewrite is thrown away — the asymmetry is dead on
      that path. And `reload.ts:249-289` writes blocks, title and plainText
      *before* inspecting `ai.outcome`, then throws — so a `missingSummary`
      with a good rewrite stores correctly, marks the job **failed**, and emails
      the owner a failure for what was 90% a success.

      A caller cannot tell from `{status: "failed", reason}` whether `blocks` is
      the input or a partial result — that distinction lives only in a comment.
      Make it explicit in the type: either a `partial: boolean` field or a third
      `degraded` status.

---

### Task 8: One enrichment pipeline for aggregate and reload

**The duplication.** `reload.ts:196-230` reimplements
`FullWebsiteAggregator.enrichArticles`'s pipeline (`website.ts:191-222`) —
`extractHeaderElement` → `fetchArticleContent` → `extractContent` →
`hasBodyContent` → `processContent`. Same five steps, and **four different
failure policies across the two files**: skip the article, keep the original RSS
body, write an error notice, or throw.

**Also fix the `noteSourceTitle` gap here**, because it has the same cause. Only
4 of 15 aggregators note a source title (`rss.ts:59`, podcast by inheritance,
`youtube/aggregator.ts:373`, `reddit/aggregator.ts:667`). The other eleven — the
entire `FullWebsiteAggregator` family — do not, and the cause is **structural,
not eleven independent decisions**: `FullWebsiteAggregator.fetchArticleContent()`
(`website.ts:143-145`) overrides `RssAggregator`'s **without calling it**, so
the noting at `rss.ts:59` is silently dropped.

`base.ts:290-294` defends this on two grounds, and the first no longer holds on
the path that matters: the concurrency objection is true of `enrichArticles()`
but **not** of reload, which is one article and one instance — and reload is
`sourceTitle`'s only consumer.

Without it, a feed with AI options re-feeds a previous AI run's title back into
the model: title drift on every reload, and for `translate`, a title already in
the target language beside an untranslated body — the "reload only translates
the title" report.

- [ ] **Step 1:** Characterisation tests for both paths' failure behaviour.
- [ ] **Step 2:** Extract one `enrichOne(article, policy)` with the failure
      policy as an explicit parameter, so the divergence is stated once instead
      of implied in four places.
- [ ] **Step 3:** Add an optional
      `protected sourceTitleFrom($: CheerioAPI): string | null` hook, called
      once from `FullWebsiteAggregator.fetchArticleContent()`, defaulting to
      `null`.
- [ ] **Step 4:** Supply one selector each for the sites that can:
      heise (`.a-article-header__title`), merkur
      (`.id-StoryElement-headline`), tagesschau
      (`span.seitenkopf__headline--text`), caschys_blog (`h1.entry-title`),
      mein_mmo (`h1.entry-title` / `og:title`), mactechnews (heading inside
      `.MtnArticle`). For `ars_technica` and `the_verge` — both
      `RssSummaryFallbackAggregator`, whose content already falls back to the
      RSS summary — simply **not dropping** `rss.ts:59` is the whole fix.
      oglaf/explosm/dark_legacy are comics with no headline distinct from the
      feed's: leave them `null`.
- [ ] **Step 5: Unify the four empty-result ladders in `extractContent`.**
      `website.ts:256-258` and `heise.ts:318-320` return `article.content`;
      `merkur.ts:107-109` recurses into `super.extractContent()`, which falls
      back to `<body>` — a *different* answer that can surface site navigation
      as the article; `tagesschau/aggregator.ts:186-195` has a three-tier ladder.
      Tagesschau's is the most defensible; make it the shared one.

---

### Task 9: One multipage fetcher, and fix MacTechNews' lost comments

**The bug.** `sites/mactechnews/aggregator.ts:128-136` replaces the fetched page
with `fetchAllPages()`'s output, which is only the joined `.MtnArticle`
containers (`multipage.ts:78-84`). `website.ts:204` stores that as
`article.raw_content`, and `aggregator.ts:221-223` scrapes comments out of
`raw_content` — where `div.MtnCommentScroll` no longer exists. So **multi-page
MacTechNews articles lose all their comments**, on aggregation and on reload
(`reload.ts:141` assigns the combined content to `raw_content` too).

Mein-MMO has this exact fix already — a `firstPageHtmlByUrl` map
(`mein_mmo/aggregator.ts:114-121,135,200-201`) with a comment explaining the
concurrency hazard. Same bug, one path fixed, the parallel one not.

**The duplication.** `sites/mactechnews/multipage.ts` (95 lines) and
`sites/mein_mmo/multipage.ts` (107) share the same 35-line `fetchAllPages()`
loop. MacTechNews' version is already generic (it takes `contentSelectors`);
Mein-MMO's hardcodes its selectors. The only genuine difference is the page-URL
builder (`?page=N` vs `/N/`), which is a 3-line callback. `detectPagination()`
legitimately differs per site and should stay separate.

- [ ] **Step 1:** Failing test — a two-page MacTechNews article keeps its
      comments.
- [ ] **Step 2:** One shared `fetchAllPages()` returning
      `{ combined, firstPage }`, so neither site can forget the un-truncated
      first page. That is the structural fix; copying Mein-MMO's map into
      MacTechNews would be a second copy of the workaround.
- [ ] **Step 3:** Point both sites' comment extraction at `firstPage`.

---

## Done criteria

- [ ] All nine tasks complete. Each consolidation landed as its own commit with
      characterisation tests passing before and after.
- [ ] The block-text fuzz test from Task 6 Step 5 is in the suite and green.
- [ ] Four CI checks green; no new lint warnings.
- [ ] `CLAUDE.md` rewritten for every invariant this plan changes — in
      particular the `noteSourceTitle` bullet (now a hook, not a per-site
      decision), the comment-section contract, and the AI provider-table shape.
      Several existing bullets assert unification that was aspirational; they
      become true here and should say so precisely.
