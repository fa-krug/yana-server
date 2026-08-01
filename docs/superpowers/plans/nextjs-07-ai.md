# Phase 7: AI Tab — Implementation Plan

> **Path note (post folder swap):** the Next.js app is the repository root and the
> Django tree is `old/`. Read Python paths below — `core/…`, `yana/…` — as
> `old/core/…` / `old/yana/…`, and treat `uv run …` commands as historical: `old/`
> is read-only reference and is not runnable as configured.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AI tab with a general section (provider selection, credentials, model) and an advanced section (temperature, max tokens, rate and usage limits).

**Architecture:** Reuses phase 6's secret-handling and probe machinery wholesale — same `KEEP_EXISTING` sentinel, same `ProbeResult` classification, same probe-on-save discipline. The provider registry is the one new idea: a single declaration per provider carrying its models, endpoint and probe, so adding a provider later touches one file rather than the form, the action, and the client.

**Tech Stack:** Next.js server actions, Zod, shadcn form primitives, phase 6's `src/lib/secrets.ts`.

---

> ## ⚠ This plan is a historical record. Phase 7 has shipped; read `CLAUDE.md`.
>
> Two refactor tasks (R1, R2) were run ahead of the three below, and several controller and human
> rulings landed during execution. The **task bodies were never rewritten** — rewriting them would
> make the record of what was planned indistinguishable from what happened. What shipped is in
> `CLAUDE.md`'s Conventions and in the direction record's "Carried forward from phase 6's review",
> where all three of that section's items are now closed. Read literally, several passages below
> will produce defects the rulings exist to prevent.
>
> 1. **Actions return a catalog `errorKey`, never an English string.** The plan's
>    `{ ok: boolean; error?: string }` interface, and the `expect(result.error).toMatch(/monthly/i)`
>    assertion that reads it, are superseded (human rulings B and C: `CLAUDE.md` governs). A zod or
>    provider message rendered into a German toast is precisely what that convention exists to
>    prevent. Everything in `src/lib/ai/actions.ts` answers `AiResult`/`AiSaveResult` — keys under
>    the **`ai`** catalog namespace, bound in `src/lib/ai/result.ts` through
>    `attemptIn("ai", { sessionEnded, requestFailed })`, the fourth binding of its kind after
>    `account`, `users` and `integrations`. A `ProbeResult.detail` is worse than a validator string
>    and never crosses the wire at all: it is prose built for a server log, and a provider's error
>    body can echo back the key just submitted. The map from a probe's `cause` to a catalog key is
>    server-side.
> 2. **Task 2's test bodies are not runnable as written.** They call `saveAdvanced({...})` with no
>    temp database and no request scope — which reaches `currentUserId()` → `requireUser()` and
>    *throws* rather than returning `{ ok: false }` — and each bound is probed with a partial object,
>    so the assertion fails on the eight missing fields and would stay green whatever the bound did.
>    What shipped is `src/lib/ai/actions.test.ts` in this repository's real-database style: a
>    migrated temp SQLite file per test, the caller signed in for real through `signInCookie()`, and
>    every bound submitted as a **complete valid payload with exactly one field out of range**, so
>    each assertion is about the bound it names.
> 3. **`ProbeResult` is imported from `src/lib/integrations/probe.ts`**, not from
>    `src/lib/integrations/youtube.ts` as the Self-Review section says. Phase 6 moved it there
>    precisely because three more providers would report the same shape; the plan's line is stale.
> 4. **Only OpenAI has a base URL.** The plan's `getAiStatus` gives every provider an `apiUrl` as
>    though each had one; the schema has a single `openai_api_url` column. The registry's
>    `hasCustomUrl` is the declared fact — `true` for OpenAI alone — and both the credential shape
>    and the projection follow it, so `AiProviderStatus.apiUrl` is `""` for the two providers whose
>    endpoint is fixed. It is deliberately *not* masked: a base URL is an operator setting rather
>    than a credential, and masking the one field most often needing correction would make it
>    unreadable.
> 5. **The registry is client-safe and carries no `probe`.** The plan puts `probe` on `AiProvider`
>    beside `label`/`models`, which would drag all three probe modules into the browser bundle
>    through task 3's model `<Select>`. Human ruling G split them: `src/lib/ai/providers.ts` imports
>    **nothing** — pinned by a specifier tripwire in `providers.test.ts`, the same guard
>    `src/lib/secrets.ts` carries — and the three live `fetch` probes are one import away in
>    `src/lib/ai/probes.ts`, a `Record<AiProviderKey, AiProbe>` so that widening the key union
>    without adding a probe is a typecheck failure rather than an `undefined` found by pressing
>    Test. The precedent is `src/lib/users/fields.ts` against its `queries.ts`.
> 6. **`clearActiveIfDisabled` was removed** (human ruling I), after being written during task 2 and
>    never having been in this plan. `active_ai_provider` is a **preference** and nothing on the
>    write side erases it when a provider's flag goes false; which provider is *actually* active is
>    derived on the read side by `activeProvider()`, which `getAiStatus()` calls and which answers
>    `""` whenever the named provider's probe-derived flag disagrees. Clearing bought nothing the
>    derivation does not already give — the state it removed was unobservable — and it cost real
>    damage: OpenAI's `insufficient_quota` is classified `unauthorized` on purpose, so an unpaid bill
>    on the active provider permanently wiped a selection the operator never changed, and paying the
>    bill would not bring it back. The derivation brings it back by itself.

