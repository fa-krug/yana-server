# OpenRouter AI Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add OpenRouter as a 7th AI provider on `/ai`, with a live-fetched (manually refreshed) model catalog instead of a hardcoded list, and give `/api/v1/ai/prompt` a distinct error code for "the stored provider credentials were rejected" instead of lumping it into a generic failure.

**Architecture:** OpenRouter follows the existing Mistral/Qwen/DeepSeek provider shape everywhere that shape fits (fixed OpenAI-compatible endpoint, `defineIntegration()` descriptor, shared probe helper). It deviates in exactly two places: (1) a new `hasDynamicModels` flag plus a server action that fetches OpenRouter's public `/models` endpoint on demand (button-triggered, no caching), replacing the static-list `modelField()` validator with a permissive one; (2) `AIClient` gains a typed `ProviderUnauthorizedError` thrown on a 401/403 from any provider, surfaced through a new `AiGenerationResult` reason and a new `/api/v1/ai/prompt` error code.

**Tech Stack:** Next.js 16 / React 19 / TypeScript, Drizzle + better-sqlite3, Zod, Vitest.

## Global Constraints

- Line length 100, double quotes, semicolons, trailing commas (Prettier owns formatting).
- No raw secret or provider-prose ever crosses into a client-visible field or a catalog message — only `errorKey`s do (see CLAUDE.md's "no-echo" rule).
- Every user-facing string comes from `messages/en.json` **and** `messages/de.json`, identical key sets.
- `AiProviderKey`-keyed `Record`s must stay exhaustive — adding `"openrouter"` to the union is what makes a missing entry a `npm run typecheck` failure everywhere one matters.
- New `user_settings` columns are pure additions (no drops), so `npx drizzle-kit generate` needs no interactive prompt.
- Test file extension picks the Vitest project: `.test.ts` = real-SQLite/node, `.test.tsx` = jsdom/component.
- Run `npm run lint && npm run format:check && npm run typecheck && npm test` before considering any task done, in addition to that task's own test command.

---

### Task 1: Schema — add OpenRouter columns and generate the migration

**Files:**
- Modify: `src/lib/db/schema/users.ts` (the AI provider column block, right after the `deepseekModel` line)
- Modify: `src/lib/ai/defaults.test.ts`
- Create: a new file under `drizzle/` (via `npx drizzle-kit generate`)

**Interfaces:**
- Produces: `userSettings.openrouterEnabled` (`boolean`, default `false`), `userSettings.openrouterApiKey` (`string`, default `""`), `userSettings.openrouterModel` (`string`, default `"openrouter/free"`) — the column names every later task reads via `AI_COLUMNS.openrouter`.

- [ ] **Step 1: Add the three columns to the schema**

In `src/lib/db/schema/users.ts`, immediately after the `deepseekModel` line (currently the last of the six provider blocks, right before the `// --- Global AI tuning (phase 7's advanced section) ---` comment), add:

```ts
    openrouterEnabled: integer("openrouter_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    openrouterApiKey: text("openrouter_api_key").notNull().default(""),
    openrouterModel: text("openrouter_model").notNull().default("openrouter/free"),
```

Update the doc comment above the provider block (the one starting "**The seven defaults below (one base URL plus each of the six providers' default model)...**") to say "eight defaults below (one base URL plus each of the seven providers' default model)".

- [ ] **Step 2: Generate the migration**

Run:
```bash
npx drizzle-kit generate
```

This is a pure addition (three new nullable-with-default columns), so it must **not** prompt interactively. If it does, stop and re-check that no column was renamed or removed in the same edit.

- [ ] **Step 3: Extend `defaults.test.ts` to cover the new provider**

In `src/lib/ai/defaults.test.ts`, in the `"starts each provider on a model its registry entry still offers"` test, no change is needed — it already iterates `AI_PROVIDERS`, and Task 2 adds `openrouter` to that array, so this test picks it up automatically once Task 2 lands. Add one more targeted assertion to the existing `"starts new providers on their correct default models"` test:

```ts
  it("starts new providers on their correct default models", () => {
    const row = bareRow();
    expect(row.mistral_model).toBe("mistral-small-latest");
    expect(row.qwen_model).toBe("qwen3.5-flash");
    expect(row.deepseek_model).toBe("deepseek-v4-flash");
    expect(row.openrouter_model).toBe("openrouter/free");
  });
```

Also extend the `"starts with AI switched off entirely"` test's array to include `row.openrouter_enabled`:

```ts
    expect([
      row.openai_enabled,
      row.anthropic_enabled,
      row.gemini_enabled,
      row.mistral_enabled,
      row.qwen_enabled,
      row.deepseek_enabled,
      row.openrouter_enabled,
    ]).toEqual([0, 0, 0, 0, 0, 0, 0]);
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/lib/ai/defaults.test.ts`
Expected: FAIL — `row.openrouter_model` is `undefined` because Task 2 hasn't added `openrouter` to `AI_PROVIDERS` yet, and the column doesn't exist until this task's migration is applied. If the migration step above was done correctly, the column exists; the failure should only be about the `AI_PROVIDERS` iteration not yet knowing about `openrouter` (that part is fine to leave failing — it will pass once Task 2 lands). Confirm specifically that `row.openrouter_model` reads back as `"openrouter/free"` and `row.openrouter_enabled` reads back as `0`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/schema/users.ts src/lib/ai/defaults.test.ts drizzle/
git commit -m "feat(db): add openrouter columns to user_settings"
```

---

### Task 2: Provider registry — add `openrouter` to `providers.ts`

**Files:**
- Modify: `src/lib/ai/providers.ts`
- Modify: `src/lib/ai/providers.test.ts`

**Interfaces:**
- Consumes: nothing (this module imports nothing, by rule).
- Produces: `OPENROUTER_API_URL` constant; `AiProviderKey` includes `"openrouter"`; `AiProvider.hasDynamicModels: boolean` field; `AI_PROVIDERS` includes an `openrouter` entry with `models: [{value: "openrouter/free", ...}, {value: "openrouter/auto", ...}]`, `defaultModel: "openrouter/free"`, `hasCustomUrl: false`, `hasDynamicModels: true`, `quotaMeansVerified: false`.

- [ ] **Step 1: Add the union member and the fixed endpoint constant**

In `src/lib/ai/providers.ts`:

```ts
export type AiProviderKey =
  | "openai"
  | "anthropic"
  | "gemini"
  | "mistral"
  | "qwen"
  | "deepseek"
  | "openrouter";
```

Beside `DEEPSEEK_API_URL`:

```ts
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
```

- [ ] **Step 2: Add `hasDynamicModels` to the `AiProvider` type**

Add a field next to `hasCustomUrl` on the `AiProvider` type:

```ts
  /**
   * Whether this provider's model list is fetched live rather than fixed.
   *
   * `true` only for OpenRouter: it aggregates hundreds of models that change
   * continuously (including a rotating set of free `:free`-tagged ones), so a
   * static list would be wrong the day it ships. `models`/`defaultModel` still
   * exist and are still required even when this is `true` -- they are the safe
   * fallback shown before any refresh and what `resolveModel()` falls back to.
   * See `listOpenrouterModels()` in `./actions` for the live fetch, and
   * `provider-section.tsx` for the "Refresh models" control it is wired to.
   */
  hasDynamicModels: boolean;
```

- [ ] **Step 3: Add `hasDynamicModels: false` to the six existing entries**

Add `hasDynamicModels: false,` to each of the six existing objects in `AI_PROVIDERS` (openai, anthropic, gemini, mistral, qwen, deepseek) — place it next to `hasCustomUrl`.

- [ ] **Step 4: Append the `openrouter` entry to `AI_PROVIDERS`**

After the `deepseek` entry:

```ts
  {
    key: "openrouter",
    label: "OpenRouter",
    // Both entries are OpenRouter's own routing aliases, not a specific
    // vendor's model id -- confirmed live against openrouter.ai/api/v1/models
    // and https://openrouter.ai/openrouter/free on 2026-08-08. Neither can go
    // stale the way a pinned model id can, which is why they are the *only*
    // two entries in this static fallback: the full live catalog (hundreds of
    // models, including free ones) is fetched on demand by
    // `listOpenrouterModels()` in `./actions` -- see `hasDynamicModels` above.
    models: [
      // "selects free models at random from the models available on
      // OpenRouter" and "smartly filters for models that support features
      // needed for your request" (OpenRouter's own description). Guarantees
      // $0 cost on every request, which is why it is the default: this page
      // is often configured with a free-tier key.
      { value: "openrouter/free", label: "Free (auto-routed)" },
      // OpenRouter's general auto-router. Best-available routing, but may
      // pick a paid model -- offered for a user who wants quality over a
      // guaranteed-free request.
      { value: "openrouter/auto", label: "Auto (any model, may cost)" },
    ],
    defaultModel: "openrouter/free",
    // Fixed endpoint, like Mistral/Qwen/DeepSeek: not an operator setting.
    hasCustomUrl: false,
    hasDynamicModels: true,
    // Unlike Mistral/Qwen/DeepSeek's direct-endpoint `true`: OpenRouter is
    // itself an aggregator in front of many upstream providers and applies
    // its own rate limiting -- including extra throttling specific to
    // free-tier `:free` models -- independent of whether the submitted key is
    // valid. A 429 from it does not prove the credential was accepted, the
    // same reasoning as OpenAI's `false` above (for a different underlying
    // cause: OpenAI's is an operator-configurable gateway, OpenRouter's own
    // edge is the gateway).
    quotaMeansVerified: false,
  },
```

Also update the "Six providers now, matching yana-ios" doc comment above `AI_PROVIDERS` to note OpenRouter as a 7th provider added independently of the yana-ios parity list (it has no yana-ios equivalent).

- [ ] **Step 5: Update `providers.test.ts`**

Change the `"covers exactly the six supported providers"` test:

```ts
  it("covers exactly the seven supported providers", () => {
    // Six providers match yana-ios's server-callable list; OpenRouter is a
    // seventh added independently (yana-ios has no OpenRouter entry). Apple
    // Intelligence is the iOS client's own extra provider but is
    // on-device-only with no network call, so it has no server-side
    // equivalent and is deliberately excluded here.
    expect(AI_PROVIDERS.map((provider) => provider.key)).toEqual([
      "openai",
      "anthropic",
      "gemini",
      "mistral",
      "qwen",
      "deepseek",
      "openrouter",
    ]);
  });
```

The `"lists its default model among its models"` test already iterates `AI_PROVIDERS` generically — no change needed; it will cover `openrouter/free` automatically.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/lib/ai/providers.test.ts src/lib/ai/defaults.test.ts`
Expected: PASS (Task 1's `defaults.test.ts` assertions now pass too, since `AI_PROVIDERS` includes `openrouter`).

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: PASS. If it fails on a `Record<AiProviderKey, ...>` missing an `openrouter` key somewhere (e.g. `AI_COLUMNS`, `AI_PROBES`, `PROVIDER_ACTIONS`), that is expected until Tasks 3–5 land — note which files failed and continue; each is fixed in its own task below.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ai/providers.ts src/lib/ai/providers.test.ts
git commit -m "feat(ai): register openrouter as a provider"
```

---

### Task 3: `AI_COLUMNS` mapping for OpenRouter

**Files:**
- Modify: `src/lib/ai/columns.ts`

**Interfaces:**
- Consumes: `AiProviderKey` (Task 2), `userSettings.openrouterEnabled`/`openrouterApiKey`/`openrouterModel` (Task 1).
- Produces: `AI_COLUMNS.openrouter = { enabled: "openrouterEnabled", apiKey: "openrouterApiKey", model: "openrouterModel" }`.

- [ ] **Step 1: Add the entry**

In `src/lib/ai/columns.ts`, append to the `AI_COLUMNS` object (after `deepseek`):

```ts
  openrouter: {
    enabled: "openrouterEnabled",
    apiKey: "openrouterApiKey",
    model: "openrouterModel",
  },
```

No test file changes are needed: `columns.test.ts`'s three `describe("AI_COLUMNS", ...)` tests and the `resolveModel` tests all iterate `providersWithColumns()`/`AI_PROVIDERS` generically, so they cover the new entry automatically.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run src/lib/ai/columns.test.ts`
Expected: PASS.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: The `AI_COLUMNS` `satisfies Record<AiProviderKey, AiColumns>` error (if any) is now resolved. Remaining errors, if any, belong to Tasks 4–5.

- [ ] **Step 4: Commit**

```bash
git add src/lib/ai/columns.ts
git commit -m "feat(ai): map openrouter to its user_settings columns"
```

---

### Task 4: OpenRouter probe

**Files:**
- Create: `src/lib/ai/openrouter.ts`
- Create: `src/lib/ai/openrouter.test.ts`
- Modify: `src/lib/ai/probes.ts`

**Interfaces:**
- Consumes: `openaiCompatibleChatProbe()` and `ProbeResult` from `@/lib/integrations/probe`; `OPENROUTER_API_URL` from `./providers`.
- Produces: `testOpenrouterKey({ apiKey, model }): Promise<ProbeResult>`; `AI_PROBES.openrouter`.

- [ ] **Step 1: Write `src/lib/ai/openrouter.ts`**

```ts
import { openaiCompatibleChatProbe } from "@/lib/integrations/probe";
import type { ProbeResult } from "@/lib/integrations/probe";

import { OPENROUTER_API_URL } from "./providers";

/**
 * OpenRouter's endpoint is fixed (no operator setting, see `providers.ts`), so
 * unlike OpenAI's probe there is no URL to validate — this only ever calls
 * the shared OpenAI-compatible probe with a literal endpoint. The base URL
 * itself is `OPENROUTER_API_URL`, imported rather than declared here, so this
 * probe and `run.ts`'s `callOpenrouter()` cannot drift apart on it.
 */
export async function testOpenrouterKey({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): Promise<ProbeResult> {
  return openaiCompatibleChatProbe({
    providerName: "openrouter",
    endpoint: `${OPENROUTER_API_URL}/chat/completions`,
    apiKey,
    model,
  });
}
```

- [ ] **Step 2: Write `src/lib/ai/openrouter.test.ts`**

Mirror `src/lib/ai/mistral.test.ts` exactly (read it first for the precise assertions it makes — status classification for 200/401/403/404/429/network/timeout), replacing every `testMistralKey`/`MISTRAL_API_URL`/`"mistral"` with `testOpenrouterKey`/`OPENROUTER_API_URL`/`"openrouter"`. The shape must include at minimum:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { OPENROUTER_API_URL } from "./providers";
import { testOpenrouterKey } from "./openrouter";

describe("testOpenrouterKey", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("accepts a 200 with a completion", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
      }),
    );
    const result = await testOpenrouterKey({ apiKey: "sk-or-test", model: "openrouter/free" });
    expect(result.ok).toBe(true);
  });

  it("classifies 401 as unauthorized", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    const result = await testOpenrouterKey({ apiKey: "bad", model: "openrouter/free" });
    expect(result).toMatchObject({ ok: false, cause: "unauthorized" });
  });

  it("classifies 429 as quota", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 429 }));
    const result = await testOpenrouterKey({ apiKey: "sk-or-test", model: "openrouter/free" });
    expect(result).toMatchObject({ ok: false, cause: "quota" });
  });

  it("calls the openrouter chat completions endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
          status: 200,
        }),
      );
    globalThis.fetch = fetchMock;
    await testOpenrouterKey({ apiKey: "sk-or-test", model: "openrouter/free" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${OPENROUTER_API_URL}/chat/completions`);
  });
});
```

Add whatever additional cases `mistral.test.ts` has (network/timeout/404) with the same substitutions, so `openrouter.test.ts` has full parity with its sibling.

- [ ] **Step 3: Wire it into `probes.ts`**

In `src/lib/ai/probes.ts`, add the import and the registry entry:

```ts
import { testOpenrouterKey } from "./openrouter";
```

```ts
  openrouter: ({ apiKey, model }) => testOpenrouterKey({ apiKey, model }),
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/ai/openrouter.test.ts src/lib/ai/probes.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: The `AI_PROBES` `Record<AiProviderKey, AiProbe>` error (if any) is now resolved.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/openrouter.ts src/lib/ai/openrouter.test.ts src/lib/ai/probes.ts
git commit -m "feat(ai): add the openrouter credential probe"
```

---

### Task 5: `AIClient` — `callOpenrouter`, and a distinct "credentials rejected" error path

**Files:**
- Modify: `src/lib/ai/run.ts`
- Modify: `src/lib/ai/run.test.ts`

**Interfaces:**
- Consumes: `OPENROUTER_API_URL` from `./providers`.
- Produces: `AIClient.callOpenrouter()` (private); `openrouter` branch in `generateResponse()`'s dispatch; `openrouter_enabled`/`openrouter_api_key`/`openrouter_model` on `AiRuntimeSettings`; exported `ProviderUnauthorizedError` class; `AiGenerationResult["reason"]` gains `"providerUnauthorized"`.

- [ ] **Step 1: Import the new endpoint constant**

```ts
import { DEEPSEEK_API_URL, MISTRAL_API_URL, OPENROUTER_API_URL, QWEN_API_URL } from "./providers";
```

- [ ] **Step 2: Add the OpenRouter fields to `AiRuntimeSettings`**

After the `deepseek_model` line:

```ts
  openrouter_enabled?: boolean;
  openrouter_api_key?: string;
  openrouter_model?: string;
```

- [ ] **Step 3: Add `ProviderUnauthorizedError` and extend `AiGenerationResult`**

Near the top of the file, beside `AiRequestBody`:

```ts
/**
 * Thrown by `requestWithRetry()` on a 401 or 403 from the provider -- the
 * credential itself was rejected, not a transient failure. Not retried (same
 * as every other non-429 status), and deliberately a distinct type from a
 * plain failure so `generateResponse()`'s catch can tell "the stored key is
 * bad" from "something else went wrong" without threading a status code
 * through every intermediate `callXxx()` method.
 */
class ProviderUnauthorizedError extends Error {}
```

Change the `AiGenerationResult` type:

```ts
export type AiGenerationResult =
  | { ok: true; text: string }
  | {
      ok: false;
      reason:
        | "noProvider"
        | "dailyLimitExceeded"
        | "monthlyLimitExceeded"
        | "providerUnauthorized"
        | "providerError";
    };
```

- [ ] **Step 4: Throw in `requestWithRetry()` on 401/403**

In `requestWithRetry()`, the block that currently reads:

```ts
        console.warn(`AI API call failed with status ${response.status}: ${response.statusText}`);
        return null;
```

Change it to:

```ts
        if (response.status === 401 || response.status === 403) {
          throw new ProviderUnauthorizedError(
            `AI provider rejected the credentials (status ${response.status}).`,
          );
        }

        console.warn(`AI API call failed with status ${response.status}: ${response.statusText}`);
        return null;
```

This is inside the `for` loop's `try`; the outer `catch (err: unknown)` block in the same method catches *fetch* rejections, not a value thrown from inside the `try` after a successful `fetch` resolves — check this at implementation time: if the `throw` above lands inside the same `try` whose `catch (err: unknown)` treats every caught value as a retryable-or-not transport failure, it must **not** be caught there. Read the surrounding function fully before editing; if the 401/403 check and its `throw` are already outside that `try`/`catch`'s scope for the `response.ok` branch (they are — that block runs after `const response = await fetch(...)` and `clearTimeout(timeoutId)` inside the try, but the `catch` below only wraps the `fetch` call's own rejection), confirm with a quick read that a `throw` there propagates past this method uncaught. It does: the `catch (err: unknown)` block is written to handle a *rejected* `fetch`, and control only reaches the `if (response.status === 401 ...)` line after `fetch` already resolved successfully — so a `throw` there exits the `try` block, is not a "thrown value inside a try is caught by the try's own catch" situation in JS (a `catch` only catches, it does not catch a throw from *inside itself* recursively — but it **does** catch anything thrown anywhere in the preceding `try` block, since `try`/`catch` in JS makes the whole `try` body subject to the `catch`). **This means the naive placement above IS caught by the method's own `catch (err: unknown)` block**, which today does:

```ts
      } catch (err: unknown) {
        if (attempt < maxRetries && errorStatus(err) === 429) { ... }
        console.warn(`AI API request error: ${describeError(err)}`);
        return null;
      }
```

`errorStatus(err)` would not find a `.status` on a plain `Error`, so it falls through to `return null` — silently swallowing the new error instead of propagating it. **Fix:** re-throw `ProviderUnauthorizedError` at the top of that `catch` block, before anything else runs:

```ts
      } catch (err: unknown) {
        if (err instanceof ProviderUnauthorizedError) throw err;
        if (attempt < maxRetries && errorStatus(err) === 429) {
```

- [ ] **Step 5: Update `generateResponse()`'s catch block**

Change:

```ts
    } catch (e: unknown) {
      console.warn(`AI API call failed: ${describeError(e)}`);
      return { ok: false, reason: "providerError" };
    }
```

to:

```ts
    } catch (e: unknown) {
      if (e instanceof ProviderUnauthorizedError) {
        console.warn(`AI provider rejected the stored credentials: ${describeError(e)}`);
        return { ok: false, reason: "providerUnauthorized" };
      }
      console.warn(`AI API call failed: ${describeError(e)}`);
      return { ok: false, reason: "providerError" };
    }
```

- [ ] **Step 6: Add `callOpenrouter()` and wire the dispatch**

After `callDeepseek()`:

```ts
  private async callOpenrouter(prompt: string, jsonMode: boolean): Promise<string | null> {
    const enabled = this.settings.openrouterEnabled ?? this.settings.openrouter_enabled;
    const apiKey = this.settings.openrouterApiKey ?? this.settings.openrouter_api_key;
    if (!enabled || !apiKey) {
      console.warn("OpenRouter is not enabled or configured.");
      return null;
    }
    const model = this.settings.openrouterModel ?? this.settings.openrouter_model ?? "openrouter/free";
    const timeout = this.settings.aiRequestTimeout ?? this.settings.ai_request_timeout ?? 30;
    return this.callOpenaiCompatible(OPENROUTER_API_URL, apiKey, model, prompt, jsonMode, timeout);
  }
```

In `generateResponse()`'s `if`/`else if` provider dispatch chain, add before the `else { console.warn(\`Unknown AI provider...\`)` fallback:

```ts
      } else if (this.provider === "openrouter") {
        text = await this.callOpenrouter(prompt, jsonMode);
      } else {
```

- [ ] **Step 7: Update `run.test.ts`'s `makeSettings()` helper and provider-dispatch imports**

Add the import:

```ts
import {
  AI_PROVIDERS,
  DEEPSEEK_API_URL,
  MISTRAL_API_URL,
  OPENAI_DEFAULT_API_URL,
  OPENROUTER_API_URL,
  QWEN_API_URL,
} from "./providers";
```

`makeSettings()` doesn't need an `openrouter*` block added by hand — the generic `"generateResponse across every registered provider"` test builds its own settings per-provider via `AI_COLUMNS`, which will include `openrouter` automatically once Tasks 2–3 land.

- [ ] **Step 8: Extend the two provider-keyed switches in the generic dispatch test**

In `responseShapeFor()`, `openrouter` already falls into the existing `default` branch (shared OpenAI-compatible shape) — update the comment listing to include it:

```ts
        default:
          // openai, mistral, qwen, deepseek, openrouter: the shared
          // OpenAI-compatible shape.
          return { choices: [{ message: { content: text } }] };
```

In `expectedUrlFor()`, add an explicit case (this switch has no `default`):

```ts
        case "openrouter":
          return `${OPENROUTER_API_URL}/chat/completions`;
```

- [ ] **Step 9: Add a test for the new `providerUnauthorized` path**

After the existing `"does NOT retry non-429 errors"` test (which uses a 500 and asserts `{ ok: false }` with 1 fetch call — leave that test as-is, it still passes unchanged since 500 is untouched by this change), add:

```ts
    it("reports providerUnauthorized on a 401 without retrying", async () => {
      const settings = makeSettings({
        activeAiProvider: "gemini",
        aiMaxRetries: 3,
        aiRetryDelay: 0,
      });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      fetchMock.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toMatchObject({ ok: false, reason: "providerUnauthorized" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("reports providerUnauthorized on a 403 without retrying", async () => {
      const settings = makeSettings({
        activeAiProvider: "gemini",
        aiMaxRetries: 3,
        aiRetryDelay: 0,
      });
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      fetchMock.mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toMatchObject({ ok: false, reason: "providerUnauthorized" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("still reports plain providerError on a 500, distinct from providerUnauthorized", async () => {
      const settings = makeSettings({
        activeAiProvider: "gemini",
        aiMaxRetries: 3,
        aiRetryDelay: 0,
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const client = new AIClient(settings);
      const result = await client.generateResponse("test prompt");

      expect(result).toMatchObject({ ok: false, reason: "providerError" });
    });
```

- [ ] **Step 10: Run the tests**

Run: `npx vitest run src/lib/ai/run.test.ts`
Expected: PASS, including the new `openrouter` case in the `it.each(AI_PROVIDERS...)` generic dispatch test and the three new unauthorized/error tests.

- [ ] **Step 11: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/lib/ai/run.ts src/lib/ai/run.test.ts
git commit -m "feat(ai): add openrouter to AIClient and classify 401/403 as providerUnauthorized"
```

---

### Task 6: `/api/v1/ai/prompt` — `provider_unauthorized` error code

**Files:**
- Modify: `src/app/api/v1/ai/prompt/route.ts`
- Modify: `src/app/api/v1/ai/prompt/route.test.ts`

**Interfaces:**
- Consumes: `AiGenerationResult["reason"] === "providerUnauthorized"` (Task 5).
- Produces: `ApiError(502, "provider_unauthorized", ...)` on that reason.

- [ ] **Step 1: Write the failing test**

In `src/app/api/v1/ai/prompt/route.test.ts`, after the `"returns the provider's completion for a newly-added provider (deepseek)"` test, add:

```ts
  it("502s with provider_unauthorized when the stored credentials are rejected", async () => {
    const token = await ownerToken();
    const owner = client
      .getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "o@example.com"))
      .get()!;
    client.writeTransaction((tx) => {
      tx.update(schema.userSettings)
        .set({
          anthropicEnabled: true,
          anthropicApiKey: "sk-ant-revoked",
          anthropicModel: "claude-haiku-4-5",
          activeAiProvider: "anthropic",
        })
        .where(eq(schema.userSettings.userId, owner.id))
        .run();
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 401 })),
    );

    const response = await promptRequest(token, { prompt: "hello" });

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.error.code).toBe("provider_unauthorized");
    vi.unstubAllGlobals();
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/app/api/v1/ai/prompt/route.test.ts -t "provider_unauthorized"`
Expected: FAIL — the route currently answers `provider_error` for every non-ok result reason it doesn't special-case.

- [ ] **Step 3: Add the route branch**

In `src/app/api/v1/ai/prompt/route.ts`, before the generic fallback:

```ts
      if (result.reason === "noProvider") {
        throw new ApiError(409, "no_active_provider", "No AI provider is configured.");
      }
      if (result.reason === "providerUnauthorized") {
        throw new ApiError(
          502,
          "provider_unauthorized",
          "The configured AI provider rejected the stored credentials.",
        );
      }
      throw new ApiError(502, "provider_error", "The AI provider could not fulfil this prompt.");
