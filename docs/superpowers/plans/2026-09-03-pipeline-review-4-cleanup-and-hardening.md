# Pipeline Review 4 — Dead Code, Mechanical Dedup and Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** plans 1-3 complete, with `npm test` green in the working tree.
Nothing is merged between plans (see "Execution model" below). Task 2 in
particular deletes an API that plan 3 consolidates against.

**Goal:** Remove roughly 1,400 lines of code that nothing reaches, collapse the
purely mechanical per-site repetition, and close four hardening gaps the
2026-09-03 review found adjacent to the dead code.

**Architecture:** Tasks 1-4 are deletions — no behaviour change, and the test
suite is the proof. Tasks 5-6 are mechanical dedup. Task 7 is hardening and
**does** change behaviour deliberately. Task 8 is a small pile of verified bugs
found while auditing the above; they are here rather than in plan 1 only because
they are low severity, and they must not be lost.

**Tech Stack:** TypeScript, cheerio, sharp, Vitest.

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

- **A deletion must be proven dead before it is made.** Grep for every
  identifier across `src/` including tests, and state the result in the commit
  message. "Looks unused" is not evidence.
- When a test is the *only* consumer of the code being deleted, delete the test
  too — but say so explicitly, because a green suite after removing both proves
  nothing on its own.
- Four CI checks before pushing. No new lint warnings.

---

### Task 1: Delete the dead embed registry (~450 lines)

**Proven dead.** `convertEmbed()` (`src/lib/aggregators/embeds/registry.ts:70`)
has **zero production callers** — the only non-test references are `registry.ts`
itself, `embeds/index.ts` (a barrel nothing imports) and `registry.test.ts`. The
same holds for all four `detect*`/`convert*` pairs.

The **live** embed-block producer is `blocks/parser.ts` — `embedFacade()`
(`parser.ts:582-616`) and `tweetEmbed()` (`:619-648`), a third independent
implementation.

**`embeds/twitter.ts` (157 lines) is 100% unreachable from production.**

What *is* imported in production, and must survive: `localizeThumbnail` from
`youtube.ts` (4 call sites) and `dailymotion.ts` (1); the `proxyYoutubeEmbeds`
re-export at `youtube.ts:16`; `buildBlueskyEmbedHtml` and `isBlueskyUrl` from
`bluesky.ts`.

**Latent trap worth recording as the reason not to "fix" the registry instead:**
`registerEmbedProvider` runs as an **import side effect**, so registry contents
and order depend on which modules happen to be imported. `twitter.ts` is never
registered at all, and `bluesky.ts` registers under `key: "tweet"`
(`bluesky.ts:189`), colliding with `twitter.ts`'s `key: "tweet"`
(`twitter.ts:154`). The doc at `registry.ts:37-42` describes an ordering
— "YouTube → Dailymotion → Bluesky → Twitter" — that no code establishes.

- [x] **Step 1:** Grep and record: `convertEmbed`, `registerEmbedProvider`,
      `detectYoutube`, `convertYoutube`, `detectDailymotion`,
      `convertDailymotion`, `detectBluesky`, `convertBluesky`, `detectTwitter`,
      `convertTwitter`.
- [x] **Step 2:** Delete `registry.ts`, `index.ts`, `twitter.ts`, the four
      `detect*`/`convert*` pairs and their tests.
- [x] **Step 3:** Keep `localizeThumbnail` ×2, the ID extractors (plan 3 Task 3
      consolidated them) and `buildBlueskyEmbedHtml`. Move them somewhere that
      does not imply a registry exists.
- [x] **Step 4:** Remove the `embeds/youtube.ts:16` → `website.ts` re-export
      hop. Three site aggregators import `proxyYoutubeEmbeds` *through* it
      rather than from `website.ts` where it lives; it is pure indirection and
      it is why importing `embeds/youtube.ts` drags `website.ts` in.
- [x] **Step 5:** If a registry is ever wanted, `defineEmbedProvider()` in the
      style of `src/lib/integrations/define.ts` would take the four modules from
      839 to ~380 lines. **Do not build it now** — there is no consumer. Record
      the shape in a comment or an issue and move on.

---

### Task 2: Delete the dead aggregator configuration API (~500 lines)

**Proven dead.** `BaseAggregator.saveOptions()`
(`src/lib/aggregators/base.ts:321-333`) is the *sole* reader of
`getConfigurationFields()` — and `saveOptions` itself **has no caller anywhere
in `src/`**, test or otherwise.

