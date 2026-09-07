# Streaming Controls Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every page render its real chrome and its real controls immediately, with only the data *values* arriving later — replacing today's whole-page and whole-control skeleton fallbacks.

**Architecture:** Three mechanical moves, applied per route. (1) The page stops `await`ing its query and passes the *promise* to a client component. (2) The client component splits into a presentational form that accepts optional values plus a `pending` flag, and a thin resolver that calls React 19's `use(promise)` and renders that same form with real values. (3) The `<Suspense>` fallback becomes `<Form pending />` — the real control, disabled, no value — instead of a `<Skeleton>`. Because the fallback and the resolved render are the same component, the control never visually appears or disappears; only its value fills in. Pages additionally stop calling `getTranslations()` in the page body (a client `<PageTitle>` uses `useTranslations` instead), which is what stops the page function itself from suspending as one unit.

**Tech Stack:** Next 16.2.12 (App Router, RSC), React 19.2.4 (`use`, `Suspense`), TypeScript 5.9.3, next-intl 4.x, Vitest 4.1.10 (two projects — `.test.ts` node, `.test.tsx` jsdom).

**Spec:** This plan is its own spec; it originates from a defect report ("multiple skeleton placeholders instead of the normal fields, tables, selects during load") and the survey in the conversation that produced it. There is no separate design record.

## Global Constraints

Copied verbatim from `CLAUDE.md`; every task's requirements implicitly include these.

- **Line length 100, double quotes, semicolons, trailing commas.** Prettier owns formatting.
- **Before pushing, all four must pass:** `npm run lint && npm run format:check && npm run typecheck && npm test`. An unformatted file is a CI build failure, not a warning.
- **Every user-facing string comes from `messages/en.json` + `messages/de.json`**, which must define identical, non-empty key sets. The one accepted literal is the brand name "Yana".
- **Catalog keys are compiler-checked** via `AppConfig` in `src/i18n/next-intl.d.ts`. Never cast at a `t()` call site.
- **`await connection()` stays the first statement of every route that can reach the database**, ahead of everything else. This migration does not remove a single `connection()` call. Routes exempt because they already await a Dynamic API (`requireUser()`/`requireAdmin()`/`requireUserFreshRole()`) stay exempt.
- **Whatever decides the response *status* is awaited in the page body, never inside `<Suspense>`.** `notFound()`, `redirect()` and `forbidden()` can only set a status while the response is still open. This is why the edit/detail routes in Task 7 are only *partially* migrated — their record read must stay awaited at the top.
- **A `<Suspense fallback>` is a Server Component and may not be handed a function prop.** Passing `onSubmit={() => …}` from a file under `src/app/` throws `Event handlers cannot be passed to Client Component props` on a cold start only. The guard is `src/app/server-component-props.test.ts`, a specifier tripwire on `on[A-Z]…={` in non-client files under `src/app/`. **In this migration every fallback is authored inside a `"use client"` component instead, which sidesteps the rule entirely** — but the tripwire must stay green.
- **No server action is ever awaited bare from a client component.** Every call goes through `attempt()`. This migration changes no action call site.
- **Base UI, not Radix:** compose with `render`, never `asChild`. `items` is a *required* prop on this repo's `<Select>`.
- **Driving a Base UI Select from jsdom takes `pointerDown` + `pointerUp` + `click` on the item**, not a bare `click`. Reuse the existing `pick()` helper in `src/components/settings/general-section.test.tsx:39`.
- **The file extension picks the vitest project:** `.test.tsx` → jsdom, `.test.ts` → node. A component test must be `.tsx`.
- **`async` server components cannot be rendered by testing-library.** Do not reshape production code to make them testable; test the client components instead.

## Correction issued during execution (supersedes the task text below)

**Every route KEEPS its `loading.tsx`. Do not delete any of them.** Several tasks
below say "Delete: `…/loading.tsx`" and one says `git rm`. That instruction is
withdrawn — it rested on "the page no longer suspends as a unit", which stopped
being true when `<PageTitle>` was dropped (`await getTranslations()` stayed in the
page body), and it missed a larger point: `loading.tsx` is also what Next renders
during a **client-side soft navigation**, while the new segment's RSC payload crosses
the network. That latency is real and server-side streaming cannot remove it. A
deleted `loading.tsx` falls through to `(app)/loading.tsx`'s generic `TableSkeleton`
— the exact defect this migration exists to remove, on the most common path to
every page.

Instead, **rewrite each route's `loading.tsx` to render the real form chassis in its
pending state** — the same `…Form pending` components the page's own `<Suspense>`
fallback uses, plus any genuinely static section (e.g. `<AboutSection>`) rendered for
real. Wherever a task below says "delete `loading.tsx`", read it as "rewrite
`loading.tsx` to `…Form pending`". Task 6's three `/new` routes GAIN one for the same
reason. Task 8's audit is scoped accordingly: it retires unused `…Shell` exports, not
route fallbacks.