```

(Insert the new `if` block between the existing `noProvider` branch and the final generic `throw`.)

- [ ] **Step 4: Run the test again**

Run: `npx vitest run src/app/api/v1/ai/prompt/route.test.ts`
Expected: PASS, all tests in the file including the new one.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/v1/ai/prompt/route.ts src/app/api/v1/ai/prompt/route.test.ts
git commit -m "feat(api): distinguish provider_unauthorized from provider_error on /api/v1/ai/prompt"
```

---

### Task 7: `defineIntegration()` descriptor for OpenRouter in `actions.ts`

**Files:**
- Modify: `src/lib/ai/actions.ts`
- Modify: `src/lib/ai/actions.test.ts`

**Interfaces:**
- Consumes: `AI_COLUMNS.openrouter` (Task 3), `AI_PROBES.openrouter` (Task 4), `registryEntry("openrouter")` (Task 2).
- Produces: `PROVIDER_KEYS.openrouter`; an `openrouter` `defineIntegration()` const, added to `PROVIDER_ACTIONS`; a permissive `openrouterModelField` zod schema (distinct from the enum-style `modelField()`).

- [ ] **Step 1: Add the permissive model field**

Beside `modelField()`, add:

```ts
/**
 * OpenRouter's model field, deliberately **not** `modelField()`'s
 * enum-membership check. That helper validates against `provider.models`, a
 * static array -- correct for the other six providers, wrong here: a valid
 * OpenRouter model id comes from a live catalog (`listOpenrouterModels()`
 * below) the server does not re-fetch at submit time. An actually-invalid id
 * is still refused, by OpenRouter itself at probe time, surfacing through the
 * existing generic `unexpected` probe-failure path.
 */
const openrouterModelField = z.string().trim().min(1).max(200);
```