`getConfigurationFields()` is nonetheless overridden in 11 site files
(`merkur.ts:45`, `podcast.ts:54`, `caschys_blog.ts:17`, `explosm.ts:20`,
`dark_legacy.ts:25`, `oglaf.ts:30`, `heise.ts:201`,
`mactechnews/aggregator.ts:44`, `mein_mmo/aggregator.ts:33`,
`tagesschau/aggregator.ts:81`, `youtube/aggregator.ts:82`,
`reddit/aggregator.ts:64`), each a hand-written dict restating exactly what
`specs.ts` declares for the same aggregator. With the `getIdentifierChoices()`
overrides that is ~380 lines.

**`registry.test.ts:215-217` states the problem outright** — "specs.ts and the
site classes' getConfigurationFields() are hand-kept duplicates of each other" —
and then pins only one of them, byte-for-byte comparing `getIdentifierChoices()`
against `identifierChoices`. The test suite **enforces the duplication**.

A second dead cluster on `BaseAggregator`, none with a production caller:

| member | location |
|---|---|
| `resolvesFeedUrl()` | `base.ts:47` |
| `getIdentifierFromRelated()` | `base.ts:43` |
| `getDefaultIdentifier()` | `base.ts:62` + 11 overrides |
| `supportsIdentifierSearch` | `base.ts:40` |
| `brandSiteUrl` | `base.ts:41` + 11 overrides |
| `normalizeIdentifier()` | `base.ts:113` + 2 overrides |
| `getIdentifierLabel()` | `base.ts:124` + 2 overrides |
| `getAggregatorType()` | `base.ts:134` + 2 overrides |
| `getIdentifierChoices()` | `base.ts:53` |
| `logoImageUrl()` | `base.ts:103` |

Only `getSourceUrl()` is live (`jobs/handlers/logo.ts:44`). The specs-driven
equivalents already exist and are what the UI uses: `identifierModeFor`,
`defaultIdentifierFor`, `identifierChoices` in `specs.ts`, and
`src/lib/feeds/actions.ts:67`'s own spec-driven `normalizeIdentifier(spec, …)`.

- [x] **Step 1:** Grep and record every member above.
- [x] **Step 2:** Delete `saveOptions()` and all 11+ `getConfigurationFields()`
      overrides.
- [x] **Step 3:** Delete the identifier cluster and its overrides. Keep
      `getSourceUrl()`.
- [x] **Step 4:** Rewrite `registry.test.ts:215-217` so it no longer enforces a
      duplication that no longer exists. `specs.ts` becomes the single source.
- [x] **Step 5: Collapse the two factories.** `registry.ts:54-72` exposes
      `AggregatorRegistry.get/getAll` and `getAggregator(feed)`; `factory.ts:7-13`
      exposes `createAggregator()` and is the **only** one anything calls
      (`aggregate.ts:55`, `reload.ts:137`, `logo.ts:25`). They also disagree on
      unknown keys — `createAggregator` falls back to `FullWebsiteAggregator`,
      `AggregatorRegistry.get` **throws**. Keep one.

---

### Task 3: Delete the two dead JSON branches in Reddit and YouTube (~165 lines)

**Reddit (~138 lines).** `sites/reddit/aggregator.ts:708-845` re-implements
crosspost notice → selftext → gallery → link media → comments, i.e. exactly
`sites/reddit/content.ts:61-102`'s `buildPostContent()`. `content.ts:39-42`
admits it in a comment.

It is unreachable: `reload.ts:139` calls `fetchArticleContent()`, which
(`aggregator.ts:696-706`) returns `buildPostContent()`'s **HTML** — never JSON —
and `extractContent()` only enters the branch for a string starting with
`{`/`[`. The covering test is named "…**legacy** JSON locale"
(`aggregator.test.ts:419`).

**It has already drifted three ways** from the live copy — no Giphy handling, no
`mediaInfo.e === "Image"` gallery guard, and a different `is_gallery`
short-circuit — which is the argument for deleting rather than keeping it.

**YouTube (27 lines).** `youtube/aggregator.ts:396-422`, same shape:
`fetchArticleContent()` (`:375`) returns `snippet.description`, a plain string,
so `trimmed.startsWith("{")` is unreachable. The reload path is served entirely
by the `_last_reloaded_video` branch above it (`:382-394`).

