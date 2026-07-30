# Phase 7: AI Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AI tab with a general section (provider selection, credentials, model) and an advanced section (temperature, max tokens, rate and usage limits).

**Architecture:** Reuses phase 6's secret-handling and probe machinery wholesale — same `KEEP_EXISTING` sentinel, same `ProbeResult` classification, same probe-on-save discipline. The provider registry is the one new idea: a single declaration per provider carrying its models, endpoint and probe, so adding a provider later touches one file rather than the form, the action, and the client.

**Tech Stack:** Next.js server actions, Zod, shadcn form primitives, phase 6's `src/lib/secrets.ts`.

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
cd yana-next && npm test -- providers
cd .. && git add yana-next && git commit -m "feat(next): Add the AI provider registry

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
cd yana-next && npm test -- ai
cd .. && git add yana-next && git commit -m "feat(next): Add AI settings actions with explicit bounds

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
cd yana-next && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
cd .. && git add yana-next && git commit -m "feat(next): Add the AI tab

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