- [ ] **Step 2: Add `PROVIDER_KEYS.openrouter`**

Add to the `PROVIDER_KEYS` object:

```ts
  openrouter: {
    required: "openrouter.required",
    rejected: "openrouter.rejected",
    quota: "openrouter.rateLimited",
    // Declared for shape-consistency with the other six providers'
    // `Record<AiProviderKey, ...>` entry, but never wired into a provider's
    // `fieldErrorKeys` below: there is no static model list to validate
    // against before the probe runs, so an unknown OpenRouter model id is
    // reported through the generic `unexpected` probe-failure path instead.
    modelUnknown: "openrouter.modelUnknown",
  },
```

- [ ] **Step 3: Add the `openrouter` `defineIntegration()` const**

After the `deepseek` const:

```ts
const openrouter = defineIntegration({
  provider: "openrouter",
  schema: z.object({ apiKey: secretField, model: openrouterModelField }),
  fields: {
    apiKey: { column: AI_COLUMNS.openrouter.apiKey, secret: true },
    model: { column: AI_COLUMNS.openrouter.model, secret: false },
  },
  flagColumn: AI_COLUMNS.openrouter.enabled,
  requiredKey: PROVIDER_KEYS.openrouter.required,
  probe: AI_PROBES.openrouter,
  keys: {
    rejected: PROVIDER_KEYS.openrouter.rejected,
    quota: PROVIDER_KEYS.openrouter.quota,
    quotaMeansVerified: registryEntry("openrouter").quotaMeansVerified,
  },
});
```