- [x] **Step 1:** Confirm unreachability by instrumenting both branches and
      running the full suite plus a real aggregation and reload against each
      site. **Do not delete on the argument alone** — these are the two largest
      deletions in the plan.
- [x] **Step 2:** Delete both branches and their tests.

---

### Task 4: Small proven-dead removals

- [x] **`website.ts:108,120`** — `options.contentSelectors` /
      `options.ignoreSelectors` camelCase aliases. No spec declares them, and
      `schemaFor().strip()` + `stripUnavailable()` guarantee they can never be
      present. Only survive because `options` is `Record<string, unknown>`.
- [x] **`http/fetcher.ts:77-81`** — a `try/catch` whose two arms both
      `throw err`. The entire block is a no-op.
- [x] **`http/fetcher.ts:167-181`** — the `else` branch sets `lastException`,
      backs off and `continue`s, then falls through to `throw err`, which the
      outer catch at `:186` handles with *identical* logic. Replace the whole
      `if/else` with a bare `throw err`; ~14 lines.
- [x] **`images/store.ts:31-36,120-124`** — `ImageHashCollisionError` fires when
      a hash matches but `byteSize` differs. Equal SHA-256 implies equal bytes
      implies equal length, so it is unreachable short of a genuine collision.
      It also throws out of `storeImageBytes` into callers that do not expect
      throws (`storeImageRefFromUrl` has no catch).
- [x] **`header/strategies.ts:68-75`** — delete `RedditEmbedStrategy`. Its
      `create()` does nothing but call `new GenericImageStrategy().create(context)`
      in a bare `catch { return null }`. Since `GenericImageStrategy.canHandle`
      (`:147-152`) returns `false` only for non-embed `v.redd.it` URLs, every URL
      `RedditEmbedStrategy` accepts is also accepted by `GenericImageStrategy` at
      position 4 — so a failing reddit-embed URL **runs the entire generic
      pipeline twice** (page fetch, five strategies, up to 20 candidate image
      fetches), and emits the "could not extract an image" warning twice per
      article. Its bare `catch` also **swallows `ArticleSkipError`**, which
      `GenericImageStrategy` deliberately rethrows (`:173`) and the extractor's
      contract requires (`extractor.test.ts:187`).
- [x] **`parser.ts:208`** — `getAttr` lowercases an attribute name every call
      site already passes lowercase.
- [x] **`parser.ts:219,721`** — `child.type === "text" && !isNonTextString(child)`;
      `isNonTextString` can never be true when `type === "text"`.

---

### Task 5: Table-drive the per-site declaration boilerplate (~90 lines)

Every site repeats the same five declarations, three of which are **the same
value written twice**:

```ts
static brandSiteUrl = "https://x/";                 // (1)
static getDefaultIdentifier() { return "…/feed"; }  // (2)
static contentSelectors  = [...];  protected contentSelectors  = [...X.contentSelectors];
static selectorsToRemove = [...];  protected selectorsToRemove = [...X.selectorsToRemove];
constructor(feed) { super(feed); if (!this.identifier) this.identifier = "…/feed"; }  // (2) again
override getSourceUrl() { return "https://x"; }     // (1) again, minus a trailing slash
```

Present in all of `ars_technica.ts`, `the_verge.ts`, `caschys_blog.ts`,
`dark_legacy.ts`, `explosm.ts`, `heise.ts`, `merkur.ts`, `oglaf.ts`,
`mactechnews/aggregator.ts`, `mein_mmo/aggregator.ts`,
`tagesschau/aggregator.ts`.

Two latent drift bugs live here: the constructor's identifier literal can
diverge from `getDefaultIdentifier()` with nothing checking, and `brandSiteUrl`
vs `getSourceUrl()` **already differ by a trailing slash on 8 of 11 sites** for
no stated reason.

`ars_technica.ts` and `the_verge.ts` are *pure* declaration — 43 and 50 lines of
zero behaviour — which is the proof the table-driven form is viable.

Note the abstraction already exists and works: `extract/content.ts`'s
`extractMainContent(html, contentSelectors, removeSelectors, firstMatchOnly)`.
The problem is that it is expressed as class inheritance rather than data.