---

## Global Constraints

- Three providers only: **OpenAI, Anthropic, Gemini**. The direction record defers provider expansion (iOS has seven) as a separate concern — do not widen it here.
- An empty `activeAiProvider` **disables AI entirely**. That is the existing contract and phase 9 depends on it for its `requires: 'ai'` option guard.
- Credentials reuse phase 6's masking and `resolveSecret`. Do not write a second implementation.
- Model lists are **refreshed** in this phase. The current defaults in `core/models.py` are stale (`gpt-4o`, `claude-3-5-sonnet-20240620`, `gemini-1.5-flash`); phase 2 copied them verbatim on purpose so the refresh is a visible, deliberate change here rather than a silent one there.
- Advanced-section values are validated with explicit bounds. An unbounded `maxTokens` or a temperature above the provider's ceiling produces a provider-side error that surfaces to the user as an opaque aggregation failure.
- `activeAiProvider` may only be set to a provider whose credentials pass a probe. Selecting a broken provider is how AI features fail silently.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/lib/ai/providers.ts` | The provider registry — models, endpoints, probes |
| `src/lib/ai/actions.ts` | `saveProvider`, `testProvider`, `saveAdvanced`, `setActiveProvider` |
| `src/lib/ai/queries.ts` | `getAiStatus()` — masked, client-safe |
| `src/app/(app)/ai/page.tsx` | Route with two sections |
| `src/components/ai/general-section.tsx` | Provider picker, credentials, model |
| `src/components/ai/advanced-section.tsx` | Tuning and limits |

---

### Task 1: The provider registry

**Interfaces:**
- Produces:
  - `type AiProvider = { key: "openai" | "anthropic" | "gemini"; label: string; models: { value: string; label: string }[]; defaultModel: string; hasCustomUrl: boolean; probe: (credentials: { apiKey: string; apiUrl?: string; model: string }) => Promise<ProbeResult> }`
  - `AI_PROVIDERS: readonly AiProvider[]`
  - `providerByKey(key: string): AiProvider | undefined`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/ai/providers.test.ts
import { describe, expect, it } from "vitest";

import { AI_PROVIDERS, providerByKey } from "./providers";

describe("AI_PROVIDERS", () => {
  it("covers exactly the three supported providers", () => {
    expect(AI_PROVIDERS.map((provider) => provider.key)).toEqual([
      "openai",
      "anthropic",
      "gemini",
    ]);
  });

  it("lists its default model among its models", () => {
    // A default absent from the list renders an empty select.
    for (const provider of AI_PROVIDERS) {
      expect(provider.models.map((model) => model.value)).toContain(provider.defaultModel);
    }
  });

  it("only offers a custom URL where the provider supports one", () => {
    expect(providerByKey("openai")?.hasCustomUrl).toBe(true);
    expect(providerByKey("anthropic")?.hasCustomUrl).toBe(false);
    expect(providerByKey("gemini")?.hasCustomUrl).toBe(false);
  });

  it("returns undefined for an unknown key", () => {
    expect(providerByKey("mistral")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Look up current model ids before writing them**

The stale lists are the thing being fixed, so do not carry them forward and do not write them from memory. Check each provider's current documentation for the model ids available today, and record what you chose in the commit message.

- [ ] **Step 3: Implement the registry**

Each provider's `probe` makes one minimal completion request — a 1-token generation is enough to prove the key, the model id and the endpoint all work together, which a models-list call does not. Classify results using phase 6's `ProbeResult` union, including the same rule that a rate-limit response means the credentials are valid.

```ts
// sketch of the shape; fill models from Step 2
export const AI_PROVIDERS: readonly AiProvider[] = [
  {
    key: "openai",
    label: "OpenAI",
    models: [/* from Step 2 */],
    defaultModel: "/* from Step 2 */",
    // The only provider with a configurable base URL, for OpenAI-compatible
    // gateways.
    hasCustomUrl: true,
    probe: async ({ apiKey, apiUrl, model }) => { /* 1-token completion */ },
  },
  // anthropic, gemini
];
```

- [ ] **Step 4: Run and commit**

```bash
npm test -- providers
git add -A && git commit -m "feat(next): Add the AI provider registry