Note: no `fieldErrorKeys` entry at all (unlike the other six, which map `"model:custom"` to their `modelUnknown` key) — `openrouterModelField` has no `.refine()`, so it never produces a `custom` zod issue to map.

- [ ] **Step 4: Add it to `PROVIDER_ACTIONS`**

```ts
const PROVIDER_ACTIONS: Record<AiProviderKey, IntegrationActions<AiKey>> = {
  openai,
  anthropic,
  gemini,
  mistral,
  qwen,
  deepseek,
  openrouter,
};
```

- [ ] **Step 5: Add `listOpenrouterModels()`**

Add near the bottom of the file, after `saveAdvanced()`:

```ts
/** One entry OpenRouter's `/models` endpoint reports, normalized for the select. */
export type OpenrouterModelOption = { value: string; label: string };

export type OpenrouterModelsResult =
  | { ok: true; models: OpenrouterModelOption[] }
  | { ok: false; errorKey: AiKey };

/** Every field this reads off one entry of OpenRouter's public `/models` response. */
type OpenrouterModelEntry = {
  id?: unknown;
  name?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
};

/**
 * The live OpenRouter model catalog, fetched on demand -- never cached, since
 * the refresh is button-triggered (see the design spec). Public,
 * unauthenticated endpoint: this takes no credential and is safe to call
 * before any OpenRouter key has been saved.
 *
 * Every failure -- network, timeout, a non-200, an unparseable body --
 * collapses to one outcome. Unlike the credential probes' `unreachable`/
 * `timedOut`/`unexpected` catalog keys, this does **not** reuse them: those
 * are worded "...these credentials could not be verified," which is wrong
 * here -- no credential is involved in listing models.
 */
export async function listOpenrouterModels(): Promise<OpenrouterModelsResult> {
  try {
    const response = await fetch(`${OPENROUTER_API_URL}/models`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return { ok: false, errorKey: "openrouter.modelsFetchFailed" };
    }
    const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
    if (!body || !Array.isArray(body.data)) {
      return { ok: false, errorKey: "openrouter.modelsFetchFailed" };
    }

    const models: OpenrouterModelOption[] = [];
    for (const entry of body.data as OpenrouterModelEntry[]) {
      if (typeof entry.id !== "string" || typeof entry.name !== "string") continue;
      const isFree = entry.pricing?.prompt === "0" && entry.pricing?.completion === "0";
      models.push({ value: entry.id, label: isFree ? `${entry.name} (Free)` : entry.name });
    }
    // Free entries first: a user hunting for a $0 model should not have to
    // scroll past hundreds of paid ones to find one.
    models.sort((a, b) => Number(b.label.endsWith("(Free)")) - Number(a.label.endsWith("(Free)")));

    if (models.length === 0) {
      return { ok: false, errorKey: "openrouter.modelsFetchFailed" };
    }
    return { ok: true, models };
  } catch {
    return { ok: false, errorKey: "openrouter.modelsFetchFailed" };
  }
}
```