- [x] **Step 1:** Introduce `defineSite({ base, siteUrl, defaultFeed, feeds,
      content, remove, firstMatchOnly })`, deriving the constructor default from
      `defaultFeed`, `getSourceUrl()` from `siteUrl`, and both selector pairs
      from one list.
- [x] **Step 2:** Convert the two pure-declaration sites first as the proof.
- [x] **Step 3:** Convert the rest, keeping their genuine behaviour overrides.
- [x] **Step 4:** Resolve the trailing-slash divergence one way and record it.
      *Moot: Task 2 deleted `brandSiteUrl` (and `getDefaultIdentifier()`) as dead
      code, so the divergence was resolved by deletion rather than by a choice
      made here. `getSourceUrl()` is the only survivor and each site's string is
      carried verbatim — normalising it would be a behaviour change.*

---

### Task 6: Collapse the remaining mechanical repetition (~180 lines)

- [x] **Comic aggregators (~75).** `explosm.ts:66-116`, `dark_legacy.ts:60-113`,
      `oglaf.ts:75-126` all do: find the comic `<img>` → absolutise → `isSafeUrl`
      → `storeImageRefFromUrl` → emit `<img>` + optional italic caption. The
      caption's inline style `font-style: italic; margin-top: 1em; color: #666`
      is verbatim in all three, and `COMIC_MAX_DIMENSIONS = {1600,4800}` is
      declared twice (`oglaf.ts:13`, `dark_legacy.ts:12`).
- [x] **Relative-URL resolution (~55).** `caschys_blog.ts:84-119` and
      `mactechnews/aggregator.ts:159-194` are **identical apart from two comment
      strings** — 36 lines each. Partial copies at `dark_legacy.ts:76-87` and
      `heise.ts:62-63,74-80,117-122`. One `absolutizeUrls($, baseUrl)` in
      `extract/clean.ts` collapses all of it; `oglaf.ts:91-95`'s bespoke CDN rule
      can stay the only site-specific one.
- [x] **Whitespace-trim block (~36).** `merkur.ts:131-148` and
      `heise.ts:347-364` are byte-identical; `caschys_blog.ts:219-236` is the
      same restricted to `p`. Move beside `removeEmptyElements()` in
      `extract/clean.ts`.
- [x] **`extractHeaderElement() → null` ×5 (~12).** `oglaf.ts:71-73`,
      `explosm.ts:62-64`, `dark_legacy.ts:56-58`,
      `youtube/aggregator.ts:353-355`, `reddit/aggregator.ts:903-905`, each with
      a comment cross-referencing the others. Replace with a
      `static suppressesHeaderExtraction = true` read once in
      `BaseAggregator.extractHeaderElement()`.
- [x] **`parser.ts` embed builders ×3.** `videoEmbed:303`, `audioEmbed:321`,
      `iframeEmbed:339`. The first two differ **only** in a `provider` literal;
      the third only in not looking for a nested `<source>`.
- [x] **`parser.ts` recoverable-media loop ×3.** `:506-511`, `:830-836`,
      `:851-857` — identical bodies, differing only in destination.
- [x] **Reconcile the three tag drop-lists.** `clean.ts:196` drops
      `script/style/iframe/object/embed`; `parser.ts:47-60` drops
      `script/style/iframe/form/input/button/select/textarea/noscript/audio/svg/canvas`;
      `content.ts:8` drops `script/style/noscript/template`. Three answers to
      "what is never article content", and `template` appears in only one.
- [x] **`clean.ts` call-site pair ×6.** `cleanHtml(...)` →
      `sanitizeHtmlAttributes($)` → `removeSanitizedAttributes($)` is repeated at
      `heise.ts:28`, `podcast.ts:21`, `mein_mmo/comments.ts:16`,
      `mactechnews/comments.ts:16`, `youtube/aggregator.ts:49`,
      `reddit/markdown.ts:376` — two full DOM walks where the second undoes the
      first's renames. Plan 3 Task 1 may already have absorbed this; check
      before redoing it.

---

### Task 7: Hardening (deliberate behaviour changes)

These are **not** cleanup. Each changes behaviour on purpose.

- [x] **7a. Two image routes disagree about ownership.**
      `src/app/api/v1/images/[hash]/route.ts` does `requireApiUser()` **plus** a
      three-path ownership check. `src/app/media/images/[hash]/route.ts:22`
      does `await requireUser()` and **nothing else** — any signed-in user who
      knows a hash reads any other user's article image. Both serve the same
      bytes. Decide whether `/media/images/` is a leftover and delete it, or give
      it the same ownership check. Guessing a SHA-256 is infeasible, but hashes
      are readable by anyone who can see a shared article's blocks.