One declaration per provider carries its models, endpoint and probe, so adding a
provider touches this file rather than the form, the action and the client.

Model lists are refreshed rather than carried over -- phase 2 copied the stale
defaults verbatim precisely so the update would be a visible change here. Probes
make a 1-token completion rather than listing models, because only a real
generation proves the key, model id and endpoint work together."
```

---

### Task 2: Actions and queries

**Interfaces:**
- Produces:
  - `getAiStatus(): Promise<{ active: string; providers: Record<string, { enabled: boolean; apiKeyMasked: string; apiUrl: string; model: string }>; advanced: { temperature: number; maxTokens: number; dailyLimit: number; monthlyLimit: number; maxPromptLength: number; requestTimeout: number; maxRetries: number; retryDelay: number; requestDelay: number } }>`
  - `saveProvider(key: string, input: unknown): Promise<{ ok: boolean; error?: string }>`
  - `testProvider(key: string, input: unknown): Promise<ProbeResult>`
  - `setActiveProvider(key: string): Promise<{ ok: boolean; error?: string }>`
  - `saveAdvanced(input: unknown): Promise<{ ok: boolean; error?: string }>`

- [ ] **Step 1: Write the failing tests for the bounds**

```ts
// src/lib/ai/actions.test.ts
import { describe, expect, it } from "vitest";

import { saveAdvanced, setActiveProvider } from "./actions";