Add `OPENROUTER_API_URL` to the existing `import { ... } from "./providers"` line at the top of `actions.ts`.

- [ ] **Step 6: Extend `actions.test.ts`**

Read `src/lib/ai/actions.test.ts` first to find its existing per-provider save/test/remove test blocks (likely parameterized or repeated per provider). Add an `openrouter` case following the same shape as the `deepseek` (or nearest fixed-endpoint, no-apiUrl) provider's tests for `saveProvider`, `testProvider`, and `removeProvider`.

Then add a new `describe("listOpenrouterModels", ...)` block:

```ts
describe("listOpenrouterModels", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the parsed catalog with free entries labeled and sorted first", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "vendor/paid-model", name: "Paid Model", pricing: { prompt: "0.001", completion: "0.002" } },
            { id: "vendor/free-model:free", name: "Free Model", pricing: { prompt: "0", completion: "0" } },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await listOpenrouterModels();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models[0]).toEqual({ value: "vendor/free-model:free", label: "Free Model (Free)" });
      expect(result.models[1]).toEqual({ value: "vendor/paid-model", label: "Paid Model" });
    }
  });

  it("reports modelsFetchFailed on a non-200 response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
    const result = await listOpenrouterModels();
    expect(result).toEqual({ ok: false, errorKey: "openrouter.modelsFetchFailed" });
  });

  it("reports modelsFetchFailed when the fetch rejects", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await listOpenrouterModels();
    expect(result).toEqual({ ok: false, errorKey: "openrouter.modelsFetchFailed" });
  });

  it("reports modelsFetchFailed on an unparseable body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    const result = await listOpenrouterModels();
    expect(result).toEqual({ ok: false, errorKey: "openrouter.modelsFetchFailed" });
  });
});
```