- [x] **7b. Small SVGs are served verbatim, same-origin.** `store.ts` accepts
      `image/svg+xml` (`fetcher.ts:15`, `store.ts:25`), and `compressImage`
      (`compression.ts:40-58`) **skips re-encoding entirely below
      `MIN_IMAGE_SIZE`**, storing the original bytes and content type.
      `/media/images/[hash]:50` then serves them as `image/svg+xml` with
      `nosniff` — which does not help, the declared type *is* SVG — and no CSP or
      `Content-Disposition`. A sub-5 KB SVG carrying `<script>` in a source
      article's `og:image` is an active document on the app's own origin.
      This is exactly what `CLAUDE.md` says re-encoding exists to prevent for
      avatars, and this path handles *attacker-supplied remote* content rather
      than an admin-created user's own upload. Either refuse SVG, or always
      re-encode, or serve with `Content-Disposition: attachment` + a restrictive
      CSP. Same passthrough also lands sub-5 KB BMP/TIFF/APNG as `.bin`.

- [x] **7c. `compressImage` has no decompression-bomb limits.**
      `images/compression.ts:64` calls `sharp(imageData)` with **neither
      `limitInputPixels` nor `.timeout()`**, while `avatar-storage.ts:134-135`
      sets both and `CLAUDE.md` explains at length that "a byte cap on the upload
      does not bound either". The image path accepts up to **64 MB** from an
      arbitrary remote host — a strictly larger surface than the 2 MB avatar path
      that got the hardening. Apply the same two limits.

- [x] **7d. The two HTTP fetchers export the same names with different values.**

      | | `images/fetcher.ts` | `http/fetcher.ts` |
      |---|---|---|
      | `USER_AGENT` | `Mozilla/5.0 … Chrome/122` (`:5`) | `Mozilla/5.0 (compatible; YanaBot/1.0; …)` (`:1`) |
      | `MAX_FETCH_BYTES` | `64 MB` (`:4`) | `2 MB` (`:4`) |
      | timeout | 10 s | 30 s |
      | retries | none | 3, exponential |
      | redirects | `follow`, unbounded (`:98`) | `manual`, ≤5, optional allow-list |
      | size enforcement | buffer whole body then check (`:124`) | streaming cap (`readCapped`) |

      Two hazards: an import auto-completed from the wrong module is a silent
      32-fold change in the byte cap with nothing failing a typecheck; and
      `images/fetcher.ts` buffers the **entire** response before enforcing 64 MB,
      so a server ignoring `Content-Length` costs 64 MB of RSS per in-flight
      image (default `feeds.concurrency` 4 × `WORKER_CONCURRENCY` 4 ≈ 1 GB worst
      case). It also follows redirects unboundedly with no allow-list, where
      `fetchBinary` has both — and image URLs come from the source page, so they
      are attacker-controlled. Rename the constants apart at minimum; better,
      have `images/fetcher.ts` use `readCapped` and bounded redirects.

- [x] **7e. The fetch timeout does not cover the response body.**
      `http/fetcher.ts:147-156` clears the timer as soon as **headers** arrive;
      `readCapped()` (`:183`) then drains the body with no deadline. A server
      that sends headers and stalls blocks forever — and the worker's budget
      timer only *requests* cooperative cancellation (`worker.ts:145-164`), with
      no checkpoint inside a fetch, so with `WORKER_CONCURRENCY = 4` four such
      feeds permanently deadlock all background work. Move `clearTimeout` below
      the `readCapped` call; the signal is already wired to the body stream.
      Same in `fetchBinary` (`:239-249` vs `:274`) — where the timer is also
      re-created per redirect hop, making the real worst case 6× the configured
      timeout.

- [x] **7f. `getJob()`/`listJobs()` take the write lock for reads.**
      `queue.ts:551-555` and `:578-637` wrap pure `SELECT`s in
      `writeTransaction()`, i.e. `BEGIN IMMEDIATE`. Every `/jobs` page load
      contends with four worker loops and every `progress()`/`appendLogLine()`
      write, and `listJobs` runs a `LEFT JOIN` + `COUNT(*)` under it. This is
      the cost `claim()`'s read-only pre-check (`:48-66`) was added to eliminate
      — the same module fixes it in one place and reintroduces it in two.
      Neither has a read-then-write to make atomic; use plain `getDb()` reads.

