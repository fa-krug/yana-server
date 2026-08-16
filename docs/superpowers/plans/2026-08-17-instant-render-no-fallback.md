# Instant Render (No Fallback) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Every page renders immediately with no route-level fallback at all; data arrives afterwards.

**Architecture:** A page function that `await`s nothing cannot suspend, so Next never shows a `loading.tsx` for it — the file is deleted rather than rewritten. Three awaits must leave every page body: `getTranslations()` (replaced by a per-page client title component with a *literal* namespace), the auth gates (`requireUser`/`requireAdmin`/`requireUserFreshRole`, which move **into the data layer**), and the deciding record read on detail routes (which the user has explicitly chosen to give up, along with real 404s). Data continues to be fetched **on the server** and streamed via the already-built promise-passing pattern — this is not a move to client-side fetching, so no request waterfall is introduced.

**Tech Stack:** Next 16.2.12, React 19.2.4, TypeScript 5.9.3, next-intl 4.x, Vitest 4.1.10.

**Spec:** None separate. This plan supersedes parts of `2026-08-16-streaming-controls-migration.md` (same branch), which built the promise-passing pattern this one completes.

## The user decision this plan implements

The user was shown the trade-off explicitly and chose **"Instant everywhere, lose real 404s"** over keeping 404s on detail routes. So:

- `/feeds/[id]`, `/tags/[id]`, `/users/[id]`, `/articles/[id]` **stop returning 404** for an unknown or unowned id. They return 200 and render a not-found state once the record resolves.
- The four `page.test.ts` 404 guards added last week are **obsolete and must be rewritten**, not deleted silently — they become tests that the page renders a not-found state.
- `requireAdmin()` no longer answers 404 from the page body on `/users*`, so those routes no longer hide their existence from a non-admin.

Do not re-litigate this. It was raised as a concern, and reaffirmed.

## Global Constraints