Add `listOpenrouterModels` to the existing `import { ... } from "./actions"` line at the top of `actions.test.ts`, and `afterEach`/`vi` to its vitest import line if not already present.

- [ ] **Step 7: Run the tests**

Run: `npx vitest run src/lib/ai/actions.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS — every `Record<AiProviderKey, ...>` in the codebase is now exhaustive.

- [ ] **Step 9: Commit**

```bash
git add src/lib/ai/actions.ts src/lib/ai/actions.test.ts
git commit -m "feat(ai): wire openrouter into the ai actions, add listOpenrouterModels"
```

---

### Task 8: Message catalogs

**Files:**
- Modify: `messages/en.json`
- Modify: `messages/de.json`

**Interfaces:**
- Produces: `ai.openrouter.{required,rejected,quota,modelUnknown}`; `ai.openrouter.modelsFetchFailed`; `ai.provider.refreshModels`; `ai.provider.refreshingModels`.

- [ ] **Step 1: Add the `ai.openrouter` block to `messages/en.json`**

Insert after the `"deepseek"` block inside `"ai"`:

```json
  "openrouter": {
    "required": "Enter an API key first.",
    "rejected": "OpenRouter would not accept these credentials. Check the API key, that the account still has credit or is using a free model, and that it may use the selected model.",
    "rateLimited": "The key is valid — OpenRouter is rate limiting it right now. It works again shortly.",
    "modelUnknown": "Choose one of the models Yana offers for OpenRouter.",
    "modelsFetchFailed": "Could not load the current model list from OpenRouter. Try again in a moment."
  },