- [x] **7g. `store.ts:146-156` writes outside `writeTransaction()`.** A raw
      autocommit `getDb().insert(articleImages)…run()`, which `CLAUDE.md` permits
      only as a ratified, documented exception. It pairs with a read at `:113` as
      a check-then-act, and the `catch {}` at `:157` absorbs the unique-index
      race **and every other insert failure** — after which the function still
      returns a hash for a file with no row, which is unservable. Either
      document it as an exception with the same rigour as the Better Auth one,
      or move it into a transaction.

---

### Task 8: Small verified bugs found adjacent to the above

- [x] **8a. Scraped HTML used as a `String.replace` replacement.**
      `extract/format.ts:71`:
      `return facade.replace("</div>", `${caption}</div>`)`. `caption` is
      `headerCaptionHtml`, scraped from the page, and `$&`, `` $` ``, `$'`, `$1`
      in a **replacement string** are substitution patterns. Demonstrated:
      `caption = "<p>Cost: $100 &amp; $& more</p>"` produces
      `<div …>x<p>Cost: $100 &amp; </div> more</p></div>` — structure destroyed.
      Use a function replacement or plain concatenation.
- [x] **8b. `youtube/aggregator.ts:314`** emits `&lc=` unescaped inside an `href`
      attribute; should be `&amp;lc=`.
- [x] **8c. `heise.ts:268-278`** — a `try/catch` wrapping only
      `String.prototype.includes` and template concatenation. Unreachable catch,
      misleading.
- [x] **8d. `dailymotion.ts:122-125`'s `localizeThumbnail` warns on nothing**,
      where `youtube.ts:170-173` emits an explicit warning for the identical
      failure and explains why silence was the bug. Same name, same module
      family, opposite behaviour.
- [x] **8e. Tracking-pixel rejection is conditional on compression having run.**
      `store.ts:102-109` only fires when `width`/`height` are non-null, which
      requires `compressImage` to have succeeded. With `compress: false` or a
      sharp failure, a 1×1 pixel is stored. Latent — no current caller passes
      `compress: false`.
- [x] **8f. `{ isHeader: true }` on embed thumbnails** (`dailymotion.ts:123`,
      `twitter.ts:135`, `bluesky.ts:170`) sizes them 1200×1200 rather than the
      600×600 body limit, so every tweet's first photo is stored at header
      resolution. Probably deliberate; confirm and document, or fix.
- [x] **8g. `scheduler.ts:37-55`** — two verbatim copies of the same
      `console.error` + `notifyAdmins` block. Hoist.
- [x] **8h. Three hand-rolled `tx.insert(jobs)` sites** in
      `src/lib/feeds/actions.ts:309-315,557-566,795-797` bypass `enqueue()` and
      will not pick up any future enqueue-side logic. They are already the reason
      `feed.update` drifted from `aggregate` (plan 1, Task 3).
- [x] **8i. `handlers/update.ts`** is a 6-line file whose entire body is
      `await handleAggregateJob(job)`. Register `handleAggregateJob` under
      `"feed.update"` directly and delete the file — and reconsider whether the
      alias kind should exist at all.
- [x] **8j. `worker.ts:137-141`** retries an unregistered job kind three times.
      A missing handler is deterministic; fail it immediately.
- [x] **8k. `store.ts:53`** builds `new RegExp(IMAGE_REF_PATTERN)` per call to
      dodge shared `lastIndex`. Correct, but the comment says "reset regex
      lastIndex" while the code clones. `matchAll` is 3 lines instead of 10.
- [x] **8l. `bounds.ts:55-56`** justifies a `maxRetries` ceiling of 10 as
      "already an hour of `retryDelay`", but the un-configurable 60 s
      `maxRetryTime` (`run.ts:132`) cuts every schedule off well before that.
      The stated reason does not describe shipped behaviour. Fix the bound or
      the comment.

---

---

### Task 9: Harden the two remaining unbounded fetch sites (added 2026-09-04)

Added during execution, on the Task 7c-7g review's finding. Task 7d/7e hardened
`images/fetcher.ts` and `http/fetcher.ts`; **three other fetch sites were left
with the same defects**, and one of them is now the worst fetch in the tree.
Ticking 7e as done while it stands invites the reading that the class is closed.