---

## Design Reference

Every task below is an instance of this one pattern. Read it once; the tasks then only name the files.

**Before** (`src/components/settings/library-section.tsx`, and every section like it):

```tsx
export function LibrarySection({ articleRetentionDays }: { articleRetentionDays: number }) {
  const [retention, setRetention] = useState(String(articleRetentionDays));
  // … renders <LibrarySectionShell retentionControl={<Input value={retention} …/>} />
}
```

with the page doing `const settings = await getSettings()` above its JSX and a
`<Suspense fallback={<LibrarySectionShell retentionControl={<Skeleton/>} …/>}>`.

**After** — three exports from the same file:

```tsx
/** The presentational form. `value === undefined` means "not loaded yet". */
export function LibrarySectionForm({
  articleRetentionDays,
  pending = false,
}: {
  articleRetentionDays?: number;
  pending?: boolean;
}) { … }

/** Calls use(); suspends until the promise resolves; renders the form for real. */
function LibrarySectionResolved({ promise }: { promise: Promise<{ articleRetentionDays: number }> }) {
  const settings = use(promise);
  return <LibrarySectionForm articleRetentionDays={settings.articleRetentionDays} />;
}

/** What the page renders. The fallback is the real form, in its pending state. */
export function LibrarySection({ promise }: { promise: Promise<{ articleRetentionDays: number }> }) {
  return (
    <Suspense fallback={<LibrarySectionForm pending />}>
      <LibrarySectionResolved promise={promise} />
    </Suspense>
  );
}
```

Four rules that make this correct rather than merely compiling:

1. **The `…Shell` split becomes redundant and is removed.** Its whole purpose was to let a Server Component fallback render chrome around `<Skeleton>` slots. The fallback is now `<…Form pending />` — the same component, so chrome cannot drift between the two states. Delete each `…Shell` export and its `ReactNode` control slots **only after** its last consumer (the route `loading.tsx`, the page's `SectionsFallback`) is gone.
2. **A pending control is `disabled`, renders no value, and carries no handler.** For a `<Select>` that means omitting `value` (Base UI then shows the placeholder/muted state) and passing `disabled`. For an `<Input>`, `value=""` plus `disabled` — never `defaultValue`, which would not update when the real value arrives. For a `<Button>`, `disabled`.
3. **Local state seeded from a prop must be keyed, not `useState(prop)`.** `useState` captures its argument once at mount. The fallback and the resolved render are *different mounts* (React remounts across a Suspense boundary resolution), so this happens to work here — but any component that keeps editing state seeded from the resolved value must be verified to show the resolved value, not the pending one. Every task's test asserts exactly this.
4. **A promise created in a Server Component and never awaited there must not be able to reject unobserved.** React attaches its own handler when serializing a promise to a Client Component, so the normal path is safe and the rejection surfaces in the client error boundary — the `(app)` group's `error.tsx`. Task 1 verifies this once, in a real browser, and the finding governs every later task.

## File Structure

| File | Responsibility after this migration |
| --- | --- |
| `src/components/page-title.tsx` | **New.** Client `<PageTitle titleKey namespace>` so a page body needs no `await getTranslations()` and therefore does not suspend. |
| `src/components/settings/general-section.tsx` | `GeneralSectionForm` / `GeneralSection`. `GeneralSectionShell` deleted. |
| `src/components/settings/library-section.tsx` | `LibrarySectionForm` / `LibrarySection`. `LibrarySectionShell` deleted. |
| `src/app/(app)/settings/page.tsx` | Passes `getSettings()` unawaited. No `SectionsFallback`, no `getTranslations`. |
| `src/app/(app)/settings/loading.tsx` | **Deleted** — the page no longer suspends as a unit. |
| `src/components/account/{profile,password,passkey,device}-section.tsx` | Same split, 4×. Shells deleted. |
| `src/app/(app)/account/{page,loading}.tsx` | Same; `loading.tsx` deleted. |
| `src/components/integrations/{youtube,reddit}-section.tsx`, `section-parts.tsx` | Same split, 2×. |
| `src/app/(app)/integrations/{page,loading}.tsx` | Same; `loading.tsx` deleted. |
| `src/components/ai/{provider,advanced}-section.tsx`, `section-parts.tsx` | Same split, 2×. |
| `src/app/(app)/ai/{page,loading}.tsx` | Same; `loading.tsx` deleted. |
| `src/app/(app)/page.tsx` | Dashboard: real stat-card frames + titles, only the numbers suspend. |
| `src/components/dashboard/*` | Stat card gains a `pending` state; `CardSkeleton` no longer used for whole cards. |
| `src/app/(app)/{feeds,tags,users}/new/page.tsx` | Promise-passing for their lookups; each gains a real `loading.tsx` (they have none today and fall through to the generic `TableSkeleton`). |
| `src/app/(app)/{feeds,tags,users,articles}/[id]/{page,loading}.tsx` | **Partial** — record read stays awaited (status decision); secondary lookups become promises; `loading.tsx` rewritten to the real form chassis. |
| `CLAUDE.md` | The streaming-pattern bullet rewritten to describe this pattern as the convention. |

---

### Task 1: The pattern, proved on `/settings`

The pilot. `/settings` is the smallest page with both a `<Select>` and an `<Input>`, so it exercises both pending shapes. **Every later task copies this task's outcome**, so do not proceed past its review with anything unresolved.

**Files:**
- Create: `src/components/page-title.tsx`
- Create: `src/components/page-title.test.tsx`
- Modify: `src/components/settings/general-section.tsx`
- Modify: `src/components/settings/library-section.tsx`
- Modify: `src/components/settings/general-section.test.tsx`
- Modify: `src/components/settings/library-section.test.tsx`
- Modify: `src/app/(app)/settings/page.tsx`
- Delete: `src/app/(app)/settings/loading.tsx`

**Interfaces:**
- Produces: `PageTitle({ namespace, titleKey }: { namespace: string; titleKey: string })` — a `"use client"` `<h1 className="text-2xl font-semibold">`.
- Produces: `GeneralSectionForm({ theme?, language?, pending? })`, `GeneralSection({ promise })` where `promise: Promise<{ theme: string; language: string }>`.
- Produces: `LibrarySectionForm({ articleRetentionDays?, pending? })`, `LibrarySection({ promise })` where `promise: Promise<{ articleRetentionDays: number }>`.
- Consumes: `getSettings()` from `@/lib/settings/queries` — called **without** `await`.

- [ ] **Step 1: Write the failing test for the pending state**

Add to `src/components/settings/library-section.test.tsx`:

```tsx
it("renders the real input and save button while the value is still loading", () => {
  // The defect this whole migration exists to fix: a loading section used to be
  // a grey bar where the field was. The field itself needs no data -- only its
  // value does -- so it must be on screen, disabled, from the first frame.
  renderWithProviders(<LibrarySectionForm pending />);

  const input = screen.getByLabelText("Keep articles for") as HTMLInputElement;
  expect(input.disabled).toBe(true);
  expect(input.value).toBe("");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  // The chrome the shell used to guarantee is still here, from the same component.
  expect(screen.getByText("Library")).toBeTruthy();
});

it("shows the resolved value once the promise settles", async () => {
  renderWithProviders(<LibrarySection promise={Promise.resolve({ articleRetentionDays: 60 })} />);

  // Pending first: real control, no value.
  expect((screen.getByLabelText("Keep articles for") as HTMLInputElement).value).toBe("");
  // Then the value fills in, with no skeleton in between.
  await waitFor(() =>
    expect((screen.getByLabelText("Keep articles for") as HTMLInputElement).value).toBe("60"),
  );
  expect((screen.getByLabelText("Keep articles for") as HTMLInputElement).disabled).toBe(false);
});
```

Import `LibrarySection` and `LibrarySectionForm` at the top of the file, and add `waitFor` to the `@testing-library/react` import.

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run src/components/settings/library-section.test.tsx`
Expected: FAIL — `LibrarySectionForm` is not exported (`SyntaxError` / `undefined` component).

- [ ] **Step 3: Split `library-section.tsx`**

Rewrite the module to the three-export shape in the Design Reference. Concretely: rename the existing `LibrarySection` to `LibrarySectionForm`, widen its prop to `articleRetentionDays?: number` and add `pending = false`; seed state with `useState(articleRetentionDays === undefined ? "" : String(articleRetentionDays))`; pass `disabled={pending}` to the `<Input>` and `disabled={pending || saving}` to the `<Button>`; inline the old `LibrarySectionShell` body into it and delete that export. Then add:

```tsx
function LibrarySectionResolved({ promise }: { promise: Promise<{ articleRetentionDays: number }> }) {
  const settings = use(promise);
  return <LibrarySectionForm articleRetentionDays={settings.articleRetentionDays} />;
}

export function LibrarySection({ promise }: { promise: Promise<{ articleRetentionDays: number }> }) {
  return (
    <Suspense fallback={<LibrarySectionForm pending />}>
      <LibrarySectionResolved promise={promise} />
    </Suspense>
  );
}
```

Add `Suspense` and `use` to the `react` import. Keep the existing `save()`/`attempt()` body exactly as it is — this task changes no action call.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/components/settings/library-section.test.tsx`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 5: Repeat Steps 1–4 for `general-section.tsx`**

Same split. Two specifics for this one, both load-bearing:
- The pending `<Select>` omits `value` entirely and passes `disabled` — it must **not** pass `value=""`, because `""` is a legal option value in this codebase and Base UI reads it as "nothing selected" in a way that interacts with `placeholder` (see the Base UI bullet in `CLAUDE.md`). `items` is still required on both.
- The two-store theme rule survives untouched: `themeValue` still prefers `useTheme()`'s applied value once hydrated and only falls back to the `theme` prop. With `theme === undefined` (pending) and not yet hydrated, the trigger shows the placeholder. Add a test asserting the existing localStorage-wins case still holds via `<GeneralSection promise={…}>`.

Add to `general-section.test.tsx`:

```tsx
it("renders both real selects while the values are still loading", () => {
  const { container } = renderWithProviders(<GeneralSectionForm pending />, { theme: "dark" });

  // Both triggers exist and are disabled -- not replaced by a bar.
  expect((container.querySelector("#theme") as HTMLButtonElement).disabled).toBe(true);
  expect((container.querySelector("#language") as HTMLButtonElement).disabled).toBe(true);
  // The labels the shell used to own are rendered by this same component now.
  expect(screen.getByText("Theme")).toBeTruthy();
});
```

- [ ] **Step 6: Add `<PageTitle>` and its test**

Create `src/components/page-title.tsx`:

```tsx
"use client";

import { useTranslations } from "next-intl";

/**
 * A page's <h1>, translated on the client.
 *
 * This exists so a page body needs no `await getTranslations()`. That single
 * await is what made an otherwise data-free page function suspend as one unit,
 * which is what put a whole-page fallback on screen -- the defect this
 * migration removes. next-intl's client hook reads the provider the root layout
 * already renders, so no data crosses the boundary for it.
 */
export function PageTitle({ namespace, titleKey }: { namespace: string; titleKey: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- namespace and key are
  // narrowed by each call site's literal arguments; see the note in this file's test.
  const t = useTranslations(namespace as any);
  return <h1 className="text-2xl font-semibold">{t(titleKey as any)}</h1>;
}
```

**Stop and reconsider before writing that `any`.** `CLAUDE.md` is explicit that a dynamic key must be typed narrowly *at its source* and that casting at a `t()` call site defeats the compiler check. If a generic `<PageTitle>` cannot be typed without a cast, **do not ship the cast** — instead drop this component and keep `await getTranslations()` in each page body, accepting that the page still suspends briefly on a cached read. Report which option you took in the task's completion notes; it changes Step 7 and every later task's page file.

- [ ] **Step 7: Rewrite `settings/page.tsx`**

```tsx
export default async function SettingsPage() {
  await connection();

  // Not awaited: the promise is handed to the client components, which render
  // their real controls immediately and fill in the values when it resolves.
  // Awaiting here is what made the whole page suspend behind one read.
  const settings = getSettings();

  return (
    <div className="max-w-2xl space-y-6">
      <PageTitle namespace="settings" titleKey="title" />
      <div className="space-y-8">
        <GeneralSection promise={settings} />
        <Separator />
        <LibrarySection promise={settings} />
      </div>
      <Separator />
      <AboutSection />
    </div>
  );
}
```

Note both sections take the *same* promise — `getSettings()` is `cache()`d per request, so this is one read, and passing one promise to two consumers is what keeps it that way. Delete `SectionsFallback` and the `Skeleton`/`Suspense` imports.

- [ ] **Step 8: Delete `src/app/(app)/settings/loading.tsx`**

```bash
git rm "src/app/(app)/settings/loading.tsx"
```

Its entire reason for existing was that `SettingsPage` suspended as a unit. It no longer does.

- [ ] **Step 9: Verify in a real browser — this is the step that proves the task**

Run `npm run dev`, then load `/settings` with DevTools → Network → throttling set to "Slow 3G".

Confirm, and write what you saw into the completion notes:
- The heading, both section headings, all labels, help text, the About section, both `<Select>` triggers, the number input and the Save button are **all on screen in the first paint**, greyed/disabled — no grey bars anywhere.
- The values then fill in and the controls enable, with no layout shift and no flash of a differently-shaped element.
- Then break it on purpose: temporarily `throw new Error("boom")` inside `getSettings()`, reload, and confirm the failure lands in the `(app)` group's `error.tsx` **and that the server process stays up** (no `unhandled-rejections` crash — see Design Reference rule 4). Revert the throw.

- [ ] **Step 10: Run the full check suite**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: all four pass. Pay attention to `src/app/server-component-props.test.ts` staying green.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor(settings): Stream values into real controls instead of skeletons"
```

---

### Task 2: `/account` — four sections

**Files:**
- Modify: `src/components/account/profile-section.tsx` (+ `.test.tsx`)
- Modify: `src/components/account/password-section.tsx` (+ `.test.tsx`)
- Modify: `src/components/account/passkey-section.tsx` (+ `.test.tsx`)
- Modify: `src/components/account/device-section.tsx` (+ `.test.tsx`)
- Modify: `src/app/(app)/account/page.tsx`
- Delete: `src/app/(app)/account/loading.tsx`

**Interfaces:**
- Consumes: `PageTitle` from Task 1 (or `getTranslations`, per Task 1 Step 6's outcome); the split shape from the Design Reference.
- Consumes: `getAccountOverview()` from `@/lib/account/queries`, called without `await`.
- Produces: `{Profile,Password,Passkey,Device}SectionForm` + `{…}Section({ promise })` pairs; all four `…SectionShell` exports deleted.

- [ ] **Step 1: For each of the four sections, write the pending-state test first**

Follow Task 1 Step 1 verbatim, adapted per section. The four assertions that matter, one per section:
- **Profile:** the avatar `<img>`/initials circle, the email/first/last `<Input>`s and Save are all present and disabled; today `account/loading.tsx:34-45` replaces every one of them with a bar.
- **Password:** the three password `<Input>`s and the submit button present and disabled (today: four bars).
- **Passkey:** the "Add passkey" button present and disabled; only the *list* of passkeys is unknown, so only the list area shows a loading affordance.
- **Device:** same as Passkey — only the device list is unknown.

For Passkey and Device, the pending list is the one place a `<Skeleton>` is still correct: the number of rows is genuinely unknowable. Use `<Skeleton className="h-16 w-full" />` there and say so in a comment, so a later reader does not "fix" it.

- [ ] **Step 2: Run each and confirm it fails**

Run: `npx vitest run src/components/account/`
Expected: FAIL on the new cases (`…SectionForm` not exported).

- [ ] **Step 3: Apply the split to all four sections**

Design Reference shape, four times. `<ProfileSection>` is the one with a real trap: it already declares `onSubmit` optional with a no-op default (`YoutubeSectionShell` is the reference for why). Keep that default — it is what let a Server Component fallback omit the prop, and after this task the fallback is a Client Component, so it is no longer load-bearing *here*, but the convention is enforced repo-wide by `server-component-props.test.ts` and removing it buys nothing.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/components/account/`
Expected: PASS, all pre-existing cases included.

- [ ] **Step 5: Rewrite `account/page.tsx` and delete `account/loading.tsx`**

Same shape as Task 1 Step 7: `await connection()` (or the existing `requireUser()` if that is what opts this route out — do not add a second opt-out), then `const overview = getAccountOverview()` unawaited, passed to all four sections. `git rm "src/app/(app)/account/loading.tsx"`.

- [ ] **Step 6: Verify in a browser under Slow 3G**

Load `/account`. Confirm every field, both buttons and the avatar frame paint immediately; only the two list regions and the field *values* arrive later. Note what you saw.

- [ ] **Step 7: Full checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add -A && git commit -m "refactor(account): Stream values into real controls instead of skeletons"
```

---

### Task 3: `/integrations` — two sections and the shared kit

**Files:**
- Modify: `src/components/integrations/youtube-section.tsx` (+ `.test.tsx`)
- Modify: `src/components/integrations/reddit-section.tsx` (+ `.test.tsx`)
- Modify: `src/components/integrations/section-parts.tsx`
- Modify: `src/components/section-kit.tsx` (only if a shell type must change)
- Modify: `src/app/(app)/integrations/page.tsx`
- Delete: `src/app/(app)/integrations/loading.tsx`

**Interfaces:**
- Consumes: `getIntegrationStatus()` from `@/lib/integrations/queries`, called without `await`.
- Produces: `{Youtube,Reddit}SectionForm` + `{…}Section({ promise })`.

**The one contract that must not break here.** `CLAUDE.md`'s masked-credential protocol is a three-file agreement: `getIntegrationStatus()` projects every secret through `mask()` and names the field `…Masked`; the section renders that mask as the input's **`placeholder`** with the value starting empty; an empty submission means *keep what is stored*. A pending secret input therefore already renders empty — the only change is that its `placeholder` is unknown until the promise resolves. **Do not invent a placeholder for the pending state**, and do not let the pending render put anything in `value`.

- [ ] **Step 1: Write the pending test for both sections**

```tsx
it("renders the real credential fields while the status is still loading", () => {
  renderWithProviders(<YoutubeSectionForm pending />);

  const key = screen.getByLabelText("API key") as HTMLInputElement;
  expect(key.disabled).toBe(true);
  expect(key.value).toBe("");
  // No mask is known yet, so no placeholder is asserted -- see the masked-secret
  // protocol in CLAUDE.md. What matters is that the field itself is here.
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/components/integrations/`
Expected: FAIL — `YoutubeSectionForm` not exported.

- [ ] **Step 3: Apply the split to both sections**

Design Reference shape. The status badge is data-dependent (it reports whether the integration is enabled) — in the pending state render the badge's frame with no verdict rather than a `<Skeleton>` bar, or omit it; pick one and comment the choice.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/components/integrations/`
Expected: PASS.

- [ ] **Step 5: Rewrite the page, delete the route's `loading.tsx`, verify in a browser, run all four checks, commit**

```bash
git rm "src/app/(app)/integrations/loading.tsx"
npm run lint && npm run format:check && npm run typecheck && npm test
git add -A && git commit -m "refactor(integrations): Stream values into real controls instead of skeletons"
```

Browser check under Slow 3G: both credential cards, every field and both buttons paint immediately; only the masks, the badges and the enabled state arrive later.

---

### Task 4: `/ai` — the provider picker and the nine tuning values

The largest section pair (`provider-section.tsx` is 601 lines). **Read `src/components/ai/provider-section.test.tsx:1-60` before starting** — its `choose()` helper is the Base UI pointer-sequence driver this task's tests need.

**Files:**
- Modify: `src/components/ai/provider-section.tsx` (+ `.test.tsx`)
- Modify: `src/components/ai/advanced-section.tsx` (+ `.test.tsx`)
- Modify: `src/components/ai/section-parts.tsx`
- Modify: `src/app/(app)/ai/page.tsx`
- Delete: `src/app/(app)/ai/loading.tsx`

**Interfaces:**
- Consumes: `getAiStatus()` from `@/lib/ai/queries`, without `await`.
- Produces: `ProviderSectionForm` / `ProviderSection({ promise })`, `AdvancedSectionForm` / `AdvancedSection({ promise })`.

Three page-specific facts that constrain the pending render:

- **The provider `<Select>`'s option list is static** — it comes from `AI_PROVIDERS` in `src/lib/ai/providers.ts`, which imports nothing and needs no query. So the pending provider picker is a **fully populated, disabled select with no selection**, not an empty one. Same for the nine tuning inputs: their `min`/`max` come from `src/lib/ai/bounds.ts`, also dependency-free, so a pending tuning field renders with its real bounds already set.
- **The model `<Select>` is the exception.** For a `hasDynamicModels` provider (OpenRouter) the catalog is fetched on demand and is genuinely unknown; for the other six it is static per provider, and *which* provider is active is what's unknown. Render it disabled and empty while pending.
- **`ai/loading.tsx`'s comment records a deliberate guess** — it renders the fallback "as if a provider were already selected". That guess disappears with this task: the real picker renders, unselected, and the truth arrives.

- [ ] **Step 1: Write the pending tests**

```tsx
it("renders the provider picker fully populated while the status loads", () => {
  const { container } = renderWithProviders(<ProviderSectionForm pending />);

  const trigger = container.querySelector("#provider") as HTMLButtonElement;
  expect(trigger.disabled).toBe(true);
  // The option list needs no query -- AI_PROVIDERS is a static, dependency-free
  // registry -- so the picker is real from the first frame, not a grey bar.
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
});

it("renders all nine tuning fields with their real bounds while loading", () => {
  renderWithProviders(<AdvancedSectionForm pending />);

  const fields = screen.getAllByRole("spinbutton") as HTMLInputElement[];
  expect(fields).toHaveLength(9);
  expect(fields.every((f) => f.disabled)).toBe(true);
  expect(fields.every((f) => f.value === "")).toBe(true);
  // Bounds come from src/lib/ai/bounds.ts, which imports nothing.
  expect(fields.every((f) => f.min !== "")).toBe(true);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/components/ai/`
Expected: FAIL.

- [ ] **Step 3: Apply the split to both sections**

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/components/ai/`
Expected: PASS, all 644 + 168 lines of pre-existing cases included. This is the task most likely to break an existing test; if one fails, fix the production code, not the assertion, unless the assertion is specifically about a `…Shell` export that no longer exists.

- [ ] **Step 5: Rewrite the page, delete `ai/loading.tsx`, verify in a browser, run all four checks, commit**

```bash
git rm "src/app/(app)/ai/loading.tsx"
npm run lint && npm run format:check && npm run typecheck && npm test
git add -A && git commit -m "refactor(ai): Stream values into real controls instead of skeletons"
```

---

### Task 5: The dashboard's stat cards

**Files:**
- Modify: `src/app/(app)/page.tsx`
- Modify: the stat-card component it renders (locate via `DashboardStatCards` in `src/app/(app)/page.tsx:60`)
- Modify/create: the corresponding `.test.tsx`

Today `src/app/(app)/page.tsx:60` renders five whole `<CardSkeleton>`s — card titles included — and another for the recent-articles list. The titles are static strings from the `dashboard` catalog.

- [ ] **Step 1: Write the failing test**

```tsx
it("renders every stat card's title and frame while the counts are loading", () => {
  renderWithProviders(<DashboardStatCardsForm pending />);

  // Five real cards with their real titles -- the numbers are the only unknown.
  expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(5);
});
```

Adjust the role/level to whatever the real card markup uses; read it first rather than assuming.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/app/` or the card component's own test path.
Expected: FAIL.

- [ ] **Step 3: Give the stat card a pending state**

The card frame, icon and title render always; only the number is replaced by a small `<Skeleton className="h-8 w-16" />` while pending. A number genuinely has no real "empty" rendering, so a skeleton *for the number alone* is the right call here — this is the one place in the migration where a skeleton survives by design, alongside the two list regions in Task 2.

- [ ] **Step 4: Run the test**

Expected: PASS.

- [ ] **Step 5: Rewrite the page to pass promises, verify in a browser, run all four checks, commit**

`getDashboardStats()` and `getRecentUnreadArticles()` each become an unawaited promise. Note that `requireUserFreshRole()` **must stay awaited** in the page body — `isAdmin` decides which cards exist at all, and it is deliberately not `cache()`d.

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add -A && git commit -m "refactor(dashboard): Render card frames immediately, stream only the counts"
```

---

### Task 6: The three `/new` routes

`/feeds/new`, `/tags/new` and `/users/new` have **no `loading.tsx` at all** and fall through to `src/app/(app)/loading.tsx`'s generic `TableSkeleton` — 3×4 grey bars on pages that are almost entirely static forms. `/feeds/new` is the only one with a real wait: `capabilitiesFor()` plus a 1000-row `listTags()` (`src/app/(app)/feeds/new/page.tsx:8-20`).

**Files:**
- Modify: `src/app/(app)/feeds/new/page.tsx`, `src/app/(app)/tags/new/page.tsx`, `src/app/(app)/users/new/page.tsx`
- Modify: `src/components/feeds/feed-form.tsx` (+ `.test.tsx`) and the tag/user form equivalents
- Create: `src/app/(app)/feeds/new/loading.tsx` **only if** the page still suspends after the change

- [ ] **Step 1: Write the failing test for `<FeedForm>`'s pending state**

```tsx
it("renders every field while the tag list and capabilities are still loading", () => {
  renderWithProviders(<FeedFormFields pending />);

  expect(screen.getByLabelText("Name")).toBeTruthy();
  expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(true);
  // The tag multi-select is the only genuinely data-dependent control.
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/components/feeds/feed-form.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Split the form and pass promises from all three pages**

`capabilitiesFor()` and `listTags()` become unawaited promises. `requireUser()` stays awaited (it is what opts these routes out of prerendering — do not add a `connection()` call alongside it). The aggregator picker's options come from `AGGREGATOR_SPECS`, which needs no query, so it renders populated while pending, exactly like Task 4's provider picker.

- [ ] **Step 4: Run the tests**

Expected: PASS.

- [ ] **Step 5: Confirm no route still falls through to the generic fallback**

Run `npm run dev` and load each of `/feeds/new`, `/tags/new`, `/users/new` under Slow 3G. None may show `TableSkeleton`'s 3×4 bars. If one still does, its page function is still suspending — find the remaining top-level `await` and either move it into a promise or give that route its own `loading.tsx` rendering the real form chassis.

- [ ] **Step 6: Full checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add -A && git commit -m "refactor(new-routes): Render the real form immediately on the create pages"
```

---

### Task 7: The edit/detail routes — partial by design

**Read this before starting: these routes cannot be fully migrated, and that is correct.** `CLAUDE.md` requires that whatever decides the response *status* is awaited in the page body — `getFeed()` returning nothing must produce a real 404, which is only possible while the response is still open. So the record read stays awaited, the page still suspends on it, and `loading.tsx` stays. What this task fixes is the *content* of that fallback: today `src/app/(app)/feeds/[id]/loading.tsx:20` is ~14 hand-placed grey bars including one per field label.

**Files:**
- Modify: `src/app/(app)/{feeds,tags,users,articles}/[id]/loading.tsx`
- Modify: the same routes' `page.tsx` (secondary lookups only)

- [ ] **Step 1: Rewrite each `loading.tsx` to render the real form chassis**

Each becomes `<FeedFormFields pending />` (and the tag/user/article equivalents from Task 6) rather than hand-placed bars. Real labels, real disabled inputs, real buttons. The `<h1>` is the one genuine unknown — it interpolates the record's name — so it keeps a `<Skeleton className="h-8 w-1/3" />`, and that stays commented as deliberate.

This also deletes ~14 lines of geometry per file that had to be kept in visual sync with a form by hand — the drift risk that motivated the whole migration.

- [ ] **Step 2: Move the secondary lookups to promises**

On `/feeds/[id]`: `getFeed()` stays awaited (status), `capabilitiesFor()` and `listTags()` become promises. This shortens the suspend to one indexed read.

- [ ] **Step 3: Verify each route still 404s correctly**

Run: `npm test` — the existing route tests cover `notFound()`. Then by hand: `npm run dev`, load `/feeds/999999`, confirm a real 404 page and **not** a truncated 200 with a broken form.

This is the step that catches the one way this task can do real damage.

- [ ] **Step 4: Verify in a browser under Slow 3G**

Load `/feeds/<real id>`. The form chassis with real labels and disabled fields must appear first, then fill in. No grey bars except the title.

- [ ] **Step 5: Full checks and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add -A && git commit -m "refactor(edit-routes): Replace hand-placed skeleton geometry with the real form chassis"
```

---

### Task 8: Retire the dead scaffolding and rewrite the convention in `CLAUDE.md`

**Files:**
- Modify: `src/components/data-skeleton.tsx`
- Modify: `src/app/(app)/loading.tsx`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find every remaining consumer of the skeleton helpers**

```bash
grep -rn "CardSkeleton\|TableSkeleton\|SectionShell\|SectionsFallback" src/
```

Expected after Tasks 1–7: `TableRowsSkeleton` still used by the five list routes (correct — a table body's row count is genuinely unknown); `TableSkeleton` used only by `src/app/(app)/loading.tsx`; `CardSkeleton` used only by whatever Task 5 left. Any surviving `…SectionShell` export with no consumer is dead code — delete it.

- [ ] **Step 2: Decide the fate of the group-level `loading.tsx`**

`src/app/(app)/loading.tsx` renders a generic `TableSkeleton` for any route that still suspends without its own fallback. After Task 6 no route should rely on it. Keep the file — it is the backstop for a future route that forgets — but change its content to something honest and neutral rather than a table shape on non-table pages, and update its doc comment, which currently describes a world where every page suspends as a unit.

- [ ] **Step 3: Rewrite the streaming-pattern bullet in `CLAUDE.md`**

The current bullet ("The streaming pattern: chrome renders synchronously; data regions are async components inside `<Suspense>`…") describes what this migration replaced. Rewrite it to state the new convention, and keep the parts that are still true and still load-bearing:
- **Still true, keep verbatim:** the three documented exceptions in `layout.tsx`/`(app)/layout.tsx`; the "whatever decides the response status is awaited in the page body" rule; the error-boundary requirement; the cold-start `Event handlers cannot be passed to Client Component props` hazard and its tripwire test.
- **New:** the page passes an unawaited promise to a client component; the client component's `<Suspense fallback>` is the same form in a `pending` state, never a `<Skeleton>`; a skeleton survives only where the *shape* is unknowable — a table body's rows, a passkey/device list, a single number.
- **Also new, and worth stating because it is the trap:** a pending control omits `value` and passes `disabled`; it must never use `defaultValue`, which would not update when the real value arrives.

Also update the `src/components/data-skeleton.tsx` reference in the Layout tree at the top of the file if its role changed.

- [ ] **Step 4: Run the full suite one last time and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
git add -A && git commit -m "docs: Record the streaming-controls convention"
```

- [ ] **Step 5: Confirm the build still refuses to touch the database**

The `connection()` invariant has a physical check, and this migration moved code around every one of those call sites:

```bash
rm -rf data/ && npm run build && ls data/ 2>&1
```

Expected: `ls: data/: No such file or directory`. If `data/` came back, a route lost its opt-out — find it with `grep -rl "await connection()" src/app` and compare against the routes this plan touched.

---

## Self-Review

**Spec coverage.** The defect was "multiple skeleton placeholders instead of the normal fields, tables, selects". Card pages → Tasks 1–4. Dashboard → Task 5. `/new` routes falling through to the generic table skeleton → Task 6. Edit-route geometry → Task 7. List pages were already correct and are deliberately untouched, except for the `TableRowsSkeleton` audit in Task 8 Step 1.

**Known gaps, stated rather than hidden.**
- Task 7 is partial by design; the record read cannot leave the page body without breaking 404s. The title skeleton on edit routes survives.
- Three skeletons survive on purpose: table-body rows, the passkey/device lists, and the dashboard's numbers. Each is a case where the *shape*, not just the value, is unknown.
- Task 1 Step 6 carries a real fork: if `<PageTitle>` cannot be typed without defeating the compiler-checked catalog keys, it is dropped and every page keeps `await getTranslations()`. That weakens the "page never suspends" claim to "page suspends only on a per-request-cached read". The executor must report which branch was taken **before** Task 2 starts, since every later page file depends on it.

**Type consistency.** The `…Form` / `…Resolved` / `…Section({ promise })` triple is used identically in Tasks 1–4 and 6. `pending` is the prop name everywhere, always optional, always defaulting to `false`. Value props become optional (`?`) rather than gaining `| undefined` unions, so existing call sites that pass real values keep typechecking unchanged.