```

- [ ] **Step 2: Add the refresh-button keys to the `ai.provider` block**

Add two keys inside the existing `"provider": { ... }` object in `messages/en.json`:

```json
    "refreshModels": "Refresh models",
    "refreshingModels": "Refreshing"
```

- [ ] **Step 3: Mirror both additions in `messages/de.json`**

```json
  "openrouter": {
    "required": "Trage zuerst einen API-Schlüssel ein.",
    "rejected": "OpenRouter hat diese Zugangsdaten nicht akzeptiert. Prüfe den API-Schlüssel, ob das Konto noch Guthaben hat oder ein kostenloses Modell verwendet wird, und ob es das gewählte Modell nutzen darf.",
    "rateLimited": "Der Schlüssel ist gültig — OpenRouter begrenzt ihn gerade. In Kürze funktioniert er wieder.",
    "modelUnknown": "Wähle eines der Modelle, die Yana für OpenRouter anbietet.",
    "modelsFetchFailed": "Die aktuelle Modellliste konnte nicht von OpenRouter geladen werden. Versuche es gleich noch einmal."
  },
```

```json
    "refreshModels": "Modelle aktualisieren",
    "refreshingModels": "Wird aktualisiert"
```

- [ ] **Step 4: Run the catalog-parity test**

Run: `npx vitest run src/i18n/messages.test.ts`
Expected: PASS — identical key sets in both files.

- [ ] **Step 5: Commit**

```bash
git add messages/en.json messages/de.json
git commit -m "feat(i18n): add openrouter and refresh-models catalog strings"
```

---

### Task 9: `/ai` UI — OpenRouter tab and the "Refresh models" control

**Files:**
- Modify: `src/components/ai/provider-section.tsx`

**Interfaces:**
- Consumes: `AI_PROVIDERS` (now includes `openrouter`, Task 2), `listOpenrouterModels()` (Task 7), `t("provider.refreshModels")`/`t("provider.refreshingModels")` (Task 8).
- Produces: no new exports — this is a leaf UI change. `AI_PROVIDERS.map(...)` already renders every provider generically via `providerItems`, so the picker itself needs **no** OpenRouter-specific code; only the model `<Select>` area needs the refresh control.

- [ ] **Step 1: Add local state for the fetched model catalog**

Near the other `useState` calls in `ProviderSection`:

```ts
  const [fetchedModels, setFetchedModels] = useState<{ value: string; label: string }[] | null>(
    null,
  );
  const [refreshingModels, startRefreshModels] = useTransition();