- [x] **`ImageExtractor.fetchAndParsePage()`** (`src/lib/aggregators/images/extractor.ts`)
      — rated **High** residual risk. It has **no size cap at all**, no body
      deadline (its timer is cleared before `res.text()`), and
      `redirect: "follow"`, on a URL taken from a source page — i.e.
      attacker-influenced. Strictly worse than either defect 7d/7e just fixed,
      and Task 7e's own rationale still applies verbatim: a server that sends
      headers then stalls blocks a worker forever, and with
      `WORKER_CONCURRENCY = 4` four such feeds deadlock all background work.
      Give it `readCapped`, a body-covering deadline and bounded redirects, the
      same treatment 7d/7e applied.
- [x] **`fetchTweetData()`** (`src/lib/aggregators/images/strategies.ts`) — same
      shape (timer cleared before `res.json()`), rated **Low**: fixed host,
      digit-validated path segment, no attacker-chosen origin. Fix for
      consistency, not urgency.
- [x] **A tripwire, not just two fixes.** Both this task and 7a/7b closed a
      "several call sites must each remember the same precaution" defect by
      hand. Consider one specifier test asserting every `fetch(` in
      `src/lib/aggregators/**` goes through a capped helper — the same shape as
      this repo's existing dependency-free-module tripwires. Decide and record;
      do not build it if the sites are few enough that the test is the harder
      thing to maintain.
      **Decided: built, for the deadline half only.**
      `src/lib/aggregators/http/fetch-deadline.test.ts` scans every `.ts` under
      `src/lib/aggregators/**` and asserts that every `fetch(` call site's own
      init object passes a `signal`. The sites are *not* few (seventeen), and
      two of the four this task fixed carried no deadline whatsoever -- so the
      recurrence argument won. The size-cap half was **declined**: the read
      that needs capping can be any distance from the `fetch()`, behind a
      helper, or legitimately absent, so a regex would pass a file where only
      one of two fetches is capped (`embeds/bluesky.ts`'s shape) or fail on
      correct code. That half stays a review obligation, named in
      `readCapped()`'s doc comment. The *placement* defect that recurred four
      times is now structural rather than checked: `withDeadline()` owns the
      timer, so a caller cannot disarm it above the body read -- **for the four
      callers converted here.** `fetchHtml()`, `fetchBinary()` and
      `fetchImageOutcome()` still hand-roll a controller and a timer, and they
      are the three sites that already made that mistake once, so 7d/7e's
      `finally` blocks are all that hold it for them. The tripwire itself
      checks the *presence of the token*, not a live deadline:
      `signal: new AbortController().signal` with nothing ever aborting it
      satisfies it, and no textual check can tell otherwise. Its argument text
      is sliced from the comment/string-blanked copy of the source, not the
      raw source -- read raw, a `// no signal needed, fixed host` inside the
      init turned the check green, which is worse than no check; four negative
      controls in the test pin that.
- [x] **Residual, recorded not fixed: twelve uncapped fetch sites.** Nine have
      an honest body-covering deadline (`AbortSignal.timeout(...)`, never
      disarmed) and only lack a size cap: `search.ts` x3, the five
      `sites/reddit/` reads, `embeds/bluesky.ts` x2. Three more are in
      **`src/lib/feeds/logo.ts`**, outside the tripwire's scan directory and on
      the worker-executed `feed.logo` path: its three hand-rolled controller +
      timer pairs are *not* a fifth instance of this task's defect (all three
      `clearTimeout`s are in `finally` blocks below their body reads) but all
      three read bodies uncapped -- `response.arrayBuffer()` then measure,
      which is exactly the "buffered before it is measured" hazard 7e fixed,
      plus a bare `res.text()` and a bare `res.json()`. Left for a later task;
      the fix is one `readCapped*` call per site.

## Done criteria

- [ ] Every deletion's dead-ness proven by grep and recorded in its commit
      message.
- [ ] Task 3's two branches confirmed unreachable by instrumentation, not
      argument.
- [ ] Task 7's behaviour changes each covered by a test.
- [ ] Four CI checks green; the 35 pre-existing lint warnings reduced, not
      increased.
- [ ] `CLAUDE.md` updated: remove the bullets describing the deleted aggregator
      configuration API and the embed registry, and add the image-route and
      SVG decisions from Task 7.