describe("saveAdvanced", () => {
  it("rejects a temperature above 2", async () => {
    expect((await saveAdvanced({ temperature: 2.5 })).ok).toBe(false);
  });

  it("rejects a negative temperature", async () => {
    expect((await saveAdvanced({ temperature: -0.1 })).ok).toBe(false);
  });

  it("rejects maxTokens of zero", async () => {
    expect((await saveAdvanced({ maxTokens: 0 })).ok).toBe(false);
  });

  it("rejects a monthly limit below the daily limit", async () => {
    // Otherwise the monthly cap is unreachable and the daily one never applies.
    const result = await saveAdvanced({ dailyLimit: 500, monthlyLimit: 100 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/monthly/i);
  });

  it("accepts the documented defaults", async () => {
    expect(
      (
        await saveAdvanced({
          temperature: 0.3, maxTokens: 2000, dailyLimit: 200, monthlyLimit: 2000,
          maxPromptLength: 500, requestTimeout: 120, maxRetries: 3,
          retryDelay: 2, requestDelay: 2,
        })
      ).ok,
    ).toBe(true);
  });
});

describe("setActiveProvider", () => {
  it("allows the empty string, which disables AI", async () => {
    expect((await setActiveProvider("")).ok).toBe(true);
  });

  it("refuses a provider whose credentials have not passed a probe", async () => {
    expect((await setActiveProvider("anthropic")).ok).toBe(false);
  });

  it("refuses an unknown provider key", async () => {
    expect((await setActiveProvider("mistral")).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

Bounds, as a Zod schema — each has a reason, not just a number:

| Field | Range | Why |
|---|---|---|
| `temperature` | 0–2 | Every supported provider rejects above 2 |
| `maxTokens` | 1–200000 | Zero is a guaranteed empty completion |
| `dailyLimit` | 1–100000 | — |
| `monthlyLimit` | ≥ `dailyLimit` | A monthly cap below the daily one is unreachable |
| `maxPromptLength` | 1–100000 | — |
| `requestTimeout` | 5–600 s | Below 5s no provider ever answers |
| `maxRetries` | 0–10 | — |
| `retryDelay` | 0–60 s | — |
| `requestDelay` | 0–60 s | Rate-limit spacing between calls |

`saveProvider` mirrors phase 6 exactly: `resolveSecret` against the stored key, probe, set `<provider>Enabled` from the probe, persist. `setActiveProvider` refuses any key whose `*Enabled` flag is false, and accepts `""` to disable.

- [ ] **Step 3: Run and commit**

```bash
npm test -- ai
git add -A && git commit -m "feat(next): Add AI settings actions with explicit bounds

Every bound has a reason rather than a round number: temperature above 2 is
rejected by all three providers, maxTokens of zero guarantees an empty completion,
and a monthly limit below the daily one makes the monthly cap unreachable.

An active provider must have passed a probe. Selecting a broken provider is how AI
features fail silently, which is much harder to diagnose than a refused save."
```

---

### Task 3: The UI

- [ ] **Step 1: Build the general section**

Provider `Select` listing the three plus a "None (disabled)" option mapping to `""`. Choosing a provider reveals its credential fields — API key always, base URL only when `hasCustomUrl`, and a model `Select` from that provider's list. **Test** and **Save** buttons beside each other, matching phase 6.

Secret inputs follow phase 6 exactly: `type="password"`, masked value as `placeholder`, field value starting at `KEEP_EXISTING`.

- [ ] **Step 2: Build the advanced section**

Nine numeric inputs in a responsive grid — one column on mobile, two from `sm:`. Each carries its bound as `min`/`max` and a one-line help string. A single Save for the whole section, since the values are interdependent (the daily/monthly relationship cannot be validated field by field).

- [ ] **Step 3: Build the route**

`src/app/(app)/ai/page.tsx` — `requireUser()`, `<Suspense>` with `<CardSkeleton>`, following phase 3.

- [ ] **Step 4: Add message keys**

Both catalogs, under `ai`: section titles, every field label, every help string, and the classified probe causes. Phase 3's catalog-parity test will fail if EN and DE drift.

- [ ] **Step 5: Verify by hand**

Select each provider and test with a real key. Confirm a bad key refuses activation. Confirm selecting "None" disables AI and that `activeAiProvider` becomes `""` in the database. Confirm a monthly-below-daily save is refused with a readable message. Check the page source contains no raw key.

- [ ] **Step 6: Run every check and commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
git add -A && git commit -m "feat(next): Add the AI tab

General section picks a provider and its credentials; advanced section carries the
nine tuning and limit values. Advanced saves as one unit because the values are
interdependent -- the daily/monthly relationship cannot be validated per field.

Reuses phase 6's secret masking and probe classification rather than
reimplementing either."
```

---

## Self-Review

**Spec coverage.** Against bullet 7: general section with provider selection and credentials (Tasks 1–3), advanced section with temperature, max tokens and limits (Tasks 2–3). Complete.

**Placeholder scan.** Task 1 Step 2 deliberately does not list model ids — they are the stale thing being fixed, and writing them from memory would reintroduce the defect. Step 3's registry is a shape sketch for the same reason. Task 3 describes UI that follows phase 6's now-concrete pattern. The bounds table in Task 2 is complete and each entry carries its rationale.

**Type consistency.** `ProbeResult` is imported from phase 6's `src/lib/integrations/youtube.ts`, not redeclared. `AiProvider.key` is a literal union matching `activeAiProvider`'s permitted values plus `""`. `getAiStatus`'s `advanced` field names match phase 2's columns with the `ai` prefix dropped (`aiTemperature` → `temperature`) — the mapping happens in the query, and is the only place it happens.

**One item explicitly out of scope.** No AI feature actually *runs* in this phase — no summarize, translate or improve-writing. Those are per-feed options belonging to phase 9's option registry and consumed by phase 11c's aggregators. This phase configures the credentials they will use, nothing more.