```

- [ ] **Step 2: Reset the fetched catalog when switching providers**

In `choose()`, add:

```ts
    setFetchedModels(null);
```

(so switching away from OpenRouter and back doesn't show a stale fetch from a previous session on screen — it re-shows the static fallback until refreshed again).

- [ ] **Step 3: Derive `modelItems` from the fetched catalog when present**

Change:

```ts
  const modelItems = provider ? provider.models.map(({ value, label }) => ({ value, label })) : [];
```

to:

```ts
  const modelItems = provider
    ? (provider.hasDynamicModels && fetchedModels
        ? fetchedModels
        : provider.models
      ).map(({ value, label }) => ({ value, label }))
    : [];
```

- [ ] **Step 4: Add the refresh handler**

Near `test()`:

```ts
  function refreshModels() {
    if (!provider?.hasDynamicModels) return;
    startRefreshModels(async () => {
      const result = await listOpenrouterModels();
      if (result.ok) {
        setFetchedModels(result.models);
      } else {
        toast.error(t(result.errorKey));
      }
    });
  }
```

Add the import: `import { listOpenrouterModels } from "@/lib/ai/actions";` beside the existing `@/lib/ai/actions` import, and fold it into the existing named-import list rather than a second import statement.

- [ ] **Step 5: Render the button beside the model `<Select>`**

In the `modelControl` prop passed to `ProviderSectionShell`, wrap the existing `<Select>` and add the button after it when `provider?.hasDynamicModels`:

```tsx
      modelControl={
        provider ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select
              items={modelItems}
              value={model}
              disabled={busy || refreshingModels}
              onValueChange={(value) => {
                if (value === null) return;
                setModel(value);
              }}
            >
              <SelectTrigger id="ai-model" className="w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {provider.hasDynamicModels ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy || refreshingModels}
                onClick={refreshModels}
              >
                {refreshingModels ? t("provider.refreshingModels") : t("provider.refreshModels")}
              </Button>
            ) : null}
          </div>
        ) : null
      }
```

- [ ] **Step 6: Manual verification (this is a client-component UI change — verify it in the browser, not just typecheck)**

Run: `npm run dev`, sign in, go to `/ai`, select "OpenRouter" in the provider picker, confirm the model select shows "Free (auto-routed)" and "Auto (any model, may cost)", click "Refresh models", and confirm the dropdown repopulates with the live catalog (this can be checked against the token the user supplied earlier in this conversation — do **not** commit that token anywhere; use it only in the browser's own input field to manually confirm Save/Test work end to end).

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/ai/provider-section.tsx
git commit -m "feat(ai): add openrouter's refresh-models control to the provider section"
```

---

### Task 10: Full verification pass and push

**Files:** none (verification only).

- [ ] **Step 1: Run the full check suite**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
```

Expected: all four PASS.

- [ ] **Step 2: Manually verify the live OpenRouter probe once, with a real key**

This is the one step in the whole plan that needs a real network call and a real key (the user supplied one earlier in this conversation, for exactly this purpose). In the running dev server's `/ai` page: select OpenRouter, paste the key, leave the model on the default `openrouter/free`, press "Test". Confirm it reports success. This is the mandatory pre-release manual pass CLAUDE.md requires for every new AI provider probe before it reaches a user (see "Carried forward from phase 7's review").

- [ ] **Step 3: Push and open a PR**

```bash
git push -u origin claude/openrouter-api-support-ac5e0f
gh pr create --title "feat(ai): add OpenRouter provider with auto-collected model catalog" --body "$(cat <<'EOF'
## Summary
- Adds OpenRouter as a 7th AI provider, following the existing Mistral/Qwen/DeepSeek shape (fixed endpoint, shared probe).
- Model list is auto-collected live from OpenRouter's public /models endpoint via a manual "Refresh models" button, defaulting to OpenRouter's own $0-guaranteed `openrouter/free` router.
- /api/v1/ai/prompt gains a distinct `provider_unauthorized` error code, separate from the generic `provider_error`, when the active provider rejects the stored credentials (401/403).

## Test plan
- [x] npm run lint && npm run format:check && npm run typecheck && npm test
- [x] Manual live probe test against a real OpenRouter API key
- [x] Manual browser check of the /ai OpenRouter tab and Refresh models button
EOF
)"
```

- [ ] **Step 4: Merge the PR into `main`**

```bash
gh pr merge --merge
```

Confirm afterward with `git log origin/main -3` that the merge commit landed.