- **Line length 100, double quotes, semicolons, trailing commas.** Prettier owns formatting.
- **All four must pass:** `npm run lint && npm run format:check && npm run typecheck && npm test`.
- **Every user-facing string from `messages/en.json` + `messages/de.json`**, identical non-empty key sets. Read the catalogs; never guess a label.
- **No cast at a `t()` call site.** This is why title components take a *literal* namespace each rather than a generic one — a generic `<PageTitle>` was already tried and rejected for exactly this reason.
- **A pending control uses `disabled` and omits `value`** — never `defaultValue`, never `value=""` on a Base UI `<Select>` (`""` is a real value: `/ai`'s "None (disabled)"). `items` is required on `<Select>`.
- **Server action calls stay behind `attempt()`.**
- **A Server Component may not pass a function prop to a Client Component** (cold-start-only crash; tripwire `src/app/server-component-props.test.ts`).
- **A promise handed to a Client Component is serialized whole.** Narrow it on the server — pass a projection, never a row. This branch already shipped a plaintext-credential leak from getting this wrong; see `getSettingsSummary()` in `src/lib/settings/queries.ts` for the shape.

## THE SECURITY INVARIANT — read before Task 1

**Authorization currently lives in page bodies. This plan removes it from there. If it does not land somewhere else in the same commit, admin-only data becomes world-readable.**

Today `requireAdmin()` is the first statement of `/users`, `/users/new` and `/users/[id]`, and `requireUserFreshRole()` gates `/jobs`, `/jobs/[id]` and the log-stream route. Those are the real gates, not decoration.

**Every task that removes a gate from a page body MUST add an equivalent gate inside the data functions that page calls**, in the same commit:

- `listUsers()`, `getUser()`, and every user-mutating action → `requireAdmin()` internally.
- Job reads → `requireUserFreshRole()` internally, preserving the existing rule that a non-admin sees only `jobs.userId = user.id` and an admin sees every row including ownerless ones.
- `src/app/(app)/layout.tsx` keeps its `await requireUser()`. It is the authentication gate for the whole group and is **out of scope** — do not touch it. It is also why an unauthenticated request never reaches these pages at all.

A page rendering instantly is not permission to render data the caller may not see. **The shell may render before authorization resolves; the data may not.**

---

### Task 1: Per-page title components, and prove one page renders with zero awaits

**Files:** `src/components/settings/settings-title.tsx` (+ test), `src/app/(app)/settings/page.tsx`, delete `src/app/(app)/settings/loading.tsx` and its test.

- [ ] **Step 1:** Write a failing test asserting `SettingsPage()` is callable and its result renders the title without any awaited translation — i.e. the page function returns JSX synchronously. Assert `typeof SettingsPage(...)` is not a promise, or that the returned element tree contains `<SettingsTitle />`.
- [ ] **Step 2:** Run it; confirm it fails.
- [ ] **Step 3:** Create `settings-title.tsx` — `"use client"`, `useTranslations("settings")` with a **literal** namespace, rendering `<h1 className="text-2xl font-semibold">{t("title")}</h1>`. No generics, no cast.
- [ ] **Step 4:** Rewrite `settings/page.tsx` to a **non-async** function: no `getTranslations`, no `await`. Keep `connection()` **only if** the page still reaches the database — if it does, call it without blocking the shell (see Task 2's ruling on `connection()`); if the page body no longer touches SQLite because every read is a promise created inside a child, say so in the report and remove it.
- [ ] **Step 5:** Run the test; confirm it passes.
- [ ] **Step 6:** Delete `src/app/(app)/settings/loading.tsx` and `loading.test.tsx`. The page cannot suspend, so the file is unreachable.
- [ ] **Step 7:** Verify in a browser under throttling: `/settings` paints its heading, both section headings, all labels, both selects, the retention input, Save and the About section with **no fallback frame at all**. Report what you saw.
- [ ] **Step 8:** `npm run lint && npm run format:check && npm run typecheck && npm test`, then commit.

### Task 2: Settle `connection()` and prerendering, once, for every route

**Files:** `next.config.ts` or per-route, `src/app/(app)/**/page.tsx`, `CLAUDE.md`.

`await connection()` is itself an await. It performs no I/O, but it opts the route out of prerendering, and without it `next build` can bake a page against a `data/` directory that does not exist on the build machine.

- [ ] **Step 1:** Determine empirically whether a page whose only await is `connection()` shows a fallback. Delete `data/`, run `npm run build`, and check both that the build succeeds and that `data/` is not recreated.
- [ ] **Step 2:** Decide and document one rule for the whole app: either every page keeps `connection()` (and we accept that one microtask-scale await), or routes are opted out another way. **Whatever you choose, `rm -rf data/ && npm run build && ls data/` must still report no such directory.** That check is the invariant, not the mechanism.
- [ ] **Step 3:** Apply it to every route, update the `connection()` bullet in `CLAUDE.md`, commit.

### Task 3: Move authorization out of page bodies and into the data layer

**This is the security task. It gates every later task.**

**Files:** `src/lib/users/queries.ts`, `src/lib/users/actions.ts`, `src/lib/jobs/queries.ts` (or equivalent), `src/app/(app)/users/**`, `src/app/(app)/jobs/**`, plus tests.

- [ ] **Step 1:** Write failing tests first: a non-admin calling `listUsers()`/`getUser()` directly must be refused; a non-admin calling a user-mutating action must be refused; a non-admin's job read must return only their own rows. Use the repo's real-database test style (`src/lib/db/test-support.ts`), and sign in for real via `signInCookie()` (`src/lib/auth/test-support.ts`) rather than stubbing the derivation.
- [ ] **Step 2:** Run them; confirm they fail (today the functions are unguarded because the page guarded them).
- [ ] **Step 3:** Add `requireAdmin()` inside the user queries/actions and `requireUserFreshRole()` inside the job reads. Keep `requireAdmin()`'s `disableCookieCache: true` semantics — an admin demoted a minute ago must not pass. Keep the ownerless-job rule: `jobs.userId IS NULL` rows are visible to admins only, and a non-admin who owns nothing sees an empty list.
- [ ] **Step 4:** Run the tests; confirm they pass.
- [ ] **Step 5:** Only now remove the gates from the page bodies and make those pages non-async.
- [ ] **Step 6:** Re-run the tests. **Then verify by hand:** sign in as a non-admin and request `/users` and `/api`-adjacent user data; confirm no user data is returned. Report exactly what you did and what came back. This step is the whole point of the task.
- [ ] **Step 7:** Delete the now-unreachable `loading.tsx` files for these routes, run all four checks, commit.

### Task 4: Detail routes — instant render, not-found state instead of 404

**Files:** the four `[id]/page.tsx`, their `loading.tsx` (delete), their `page.test.ts` (rewrite).

- [ ] **Step 1:** Rewrite the four `page.test.ts` files. They currently assert `rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/)`. That behaviour is being deliberately removed, so the tests must now assert the page renders a not-found state for an unknown id. **Do not delete them** — a route that silently renders nothing for a bad id is worse than one that 404s.
- [ ] **Step 2:** Run; confirm they fail.
- [ ] **Step 3:** Make each page non-async: the record becomes a promise passed to the client component, which renders the form when it resolves and a not-found message when it resolves empty. Add the catalog keys to **both** `en.json` and `de.json`.
- [ ] **Step 4:** Ownership still matters: a record belonging to another user must render the same not-found state as a nonexistent one — never that user's data, and never a message distinguishing the two. Verify the query still scopes by owner.
- [ ] **Step 5:** Run tests; delete the four `loading.tsx`; run all four checks; commit.

### Task 5: The remaining pages, and remove every surviving `loading.tsx`

**Files:** `/account`, `/integrations`, `/ai`, dashboard, `/feeds`, `/articles`, `/tags`, `/users`, `/jobs`, the three `/new` routes.

- [ ] **Step 1:** Give each a per-page title component (literal namespace) and make the page body non-async.
- [ ] **Step 2:** The dashboard's `<SectionCards isAdmin>` now has no fresh-role read in the page body. Move that decision into a component fed by a promise, so the shell renders instantly and the admin-only cards appear when the role resolves. **Do not weaken the fresh-role rule** — the role must still be read with `disableCookieCache: true`.
- [ ] **Step 3:** Delete every remaining `src/app/(app)/**/loading.tsx` and its test. Then `find src/app -name "loading.tsx"` must return nothing.
- [ ] **Step 4:** Verify each route in a browser under throttling. Report per route whether any fallback frame or layout jump remains.
- [ ] **Step 5:** All four checks; `rm -rf data/ && npm run build && ls data/` still reports no such directory; commit.

### Task 6: Rewrite the convention in `CLAUDE.md`

- [ ] **Step 1:** Replace the streaming-controls bullet. The new rule: a page body awaits nothing and therefore has no `loading.tsx`; data is fetched on the server and streamed via promise-passing; the `<Suspense>` fallback is the real form in a `pending` state.
- [ ] **Step 2:** Record what was **given up and why**: detail routes no longer answer 404, and admin-only routes no longer hide their existence, because the user chose instant render over both. State that authorization now lives in the data layer and that a page rendering instantly is not permission to render data the caller may not see.
- [ ] **Step 3:** Record that a per-page title component with a literal namespace is the way to keep catalog keys compiler-checked — and that a *generic* `<PageTitle>` was tried twice and rejected both times.
- [ ] **Step 4:** All four checks; commit.
