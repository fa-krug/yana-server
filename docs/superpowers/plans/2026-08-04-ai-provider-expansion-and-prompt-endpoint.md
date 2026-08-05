# AI Provider Expansion + Mobile Prompt Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Mistral, Qwen and DeepSeek to the AI provider registry; add real
enforcement of the (currently decorative) daily/monthly AI request limits at
a shared chokepoint; add `POST /api/v1/ai/prompt` so the mobile client can
run a free-form prompt against the caller's configured provider.

**Architecture:** Three independent per-provider registry expansions
(mirroring the existing OpenAI/Anthropic/Gemini pattern exactly, sharing a
new OpenAI-compatible request/probe helper since all six providers speak the
same `/chat/completions` shape), a new `ai_requests` table + a
check-and-record function called from `AIClient.generateResponse()`, and one
new `route.ts` that composes both.

**Tech Stack:** Next.js 16 route handlers, Drizzle ORM + better-sqlite3, zod,
Vitest (real migrated SQLite per test, no driver mocks).

## Global Constraints

- Every write goes through `writeTransaction()` (`BEGIN IMMEDIATE`) — never a
  raw `connection.exec`/`prepare` outside it, and its callback must be
  synchronous.
- `redirect: "error"` on every outbound provider `fetch` — no real provider
  endpoint redirects a POST, and following one would bypass any host
  validation.
- A provider's `detail`/error text is never returned to a client or shown in
  a toast — only a catalog key (web) or a machine-readable `ApiError.code`
  (mobile API) crosses the wire. Nothing from a provider's response body is
  ever interpolated into a log line or result.
- `messages/en.json` and `messages/de.json` must stay key-for-key identical
  (`src/i18n/messages.test.ts` enforces this).
- New/changed types are checked by `npm run typecheck`; new `user_settings`
  columns get a `drizzle-kit generate` migration, never a hand-written one.
- Real-database tests only (`src/lib/db/test-support.ts`'s
  `applyMigrations()`/`freshDrizzle()`/`applyMigrationsAt()`) — no mocked
  driver.
- `.test.ts` (this plan touches only node-project files — nothing here is a
  component).

---

### Task 1: Schema — add the three new providers' `user_settings` columns

**Files:**
- Modify: `src/lib/db/schema/users.ts` (add nine columns, right after the
  existing `geminiModel` column and before the `// --- Global AI tuning`
  comment)
- Modify: `src/lib/ai/defaults.test.ts` (extend to cover the three new
  providers' defaults)
- Create: a new migration via `drizzle-kit generate`

**Interfaces:**
- Produces: nine new `userSettings` columns —
  `mistralEnabled`/`mistralApiKey`/`mistralModel`,
  `qwenEnabled`/`qwenApiKey`/`qwenModel`,
  `deepseekEnabled`/`deepseekApiKey`/`deepseekModel` — that Tasks 4-6 read
  and write.

- [ ] **Step 1: Add the nine columns to the schema**

In `src/lib/db/schema/users.ts`, insert after the existing
`geminiModel: text("gemini_model").notNull().default("gemini-3.5-flash-lite"),`
line and before the `// --- Global AI tuning` comment:

```ts
    mistralEnabled: integer("mistral_enabled", { mode: "boolean" }).notNull().default(false),
    mistralApiKey: text("mistral_api_key").notNull().default(""),
    mistralModel: text("mistral_model").notNull().default("mistral-small-latest"),

    qwenEnabled: integer("qwen_enabled", { mode: "boolean" }).notNull().default(false),
    qwenApiKey: text("qwen_api_key").notNull().default(""),
    qwenModel: text("qwen_model").notNull().default("qwen3.5-flash"),

    deepseekEnabled: integer("deepseek_enabled", { mode: "boolean" }).notNull().default(false),
    deepseekApiKey: text("deepseek_api_key").notNull().default(""),
    deepseekModel: text("deepseek_model").notNull().default("deepseek-v4-flash"),
```

These defaults are hand-maintained duplicates of the `defaultModel` values
Task 4-6 will add to `src/lib/ai/providers.ts` — `defaults.test.ts` (Step 3
below) is what keeps the two honest, exactly like the existing three
providers.

- [ ] **Step 2: Generate the migration**

Run:
```bash
npx drizzle-kit generate
```
Expected: a new `drizzle/NNNN_<generated-name>.sql` file containing nine
`ALTER TABLE user_settings ADD COLUMN ...` statements (pure additions, so
this runs non-interactively), plus an updated `drizzle/meta/_journal.json`
and a new `drizzle/meta/NNNN_snapshot.json`.

- [ ] **Step 3: Extend `defaults.test.ts` for the three new providers**

Open `src/lib/ai/defaults.test.ts` and add three more assertions in the same
shape the existing ones use for `anthropicModel`/`geminiModel` (read the
file first to match its exact fixture-row-insert pattern), asserting a bare
inserted row's `mistralModel`/`qwenModel`/`deepseekModel` equal
`"mistral-small-latest"`/`"qwen3.5-flash"`/`"deepseek-v4-flash"` — the same
three literals from Step 1.

- [ ] **Step 4: Run the test**

Run: `npm test -- defaults.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/lib/db/schema/users.ts src/lib/ai/defaults.test.ts drizzle/
git commit -m "feat(db): add mistral, qwen and deepseek columns to user_settings"
```

---

### Task 2: Extract a shared OpenAI-compatible probe helper

**Files:**
- Modify: `src/lib/integrations/probe.ts` (add
  `openaiCompatibleChatProbe()`)
- Modify: `src/lib/ai/openai.ts` (use it)
- Test: `src/lib/ai/openai.test.ts` (must keep passing unchanged — this task
  is a pure refactor, no behavior change)

**Interfaces:**
- Produces: `openaiCompatibleChatProbe({ providerName, endpoint, apiKey,
  model }): Promise<ProbeResult>` — Tasks 4-6's probe modules call this.
- Consumes: `PROBE_TIMEOUT_MS`, `readJson`, `transportFailure`, `ProbeResult`
  (already exported from `probe.ts`).

- [ ] **Step 1: Add the shared function to `probe.ts`**

Add to `src/lib/integrations/probe.ts` (after the existing exports):

```ts
/**
 * The OpenAI-compatible `/chat/completions` probe body every provider that
 * speaks this shape shares — OpenAI itself, plus Mistral, Qwen and DeepSeek.
 * `endpoint` must already be a validated, trusted URL: only OpenAI has an
 * operator-supplied one, and that validation (scheme, no userinfo) stays in
 * `src/lib/ai/openai.ts`, which calls this only once the URL is confirmed.
 *
 * One 1-token chat completion, exactly like `testOpenaiKey()`'s original
 * probe: it proves the key and the model id together, and
 * `max_completion_tokens` (not the deprecated `max_tokens`) so a reasoning
 * model is not refused.
 */
export async function openaiCompatibleChatProbe({
  providerName,
  endpoint,
  apiKey,
  model,
}: {
  providerName: string;
  endpoint: string;
  apiKey: string;
  model: string;
}): Promise<ProbeResult> {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "hi" }],
        max_completion_tokens: 1,
      }),
      // See the redirect note on the OpenAI probe this was extracted from:
      // no real provider endpoint redirects a POST, and following one would
      // bypass any host validation a caller performed before calling this.
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (response.ok) {
      const body = (await readJson(response)) as { choices?: unknown } | null;
      if (Array.isArray(body?.choices) && body.choices.length > 0) {
        return { ok: true, detail: "Key accepted." };
      }
      return { ok: false, cause: "unexpected", detail: "A 200 answer carried no completion." };
    }

    const body = (await readJson(response)) as { error?: { type?: unknown } } | null;
    const errorType = typeof body?.error?.type === "string" ? body.error.type : "";

    if (errorType === "insufficient_quota") {
      return {
        ok: false,
        cause: "unauthorized",
        detail: "The key was accepted but the account is out of credit.",
      };
    }
    if (response.status === 429) {
      return { ok: false, cause: "quota", detail: "Rate limited before a verdict was reached." };
    }
    if (response.status === 401) {
      return { ok: false, cause: "unauthorized", detail: "The API key was rejected." };
    }
    if (response.status === 403) {
      return { ok: false, cause: "unauthorized", detail: "Access was refused for this API key." };
    }
    if (response.status === 404) {
      return { ok: false, cause: "unexpected", detail: "No such model or endpoint (404)." };
    }
    if (response.status === 400) {
      return {
        ok: false,
        cause: "unexpected",
        detail: "The endpoint rejected the request as malformed (400).",
      };
    }
    return { ok: false, cause: "unexpected", detail: `Unexpected status ${response.status}.` };
  } catch (error) {
    return transportFailure(providerName, error, `Could not reach the ${providerName} API.`);
  }
}
```

- [ ] **Step 2: Rewrite `testOpenaiKey()` to call it**

In `src/lib/ai/openai.ts`, replace the body of `testOpenaiKey()` from the
`try {` line through its matching `catch` block with:

```ts
  const base = (apiUrl?.trim() || OPENAI_DEFAULT_API_URL).replace(/\/+$/, "");
  const target = `${base}/chat/completions`;

  if (!URL.canParse(target)) {
    return { ok: false, cause: "unexpected", detail: "The configured API URL is not a URL." };
  }
  const endpoint = new URL(target);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    return {
      ok: false,
      cause: "unexpected",
      detail: "The configured API URL is not an http(s) URL.",
    };
  }
  if (endpoint.username !== "" || endpoint.password !== "") {
    return {
      ok: false,
      cause: "unexpected",
      detail: "The configured API URL carries a username or password.",
    };
  }

  return openaiCompatibleChatProbe({ providerName: "openai", endpoint: target, apiKey, model });
```

Update the import line at the top of `openai.ts` to also pull in
`openaiCompatibleChatProbe` from `@/lib/integrations/probe`, and remove the
now-unused `readJson`/`transportFailure` imports if nothing else in the file
uses them (check before deleting — `PROBE_TIMEOUT_MS` and the re-exported
`OPENAI_DEFAULT_API_URL` are still needed).

- [ ] **Step 3: Run the existing OpenAI probe tests unchanged**

Run: `npm test -- openai.test.ts`
Expected: PASS, with no test file changes — this step is the proof the
refactor changed no behavior.

- [ ] **Step 4: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add src/lib/integrations/probe.ts src/lib/ai/openai.ts
git commit -m "refactor(ai): extract a shared OpenAI-compatible probe helper"
```

---

### Task 3: Extract a shared OpenAI-compatible `AIClient` call helper

**Files:**
- Modify: `src/lib/ai/run.ts` (add `callOpenaiCompatible()`, rewrite
  `callOpenai()` to use it)
- Test: `src/lib/ai/run.test.ts` (must keep passing unchanged)

**Interfaces:**
- Produces (private method on `AIClient`):
  `callOpenaiCompatible(baseUrl: string, apiKey: string, model: string,
  prompt: string, jsonMode: boolean, timeout: number): Promise<string |
  null>` — Tasks 4-6's `callMistral`/`callQwen`/`callDeepseek` methods call
  this.

- [ ] **Step 1: Add the shared method**

In `src/lib/ai/run.ts`, add this private method to the `AIClient` class
(placed right before `callOpenai`):

```ts
  /**
   * The `/chat/completions` request/response shape every OpenAI-compatible
   * provider shares. `callOpenai()` and the Mistral/Qwen/DeepSeek branches
   * all call this with their own resolved base URL, key and model — only
   * OpenAI's base URL is an operator setting, so only `callOpenai()` needs
   * to resolve one before calling in.
   */
  private async callOpenaiCompatible(
    baseUrl: string,
    apiKey: string,
    model: string,
    prompt: string,
    jsonMode: boolean,
    timeout: number,
  ): Promise<string | null> {
    const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const temperature = this.settings.aiTemperature ?? this.settings.ai_temperature ?? 0.7;
    const maxTokens = this.settings.aiMaxTokens ?? this.settings.ai_max_tokens ?? 1000;

    const data: AiRequestBody = {
      model,
      messages: [{ role: "user", content: prompt }],
      temperature,
      max_tokens: maxTokens,
    };
    if (jsonMode) {
      data.response_format = { type: "json_object" };
    }

    const response = await this.requestWithRetry(url, headers, data, timeout);
    if (!response) return null;
    const result = await response.json();
    return result?.choices?.[0]?.message?.content ?? null;
  }
```

- [ ] **Step 2: Rewrite `callOpenai()` to delegate to it**

Replace the body of `callOpenai()` (from the `const baseUrl = (` line to its
closing `return result?.choices?.[0]?.message?.content ?? null;`) with:

```ts
  private async callOpenai(prompt: string, jsonMode: boolean): Promise<string | null> {
    const enabled = this.settings.openaiEnabled ?? this.settings.openai_enabled;
    const apiKey = this.settings.openaiApiKey ?? this.settings.openai_api_key;
    if (!enabled || !apiKey) {
      console.warn("OpenAI is not enabled or configured.");
      return null;
    }

    const baseUrl =
      this.settings.openaiApiUrl ?? this.settings.openai_api_url ?? "https://api.openai.com/v1";
    const model = this.settings.openaiModel ?? this.settings.openai_model ?? "gpt-4o-mini";
    const timeout = this.settings.aiRequestTimeout ?? this.settings.ai_request_timeout ?? 30;

    return this.callOpenaiCompatible(baseUrl, apiKey, model, prompt, jsonMode, timeout);
  }
```

- [ ] **Step 3: Run the existing run tests unchanged**

Run: `npm test -- run.test.ts`
Expected: PASS, no test file changes.

- [ ] **Step 4: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add src/lib/ai/run.ts
git commit -m "refactor(ai): extract a shared OpenAI-compatible AIClient call helper"
```

---

### Task 4: Add the Mistral provider

**Files:**
- Create: `src/lib/ai/mistral.ts`
- Create: `src/lib/ai/mistral.test.ts`
- Modify: `src/lib/ai/providers.ts`, `src/lib/ai/probes.ts`,
  `src/lib/ai/columns.ts`, `src/lib/ai/run.ts`, `src/lib/ai/actions.ts`
- Modify: `messages/en.json`, `messages/de.json`
- Modify (extend, don't rewrite): `src/lib/ai/providers.test.ts`,
  `src/lib/ai/columns.test.ts`

**Interfaces:**
- Produces: `"mistral"` added to `AiProviderKey`; `testMistralKey()`;
  `AI_COLUMNS.mistral`; `AIClient`'s `callMistral()`; `PROVIDER_ACTIONS.mistral`.
- Consumes: `openaiCompatibleChatProbe()` (Task 2), `callOpenaiCompatible()`
  (Task 3), the `mistral*` columns (Task 1).

- [ ] **Step 1: Add the provider entry**

In `src/lib/ai/providers.ts`, add to `AI_PROVIDERS` (after the `gemini`
entry):

```ts
  {
    key: "mistral",
    label: "Mistral",
    // From yana-ios's AIProvider enum (AppSettings.swift), copied 2026-08-04
    // rather than looked up fresh against Mistral's own docs — same
    // provenance as the "deferred" three this repo already ported from
    // there.
    models: [
      { value: "mistral-small-latest", label: "Mistral Small" },
      { value: "mistral-large-latest", label: "Mistral Large" },
      { value: "mistral-medium-latest", label: "Mistral Medium" },
    ],
    defaultModel: "mistral-small-latest",
    // Fixed endpoint, like Anthropic and Gemini: no operator-configurable
    // gateway in front of it (a deliberate choice — see the design spec),
    // so nothing can shed load before the real provider evaluates the key.
    hasCustomUrl: false,
    // Fixed endpoint, same reasoning as Anthropic/Gemini's `true`: a 429 can
    // only come from Mistral itself having already accepted the key.
    quotaMeansVerified: true,
  },
```

Also update `AiProviderKey` at the top of the file:
```ts
export type AiProviderKey = "openai" | "anthropic" | "gemini" | "mistral";
```

- [ ] **Step 2: Write the probe module**

Create `src/lib/ai/mistral.ts`:

```ts
import { openaiCompatibleChatProbe } from "@/lib/integrations/probe";
import type { ProbeResult } from "@/lib/integrations/probe";

const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";

/**
 * Mistral's endpoint is fixed (no operator setting, see `providers.ts`), so
 * unlike OpenAI's probe there is no URL to validate — this only ever calls
 * the shared OpenAI-compatible probe with a literal endpoint.
 */
export async function testMistralKey({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): Promise<ProbeResult> {
  return openaiCompatibleChatProbe({
    providerName: "mistral",
    endpoint: MISTRAL_API_URL,
    apiKey,
    model,
  });
}
```

- [ ] **Step 3: Write the probe test**

Create `src/lib/ai/mistral.test.ts` (mirrors `anthropic.test.ts`'s shape,
adapted to the OpenAI-compatible response envelope):

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

import { testMistralKey } from "./mistral";

afterEach(() => vi.restoreAllMocks());

const credentials = { apiKey: "mistral-test-key", model: "mistral-small-latest" };

function stubFetch(response: Response | Error) {
  const mock =
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("testMistralKey", () => {
  it("reports success on a 200 with a non-empty choices array", async () => {
    stubFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
      }),
    );
    expect(await testMistralKey(credentials)).toMatchObject({ ok: true });
  });

  it("classifies a 401 as unauthorized", async () => {
    stubFetch(new Response(JSON.stringify({ error: { type: "auth" } }), { status: 401 }));
    expect(await testMistralKey(credentials)).toMatchObject({ ok: false, cause: "unauthorized" });
  });

  it("classifies a 429 as quota", async () => {
    stubFetch(new Response(JSON.stringify({ error: {} }), { status: 429 }));
    expect(await testMistralKey(credentials)).toMatchObject({ ok: false, cause: "quota" });
  });

  it("posts to the fixed Mistral endpoint with a Bearer header", async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
        status: 200,
      }),
    );
    await testMistralKey(credentials);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mistral-test-key");
  });

  it("never echoes the submitted key back in a failure result", async () => {
    stubFetch(
      new Response(JSON.stringify({ error: { message: "key SECRET123 is invalid" } }), {
        status: 401,
      }),
    );
    const result = await testMistralKey({ ...credentials, apiKey: "SECRET123" });
    expect(JSON.stringify(result)).not.toContain("SECRET123");
  });

  it("classifies a rejected fetch as network", async () => {
    const failure = new TypeError("fetch failed");
    failure.cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    stubFetch(failure);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await testMistralKey(credentials)).toMatchObject({ ok: false, cause: "network" });
  });
});
```

- [ ] **Step 4: Wire the probe, columns, and `AIClient` branch**

In `src/lib/ai/probes.ts`, add to `AI_PROBES`:
```ts
  mistral: ({ apiKey, model }) => testMistralKey({ apiKey, model }),
```
(and import `testMistralKey` from `./mistral` at the top).

In `src/lib/ai/columns.ts`, add to `AI_COLUMNS`:
```ts
  mistral: {
    enabled: "mistralEnabled",
    apiKey: "mistralApiKey",
    model: "mistralModel",
  },
```

In `src/lib/ai/run.ts`, add a new private method right after `callOpenai`:
```ts
  private async callMistral(prompt: string, jsonMode: boolean): Promise<string | null> {
    const enabled = this.settings.mistralEnabled ?? this.settings.mistral_enabled;
    const apiKey = this.settings.mistralApiKey ?? this.settings.mistral_api_key;
    if (!enabled || !apiKey) {
      console.warn("Mistral is not enabled or configured.");
      return null;
    }
    const model = this.settings.mistralModel ?? this.settings.mistral_model ?? "mistral-small-latest";
    const timeout = this.settings.aiRequestTimeout ?? this.settings.ai_request_timeout ?? 30;
    return this.callOpenaiCompatible(
      "https://api.mistral.ai/v1",
      apiKey,
      model,
      prompt,
      jsonMode,
      timeout,
    );
  }
```
and add a branch in `generateResponse()`'s if/else chain, right after the
`gemini` branch:
```ts
      } else if (this.provider === "mistral") {
        return await this.callMistral(prompt, jsonMode);
```
Also add the six `mistral*`/`mistral_*` fields to the `AiRuntimeSettings`
type at the top of the file, matching the `anthropic*`/`anthropic_*` shape:
```ts
  mistral_enabled?: boolean;
  mistral_api_key?: string;
  mistral_model?: string;
```
(camelCase versions come from `Partial<UserSettings>` already, via Task 1's
schema columns.)

- [ ] **Step 5: Wire the action layer**

In `src/lib/ai/actions.ts`, add to `PROVIDER_KEYS`:
```ts
  mistral: {
    required: "mistral.required",
    rejected: "mistral.rejected",
    quota: "mistral.quota",
    modelUnknown: "mistral.modelUnknown",
  },
```
and add a new `defineIntegration()` block (after the `gemini` block, before
`const PROVIDER_ACTIONS`):
```ts
const mistral = defineIntegration({
  provider: "mistral",
  schema: z.object({ apiKey: secretField, model: modelField(registryEntry("mistral")) }),
  fields: {
    apiKey: { column: AI_COLUMNS.mistral.apiKey, secret: true },
    model: { column: AI_COLUMNS.mistral.model, secret: false },
  },
  flagColumn: AI_COLUMNS.mistral.enabled,
  requiredKey: PROVIDER_KEYS.mistral.required,
  fieldErrorKeys: { "model:custom": PROVIDER_KEYS.mistral.modelUnknown },
  probe: AI_PROBES.mistral,
  keys: {
    rejected: PROVIDER_KEYS.mistral.rejected,
    quota: PROVIDER_KEYS.mistral.quota,
    quotaMeansVerified: registryEntry("mistral").quotaMeansVerified,
  },
});
```
and add `mistral,` to `PROVIDER_ACTIONS`.

- [ ] **Step 6: Add the catalog entries**

In `messages/en.json`, add after the existing `"gemini": { ... }` block
(before `"advanced": {`):
```json
  "mistral": {
    "required": "Enter an API key first.",
    "rejected": "Mistral would not accept these credentials. Check the API key, that the account still has credit, and that it may use the selected model.",
    "quota": "The key is valid — Mistral is rate limiting it right now. It works again shortly.",
    "modelUnknown": "Choose one of the models Yana offers for Mistral."
  },
```

In `messages/de.json`, add in the same position:
```json
  "mistral": {
    "required": "Trage zuerst einen API-Schlüssel ein.",
    "rejected": "Mistral hat diese Zugangsdaten nicht akzeptiert. Prüfe den API-Schlüssel, ob das Konto noch Guthaben hat und ob es das gewählte Modell nutzen darf.",
    "quota": "Der Schlüssel ist gültig — Mistral begrenzt ihn gerade. In Kürze funktioniert er wieder.",
    "modelUnknown": "Wähle eines der Modelle, die Yana für Mistral anbietet."
  },
```

- [ ] **Step 7: Extend the completeness tests**

Open `src/lib/ai/providers.test.ts` and `src/lib/ai/columns.test.ts`, and add
Mistral wherever they iterate/assert against the full provider list (read
each file first — they likely already assert "every key in `AI_PROVIDERS`
has a matching `AI_COLUMNS` entry" generically, in which case no change is
needed beyond re-running them; only add a literal assertion if either file
hard-codes the three original keys).

- [ ] **Step 8: Run the full AI test suite and typecheck**

```bash
npm test -- src/lib/ai src/lib/integrations
npm run typecheck
npm run lint
```
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/ai/ messages/en.json messages/de.json
git commit -m "feat(ai): add the Mistral provider"
```

---

### Task 5: Add the Qwen provider

Identical shape to Task 4, substituting Qwen's values throughout.

**Files:**
- Create: `src/lib/ai/qwen.ts`, `src/lib/ai/qwen.test.ts`
- Modify: `src/lib/ai/providers.ts`, `src/lib/ai/probes.ts`,
  `src/lib/ai/columns.ts`, `src/lib/ai/run.ts`, `src/lib/ai/actions.ts`,
  `messages/en.json`, `messages/de.json`

- [ ] **Step 1: Add the provider entry**

In `src/lib/ai/providers.ts`, add to `AI_PROVIDERS` (after `mistral`):
```ts
  {
    key: "qwen",
    label: "Qwen",
    // From yana-ios's AIProvider enum (AppSettings.swift), copied 2026-08-04.
    models: [
      { value: "qwen3.5-flash", label: "Qwen 3.5 Flash" },
      { value: "qwen3.5-plus", label: "Qwen 3.5 Plus" },
      { value: "qwen3-max", label: "Qwen 3 Max" },
    ],
    defaultModel: "qwen3.5-flash",
    hasCustomUrl: false,
    quotaMeansVerified: true,
  },
```
Update `AiProviderKey`:
```ts
export type AiProviderKey = "openai" | "anthropic" | "gemini" | "mistral" | "qwen";
```

- [ ] **Step 2: Write the probe module**

Create `src/lib/ai/qwen.ts`:
```ts
import { openaiCompatibleChatProbe } from "@/lib/integrations/probe";
import type { ProbeResult } from "@/lib/integrations/probe";

const QWEN_API_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";

export async function testQwenKey({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): Promise<ProbeResult> {
  return openaiCompatibleChatProbe({ providerName: "qwen", endpoint: QWEN_API_URL, apiKey, model });
}
```

- [ ] **Step 3: Write the probe test**

Create `src/lib/ai/qwen.test.ts`, copying `mistral.test.ts` from Task 4
verbatim except: import `testQwenKey` from `./qwen`; `credentials = {
apiKey: "qwen-test-key", model: "qwen3.5-flash" }`; the posted-URL assertion
expects
`"https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions"`.

- [ ] **Step 4: Wire the probe, columns, and `AIClient` branch**

In `src/lib/ai/probes.ts`:
```ts
  qwen: ({ apiKey, model }) => testQwenKey({ apiKey, model }),
```

In `src/lib/ai/columns.ts`:
```ts
  qwen: {
    enabled: "qwenEnabled",
    apiKey: "qwenApiKey",
    model: "qwenModel",
  },
```

In `src/lib/ai/run.ts`, add after `callMistral`:
```ts
  private async callQwen(prompt: string, jsonMode: boolean): Promise<string | null> {
    const enabled = this.settings.qwenEnabled ?? this.settings.qwen_enabled;
    const apiKey = this.settings.qwenApiKey ?? this.settings.qwen_api_key;
    if (!enabled || !apiKey) {
      console.warn("Qwen is not enabled or configured.");
      return null;
    }
    const model = this.settings.qwenModel ?? this.settings.qwen_model ?? "qwen3.5-flash";
    const timeout = this.settings.aiRequestTimeout ?? this.settings.ai_request_timeout ?? 30;
    return this.callOpenaiCompatible(
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      apiKey,
      model,
      prompt,
      jsonMode,
      timeout,
    );
  }
```
and a branch in `generateResponse()` after `mistral`:
```ts
      } else if (this.provider === "qwen") {
        return await this.callQwen(prompt, jsonMode);
```
Add `qwen_enabled?: boolean; qwen_api_key?: string; qwen_model?: string;` to
`AiRuntimeSettings`.

- [ ] **Step 5: Wire the action layer**

In `src/lib/ai/actions.ts`, add to `PROVIDER_KEYS`:
```ts
  qwen: {
    required: "qwen.required",
    rejected: "qwen.rejected",
    quota: "qwen.quota",
    modelUnknown: "qwen.modelUnknown",
  },
```
and a `defineIntegration()` block after `mistral`:
```ts
const qwen = defineIntegration({
  provider: "qwen",
  schema: z.object({ apiKey: secretField, model: modelField(registryEntry("qwen")) }),
  fields: {
    apiKey: { column: AI_COLUMNS.qwen.apiKey, secret: true },
    model: { column: AI_COLUMNS.qwen.model, secret: false },
  },
  flagColumn: AI_COLUMNS.qwen.enabled,
  requiredKey: PROVIDER_KEYS.qwen.required,
  fieldErrorKeys: { "model:custom": PROVIDER_KEYS.qwen.modelUnknown },
  probe: AI_PROBES.qwen,
  keys: {
    rejected: PROVIDER_KEYS.qwen.rejected,
    quota: PROVIDER_KEYS.qwen.quota,
    quotaMeansVerified: registryEntry("qwen").quotaMeansVerified,
  },
});
```
Add `qwen,` to `PROVIDER_ACTIONS`.

- [ ] **Step 6: Add the catalog entries**

`messages/en.json` (after `mistral`):
```json
  "qwen": {
    "required": "Enter an API key first.",
    "rejected": "Qwen would not accept these credentials. Check the API key, that the account still has credit, and that it may use the selected model.",
    "quota": "The key is valid — Qwen is rate limiting it right now. It works again shortly.",
    "modelUnknown": "Choose one of the models Yana offers for Qwen."
  },
```
`messages/de.json` (after `mistral`):
```json
  "qwen": {
    "required": "Trage zuerst einen API-Schlüssel ein.",
    "rejected": "Qwen hat diese Zugangsdaten nicht akzeptiert. Prüfe den API-Schlüssel, ob das Konto noch Guthaben hat und ob es das gewählte Modell nutzen darf.",
    "quota": "Der Schlüssel ist gültig — Qwen begrenzt ihn gerade. In Kürze funktioniert er wieder.",
    "modelUnknown": "Wähle eines der Modelle, die Yana für Qwen anbietet."
  },
```

- [ ] **Step 7: Run the full AI test suite, typecheck, lint**

```bash
npm test -- src/lib/ai src/lib/integrations
npm run typecheck && npm run lint
```

- [ ] **Step 8: Commit**

```bash
git add src/lib/ai/ messages/en.json messages/de.json
git commit -m "feat(ai): add the Qwen provider"
```

---

### Task 6: Add the DeepSeek provider

Identical shape again.

**Files:**
- Create: `src/lib/ai/deepseek.ts`, `src/lib/ai/deepseek.test.ts`
- Modify: `src/lib/ai/providers.ts`, `src/lib/ai/probes.ts`,
  `src/lib/ai/columns.ts`, `src/lib/ai/run.ts`, `src/lib/ai/actions.ts`,
  `messages/en.json`, `messages/de.json`

- [ ] **Step 1: Add the provider entry**

In `src/lib/ai/providers.ts`, add to `AI_PROVIDERS` (after `qwen`):
```ts
  {
    key: "deepseek",
    label: "DeepSeek",
    // From yana-ios's AIProvider enum (AppSettings.swift), copied 2026-08-04.
    models: [
      { value: "deepseek-v4-flash", label: "DeepSeek V4 Flash" },
      { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" },
    ],
    defaultModel: "deepseek-v4-flash",
    hasCustomUrl: false,
    quotaMeansVerified: true,
  },
```
Update `AiProviderKey`:
```ts
export type AiProviderKey = "openai" | "anthropic" | "gemini" | "mistral" | "qwen" | "deepseek";
```

- [ ] **Step 2: Write the probe module**

Create `src/lib/ai/deepseek.ts`:
```ts
import { openaiCompatibleChatProbe } from "@/lib/integrations/probe";
import type { ProbeResult } from "@/lib/integrations/probe";

const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";

export async function testDeepseekKey({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): Promise<ProbeResult> {
  return openaiCompatibleChatProbe({
    providerName: "deepseek",
    endpoint: DEEPSEEK_API_URL,
    apiKey,
    model,
  });
}
```

- [ ] **Step 3: Write the probe test**

Create `src/lib/ai/deepseek.test.ts`, copying `mistral.test.ts` except:
import `testDeepseekKey` from `./deepseek`; `credentials = { apiKey:
"deepseek-test-key", model: "deepseek-v4-flash" }`; the posted-URL assertion
expects `"https://api.deepseek.com/v1/chat/completions"`.

- [ ] **Step 4: Wire the probe, columns, and `AIClient` branch**

In `src/lib/ai/probes.ts`:
```ts
  deepseek: ({ apiKey, model }) => testDeepseekKey({ apiKey, model }),
```

In `src/lib/ai/columns.ts`:
```ts
  deepseek: {
    enabled: "deepseekEnabled",
    apiKey: "deepseekApiKey",
    model: "deepseekModel",
  },
```

In `src/lib/ai/run.ts`, add after `callQwen`:
```ts
  private async callDeepseek(prompt: string, jsonMode: boolean): Promise<string | null> {
    const enabled = this.settings.deepseekEnabled ?? this.settings.deepseek_enabled;
    const apiKey = this.settings.deepseekApiKey ?? this.settings.deepseek_api_key;
    if (!enabled || !apiKey) {
      console.warn("DeepSeek is not enabled or configured.");
      return null;
    }
    const model = this.settings.deepseekModel ?? this.settings.deepseek_model ?? "deepseek-v4-flash";
    const timeout = this.settings.aiRequestTimeout ?? this.settings.ai_request_timeout ?? 30;
    return this.callOpenaiCompatible(
      "https://api.deepseek.com/v1",
      apiKey,
      model,
      prompt,
      jsonMode,
      timeout,
    );
  }
```
and a branch in `generateResponse()` after `qwen`:
```ts
      } else if (this.provider === "deepseek") {
        return await this.callDeepseek(prompt, jsonMode);
```
Add `deepseek_enabled?: boolean; deepseek_api_key?: string; deepseek_model?:
string;` to `AiRuntimeSettings`.

- [ ] **Step 5: Wire the action layer**

In `src/lib/ai/actions.ts`, add to `PROVIDER_KEYS`:
```ts
  deepseek: {
    required: "deepseek.required",
    rejected: "deepseek.rejected",
    quota: "deepseek.quota",
    modelUnknown: "deepseek.modelUnknown",
  },
```
and a `defineIntegration()` block after `qwen`:
```ts
const deepseek = defineIntegration({
  provider: "deepseek",
  schema: z.object({ apiKey: secretField, model: modelField(registryEntry("deepseek")) }),
  fields: {
    apiKey: { column: AI_COLUMNS.deepseek.apiKey, secret: true },
    model: { column: AI_COLUMNS.deepseek.model, secret: false },
  },
  flagColumn: AI_COLUMNS.deepseek.enabled,
  requiredKey: PROVIDER_KEYS.deepseek.required,
  fieldErrorKeys: { "model:custom": PROVIDER_KEYS.deepseek.modelUnknown },
  probe: AI_PROBES.deepseek,
  keys: {
    rejected: PROVIDER_KEYS.deepseek.rejected,
    quota: PROVIDER_KEYS.deepseek.quota,
    quotaMeansVerified: registryEntry("deepseek").quotaMeansVerified,
  },
});
```
Add `deepseek,` to `PROVIDER_ACTIONS`.

- [ ] **Step 6: Add the catalog entries**

`messages/en.json` (after `qwen`):
```json
  "deepseek": {
    "required": "Enter an API key first.",
    "rejected": "DeepSeek would not accept these credentials. Check the API key, that the account still has credit, and that it may use the selected model.",
    "quota": "The key is valid — DeepSeek is rate limiting it right now. It works again shortly.",
    "modelUnknown": "Choose one of the models Yana offers for DeepSeek."
  },
```
`messages/de.json` (after `qwen`):
```json
  "deepseek": {
    "required": "Trage zuerst einen API-Schlüssel ein.",
    "rejected": "DeepSeek hat diese Zugangsdaten nicht akzeptiert. Prüfe den API-Schlüssel, ob das Konto noch Guthaben hat und ob es das gewählte Modell nutzen darf.",
    "quota": "Der Schlüssel ist gültig — DeepSeek begrenzt ihn gerade. In Kürze funktioniert er wieder.",
    "modelUnknown": "Wähle eines der Modelle, die Yana für DeepSeek anbietet."
  },
```

- [ ] **Step 7: Run the full test suite, typecheck, lint, format check**

```bash
npm test -- src/lib/ai src/lib/integrations
npm run typecheck && npm run lint && npm run format:check
```
Fix any Prettier drift with `npm run format` if `format:check` fails.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ai/ messages/en.json messages/de.json
git commit -m "feat(ai): add the DeepSeek provider"
```

---

### Task 7: `ai_requests` table

**Files:**
- Create: `src/lib/db/schema/ai.ts`
- Modify: `src/lib/db/schema.ts` (barrel export)
- Create: a new migration via `drizzle-kit generate`

**Interfaces:**
- Produces: `aiRequests` table (`id`, `userId`, `createdAt`), exported from
  `@/lib/db/schema` — Task 8's `checkAndRecordAiUsage()` reads/writes it.

- [ ] **Step 1: Add the schema file**

Create `src/lib/db/schema/ai.ts`:
```ts
import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { users } from "./users";

/**
 * One row per attempted AI call. `checkAndRecordAiUsage()`
 * (`src/lib/ai/usage.ts`) is the only reader and writer: it counts a user's
 * rows since the start of the current UTC day/month to enforce
 * `aiDefaultDailyLimit`/`aiDefaultMonthlyLimit`, and opportunistically
 * deletes rows older than the start of the current UTC month on every call
 * -- nothing needs a row older than that, since the daily window is a
 * subset of the monthly one, so no separate cleanup job exists.
 *
 * Usage is recorded for every attempted call, not only successful ones: the
 * limit bounds outbound requests to the provider, not successful
 * completions.
 */
export const aiRequests = sqliteTable(
  "ai_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [index("ai_requests_user_created_idx").on(table.userId, table.createdAt)],
);
```

- [ ] **Step 2: Export it from the schema barrel**

In `src/lib/db/schema.ts`, add:
```ts
export * from "./schema/ai";
```
(alongside the existing `export * from "./schema/articles";` etc. — keep
the list alphabetical if the existing ones are).

- [ ] **Step 3: Generate the migration**

Run:
```bash
npx drizzle-kit generate
```
Expected: a new `drizzle/NNNN_<generated-name>.sql` creating `ai_requests`
plus its index, and updated `drizzle/meta/_journal.json` +
`meta/NNNN_snapshot.json`.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add src/lib/db/schema/ai.ts src/lib/db/schema.ts drizzle/
git commit -m "feat(db): add the ai_requests table"
```

---

### Task 8: `checkAndRecordAiUsage()`

**Files:**
- Create: `src/lib/ai/usage.ts`
- Create: `src/lib/ai/usage.test.ts`

**Interfaces:**
- Produces: `checkAndRecordAiUsage(tx: BetterSQLite3Database<typeof
  schema>, userId: string, dailyLimit: number, monthlyLimit: number, now?:
  Date): "ok" | "dailyLimitExceeded" | "monthlyLimitExceeded"` — Task 9's
  `AIClient.generateResponse()` calls this inside a `writeTransaction()`.
- Consumes: `aiRequests` (Task 7).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/ai/usage.test.ts`:
```ts
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { freshDrizzle } from "@/lib/db/test-support";
import { aiRequests, users } from "@/lib/db/schema";

import { checkAndRecordAiUsage } from "./usage";

describe("checkAndRecordAiUsage", () => {
  let db: ReturnType<typeof freshDrizzle>["db"];

  beforeEach(() => {
    ({ db } = freshDrizzle());
    db.insert(users).values({ id: "u1", email: "u1@example.com" }).run();
  });

  function requestCount(): number {
    return db.select().from(aiRequests).where(eq(aiRequests.userId, "u1")).all().length;
  }

  it("allows a call under both limits and records it", () => {
    const result = checkAndRecordAiUsage(db, "u1", 5, 50);
    expect(result).toBe("ok");
    expect(requestCount()).toBe(1);
  });

  it("refuses once the daily limit is reached, without recording a new row", () => {
    for (let i = 0; i < 3; i++) checkAndRecordAiUsage(db, "u1", 3, 50);
    const result = checkAndRecordAiUsage(db, "u1", 3, 50);
    expect(result).toBe("dailyLimitExceeded");
    expect(requestCount()).toBe(3);
  });

  it("refuses once the monthly limit is reached even under the daily limit", () => {
    for (let i = 0; i < 5; i++) checkAndRecordAiUsage(db, "u1", 100, 5);
    const result = checkAndRecordAiUsage(db, "u1", 100, 5);
    expect(result).toBe("monthlyLimitExceeded");
    expect(requestCount()).toBe(5);
  });

  it("does not count another user's requests", () => {
    db.insert(users).values({ id: "u2", email: "u2@example.com" }).run();
    for (let i = 0; i < 3; i++) checkAndRecordAiUsage(db, "u2", 3, 50);
    const result = checkAndRecordAiUsage(db, "u1", 3, 50);
    expect(result).toBe("ok");
  });

  it("resets the daily count on a new UTC day, but keeps the monthly count", () => {
    const day1 = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    const day2 = new Date(Date.UTC(2026, 0, 16, 0, 30, 0));
    checkAndRecordAiUsage(db, "u1", 1, 50, day1);
    // Same day, over the daily limit of 1.
    expect(checkAndRecordAiUsage(db, "u1", 1, 50, day1)).toBe("dailyLimitExceeded");
    // Next UTC day: daily count is back to zero, monthly count still includes day1's row.
    expect(checkAndRecordAiUsage(db, "u1", 1, 50, day2)).toBe("ok");
    expect(requestCount()).toBe(2);
  });

  it("prunes rows older than the start of the current UTC month", () => {
    const lastMonth = new Date(Date.UTC(2026, 0, 15));
    const thisMonth = new Date(Date.UTC(2026, 1, 1, 0, 30, 0));
    checkAndRecordAiUsage(db, "u1", 50, 50, lastMonth);
    expect(requestCount()).toBe(1);
    checkAndRecordAiUsage(db, "u1", 50, 50, thisMonth);
    // The January row is pruned before the new one is inserted.
    expect(requestCount()).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -- usage.test.ts`
Expected: FAIL — `./usage` does not exist yet.

- [ ] **Step 3: Implement `checkAndRecordAiUsage()`**

Create `src/lib/ai/usage.ts`:
```ts
import { and, count, eq, gte, lt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { aiRequests } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

export type AiUsageOutcome = "ok" | "dailyLimitExceeded" | "monthlyLimitExceeded";

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Checked and recorded atomically -- the caller must run this inside its own
 * `writeTransaction()` (`BEGIN IMMEDIATE`), the same ordering guarantee
 * `setActiveProvider()` in `src/lib/ai/actions.ts` relies on, so two
 * concurrent calls from the same user cannot both read "one under the
 * limit" and both proceed.
 *
 * Usage is recorded for every attempted call the caller lets through here,
 * not only successful ones -- see the doc comment on `aiRequests`
 * (`src/lib/db/schema/ai.ts`) for why.
 *
 * Reset windows are calendar UTC day/month, not a rolling window --
 * simplest to reason about, and consistent with this repo's `timeZone:
 * "UTC"` convention for server-side date handling.
 */
export function checkAndRecordAiUsage(
  tx: BetterSQLite3Database<typeof schema>,
  userId: string,
  dailyLimit: number,
  monthlyLimit: number,
  now: Date = new Date(),
): AiUsageOutcome {
  const dayStart = startOfUtcDay(now);
  const monthStart = startOfUtcMonth(now);

  // Bounds table growth: nothing after this point needs a row older than
  // the start of the current month, since the daily window is a subset of
  // the monthly one.
  tx.delete(aiRequests)
    .where(and(eq(aiRequests.userId, userId), lt(aiRequests.createdAt, monthStart)))
    .run();

  const dailyCount =
    tx
      .select({ value: count() })
      .from(aiRequests)
      .where(and(eq(aiRequests.userId, userId), gte(aiRequests.createdAt, dayStart)))
      .get()?.value ?? 0;
  if (dailyCount >= dailyLimit) return "dailyLimitExceeded";

  const monthlyCount =
    tx
      .select({ value: count() })
      .from(aiRequests)
      .where(and(eq(aiRequests.userId, userId), gte(aiRequests.createdAt, monthStart)))
      .get()?.value ?? 0;
  if (monthlyCount >= monthlyLimit) return "monthlyLimitExceeded";

  tx.insert(aiRequests).values({ userId, createdAt: now }).run();
  return "ok";
}
```

- [ ] **Step 4: Run the tests again**

Run: `npm test -- usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add src/lib/ai/usage.ts src/lib/ai/usage.test.ts
git commit -m "feat(ai): add checkAndRecordAiUsage for daily/monthly AI request limits"
```

---

### Task 9: Wire usage limits into `AIClient` and change `generateResponse()`'s return shape

**Files:**
- Modify: `src/lib/ai/run.ts` (`generateResponse()`, `applyAiOptions()`)
- Modify: `src/lib/ai/run.test.ts` (update every assertion against
  `generateResponse()`'s return value)

**Interfaces:**
- Produces: `AiGenerationResult = { ok: true; text: string } | { ok: false;
  reason: "noProvider" | "dailyLimitExceeded" | "monthlyLimitExceeded" |
  "providerError" }`, exported from `run.ts` — Task 10's route handler
  matches on this.
- **Breaking change**: `generateResponse()`'s return type changes from
  `Promise<string | null>` to `Promise<AiGenerationResult>`. This is the one
  task in this plan that changes an existing public signature.
- Consumes: `checkAndRecordAiUsage()` (Task 8), `writeTransaction()`
  (`@/lib/db/client`).

- [ ] **Step 1: Change `generateResponse()`**

In `src/lib/ai/run.ts`, add near the top (after the `AiRequestBody` type):
```ts
export type AiGenerationResult =
  | { ok: true; text: string }
  | {
      ok: false;
      reason: "noProvider" | "dailyLimitExceeded" | "monthlyLimitExceeded" | "providerError";
    };
```
Add imports at the top of the file:
```ts
import { writeTransaction } from "@/lib/db/client";

import { checkAndRecordAiUsage } from "./usage";
```
Replace the whole `generateResponse()` method with:
```ts
  public async generateResponse(
    prompt: string,
    jsonMode = false,
    jsonSchema?: Record<string, unknown>,
  ): Promise<AiGenerationResult> {
    if (!this.provider) {
      console.warn("No AI provider selected.");
      return { ok: false, reason: "noProvider" };
    }

    const userId = this.settings.userId;
    if (userId) {
      const dailyLimit = this.settings.aiDefaultDailyLimit ?? 200;
      const monthlyLimit = this.settings.aiDefaultMonthlyLimit ?? 2000;
      let usage: ReturnType<typeof checkAndRecordAiUsage>;
      try {
        usage = writeTransaction((tx) =>
          checkAndRecordAiUsage(tx, userId, dailyLimit, monthlyLimit),
        );
      } catch (error) {
        console.warn(`AI usage check failed: ${describeError(error)}`);
        return { ok: false, reason: "providerError" };
      }
      if (usage === "dailyLimitExceeded" || usage === "monthlyLimitExceeded") {
        return { ok: false, reason: usage };
      }
    } else {
      // No settings row carried a userId (nothing in production hits this
      // today -- both real call sites read a full `user_settings` row --
      // but a caller that omits one gets the call through unmetered rather
      // than a thrown error, matching this class's warn-and-continue style
      // for misconfiguration elsewhere).
      console.warn("No user id on AI settings; usage limit not enforced for this call.");
    }

    try {
      let text: string | null;
      if (this.provider === "openai") {
        text = await this.callOpenai(prompt, jsonMode);
      } else if (this.provider === "anthropic") {
        text = await this.callAnthropic(prompt);
      } else if (this.provider === "gemini") {
        text = await this.callGemini(prompt, jsonMode, jsonSchema);
      } else if (this.provider === "mistral") {
        text = await this.callMistral(prompt, jsonMode);
      } else if (this.provider === "qwen") {
        text = await this.callQwen(prompt, jsonMode);
      } else if (this.provider === "deepseek") {
        text = await this.callDeepseek(prompt, jsonMode);
      } else {
        console.warn(`Unknown AI provider: ${this.provider}`);
        return { ok: false, reason: "providerError" };
      }
      return text === null ? { ok: false, reason: "providerError" } : { ok: true, text };
    } catch (e: unknown) {
      console.warn(`AI API call failed: ${describeError(e)}`);
      return { ok: false, reason: "providerError" };
    }
  }
```

- [ ] **Step 2: Update `applyAiOptions()`'s one call site**

In the same file, find:
```ts
  const result = await client.generateResponse(fullPrompt, true, jsonSchema);

  if (result) {
    let parsedResult: { title?: string; content?: string } | null = null;
    try {
      parsedResult = JSON.parse(result);
```
Replace with:
```ts
  const generation = await client.generateResponse(fullPrompt, true, jsonSchema);

  if (generation.ok) {
    const result = generation.text;
    let parsedResult: { title?: string; content?: string } | null = null;
    try {
      parsedResult = JSON.parse(result);
```
(the rest of that `if` block is unchanged — it already refers to `result` as
a string). Update the trailing `else` branch's log line from referencing an
implicit falsy `result` to the new shape:
```ts
  } else {
    console.warn(`AI processing failed for article '${article.name || ""}'. Skipping.`);
  }
```
(this line is unchanged, just now attached to `if (generation.ok)`'s `else`
instead of `if (result)`'s).

- [ ] **Step 3: Update `run.test.ts`'s assertions**

Every existing `const result = await client.generateResponse(...)` call in
`src/lib/ai/run.test.ts` needs its assertions updated for the new shape.
Apply this rule throughout the file:

- Where a test previously asserted `expect(result).toBe(null)` or
  `expect(result).toBeNull()`, change to
  `expect(result).toMatchObject({ ok: false })`.
- Where a test previously asserted the result *is* a string (e.g.
  `expect(result).toBe("some text")` or `expect(result).toContain("x")`),
  change to `expect(result).toMatchObject({ ok: true, text: "some text" })`
  or `expect((result as { ok: true; text: string }).text).toContain("x")`.

Two concrete examples from the file (read it first to find every remaining
call site — there are roughly 15):

```ts
// Before:
const result = await client.generateResponse("test prompt");
expect(result).toBe("Success response");

// After:
const result = await client.generateResponse("test prompt");
expect(result).toMatchObject({ ok: true, text: "Success response" });
```

```ts
// Before:
const result = await client.generateResponse("test prompt");
expect(result).toBeNull();

// After:
const result = await client.generateResponse("test prompt");
expect(result).toMatchObject({ ok: false });
```

Every test in this file that constructs an `AIClient` and calls
`generateResponse()` needs its settings object to include a `userId` (e.g.
`userId: "test-user"`) plus `aiDefaultDailyLimit`/`aiDefaultMonthlyLimit`
set high enough (e.g. `1000`) that the new usage check never interferes with
what the test is actually asserting — add these two fields to the shared
settings fixture(s) in this file if it has one, otherwise to each inline
settings object. Since `checkAndRecordAiUsage()` needs a real migrated
database (it runs inside `writeTransaction()`, which uses the process-wide
`getDb()` singleton), this file's `beforeEach` must also point
`DATABASE_PATH` at a fresh migrated temp file and insert a matching `users`
row for whatever `userId` the settings fixtures use — follow
`src/app/api/v1/aggregate/route.test.ts`'s `beforeEach` shape (Task 10 uses
the same pattern) rather than any mocked-database approach this file may
have used before.

- [ ] **Step 4: Run the full run test suite**

Run: `npm test -- run.test.ts`
Expected: PASS. Fix any remaining mismatched assertion using the rule above.

- [ ] **Step 5: Run the full suite, typecheck, lint, format check**

```bash
npm test
npm run typecheck && npm run lint && npm run format:check
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/ai/run.ts src/lib/ai/run.test.ts
git commit -m "feat(ai): enforce daily/monthly AI request limits in AIClient.generateResponse"
```

---

### Task 10: `POST /api/v1/ai/prompt`

**Files:**
- Create: `src/app/api/v1/ai/prompt/route.ts`
- Create: `src/app/api/v1/ai/prompt/route.test.ts`

**Interfaces:**
- Consumes: `requireApiUser()`/`ApiError`/`apiErrorResponse()`
  (`@/lib/api/auth`), `activeProvider()` (`@/lib/ai/queries`), `AI_COLUMNS`
  (`@/lib/ai/columns`), `AIClient` + `AiGenerationResult` (`@/lib/ai/run`),
  `userSettings` (`@/lib/db/schema`).
- Produces: `POST /api/v1/ai/prompt` — request `{ prompt: string }`,
  success response `{ response: string; provider: string; model: string }`,
  error codes `invalid_prompt` (400), `prompt_too_long` (400),
  `no_active_provider` (409), `daily_limit_exceeded` (429),
  `monthly_limit_exceeded` (429), `provider_error` (502), plus the standard
  `unauthorized` (401) from `requireApiUser()`.

- [ ] **Step 1: Write the route**

Create `src/app/api/v1/ai/prompt/route.ts`:
```ts
import { eq } from "drizzle-orm";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { AI_COLUMNS } from "@/lib/ai/columns";
import { activeProvider } from "@/lib/ai/queries";
import { AIClient } from "@/lib/ai/run";
import { getDb } from "@/lib/db/client";
import { userSettings } from "@/lib/db/schema";

/**
 * The native client's server-mediated "ask AI" call: a free-form prompt run
 * against the caller's configured AI provider, using their stored
 * credentials and global tuning values -- no per-request overrides. See the
 * design spec at
 * `docs/superpowers/specs/2026-08-04-ai-provider-expansion-and-prompt-endpoint-design.md`.
 *
 * Settings are read directly by `user.id`, not via `getSettings()` -- that
 * helper is bound to the cookie-session-derived `currentUserId()` and would
 * not resolve correctly for a Bearer-token caller. This is the same pattern
 * `src/lib/jobs/handlers/retention.ts` already uses outside a session
 * context.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser(request);

    const settings = getDb()
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, user.id))
      .get();
    if (!settings) {
      // A provisioning bug, never expected for a real account -- propagates
      // past this route's ApiError-only catch to Next's default 500.
      throw new Error(`no user_settings row for user "${user.id}"`);
    }

    const body: unknown = await request.json().catch(() => null);
    const rawPrompt =
      typeof body === "object" && body !== null && "prompt" in body
        ? (body as { prompt: unknown }).prompt
        : undefined;
    const prompt = typeof rawPrompt === "string" ? rawPrompt.trim() : "";
    if (!prompt) {
      throw new ApiError(400, "invalid_prompt", "prompt is required.");
    }
    if (prompt.length > settings.aiMaxPromptLength) {
      throw new ApiError(400, "prompt_too_long", "prompt exceeds the configured length limit.");
    }

    const providerKey = activeProvider(settings);
    if (!providerKey) {
      throw new ApiError(409, "no_active_provider", "No AI provider is configured.");
    }

    const client = new AIClient(settings);
    const result = await client.generateResponse(prompt);

    if (!result.ok) {
      if (result.reason === "dailyLimitExceeded") {
        throw new ApiError(429, "daily_limit_exceeded", "The daily AI request limit is reached.");
      }
      if (result.reason === "monthlyLimitExceeded") {
        throw new ApiError(
          429,
          "monthly_limit_exceeded",
          "The monthly AI request limit is reached.",
        );
      }
      if (result.reason === "noProvider") {
        throw new ApiError(409, "no_active_provider", "No AI provider is configured.");
      }
      throw new ApiError(502, "provider_error", "The AI provider could not fulfil this prompt.");
    }

    return Response.json({
      response: result.text,
      provider: providerKey,
      model: settings[AI_COLUMNS[providerKey].model],
    });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
```

- [ ] **Step 2: Write the route test**

Create `src/app/api/v1/ai/prompt/route.test.ts`, following
`src/app/api/v1/aggregate/route.test.ts`'s `beforeEach` shape exactly (fresh
migrated temp `DATABASE_PATH` per test, `vi.resetModules()`, dynamic
`import()` of the route and `@/lib/auth/server`/`@/lib/db/client`/`@/lib/db/schema`):

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

describe("POST /api/v1/ai/prompt", () => {
  let dbPath: string;
  let POST: typeof import("./route").POST;
  let createUserWithPassword: typeof import("@/lib/auth/server").createUserWithPassword;
  let createDeviceSession: typeof import("@/lib/auth/server").createDeviceSession;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");

  beforeEach(async () => {
    vi.resetModules();
    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-ai-prompt-route-${stamp}.db`);
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    ({ createUserWithPassword, createDeviceSession } = await import("@/lib/auth/server"));
    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    ({ POST } = await import("./route"));
  });

  afterEach(() => fs.rmSync(dbPath, { force: true }));

  function promptRequest(token: string | undefined, body: unknown) {
    return POST(
      new Request("https://example.com/api/v1/ai/prompt", {
        method: "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  }

  async function ownerToken(): Promise<string> {
    const owner = await createUserWithPassword({
      email: "o@example.com",
      password: "correct horse battery staple",
    });
    const { token } = await createDeviceSession(owner.id, "Test");
    return token;
  }

  it("401s with no Authorization header", async () => {
    const response = await promptRequest(undefined, { prompt: "hi" });
    expect(response.status).toBe(401);
  });

  it("400s on an empty prompt", async () => {
    const token = await ownerToken();
    const response = await promptRequest(token, { prompt: "   " });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("invalid_prompt");
  });

  it("400s on a prompt longer than the configured limit", async () => {
    const token = await ownerToken();
    const owner = client
      .getDb()
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, "o@example.com"))
      .get()!;
    client.writeTransaction((tx) => {
      tx.update(schema.userSettings)
        .set({ aiMaxPromptLength: 5 })
        .where(eq(schema.userSettings.userId, owner.id))
        .run();
    });

    const response = await promptRequest(token, { prompt: "this is way too long" });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("prompt_too_long");
  });

  it("409s when no AI provider is active", async () => {
    const token = await ownerToken();
    const response = await promptRequest(token, { prompt: "hello" });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("no_active_provider");
  });

  it("returns the provider's completion when a provider is active and enabled", async () => {
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
          anthropicApiKey: "sk-ant-test",
          anthropicModel: "claude-haiku-4-5",
          activeAiProvider: "anthropic",
        })
        .where(eq(schema.userSettings.userId, owner.id))
        .run();
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "General Kenobi." }],
          }),
          { status: 200 },
        ),
      ),
    );

    const response = await promptRequest(token, { prompt: "Hello there" });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      response: "General Kenobi.",
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    vi.unstubAllGlobals();
  });

  it("429s once the daily request limit is reached", async () => {
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
          anthropicApiKey: "sk-ant-test",
          anthropicModel: "claude-haiku-4-5",
          activeAiProvider: "anthropic",
          aiDefaultDailyLimit: 1,
        })
        .where(eq(schema.userSettings.userId, owner.id))
        .run();
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
          }),
          { status: 200 },
        ),
      ),
    );

    await promptRequest(token, { prompt: "first" });
    const response = await promptRequest(token, { prompt: "second" });

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error.code).toBe("daily_limit_exceeded");
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 3: Run the test**

Run: `npm test -- src/app/api/v1/ai/prompt/route.test.ts`
Expected: PASS. If the fetch-stub-based Anthropic test doesn't match
`testAnthropicKey`'s exact expected response envelope, adjust the stub body
to match `callAnthropic()`'s parsing (`result?.content?.[0]?.text`) in
`src/lib/ai/run.ts` rather than the test's assumption.

- [ ] **Step 4: Run the full suite, typecheck, lint, format check**

```bash
npm test
npm run typecheck && npm run lint && npm run format:check
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/v1/ai/
git commit -m "feat(api): add POST /api/v1/ai/prompt for server-mediated AI prompts"
```

---

### Task 11: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify:
  `docs/superpowers/specs/2026-08-30-nextjs-migration-direction.md` (or
  whatever the current direction record's actual filename is — check with
  `ls docs/superpowers/specs/*migration-direction*`)

**Interfaces:** None — this task changes no code.

- [ ] **Step 1: Update CLAUDE.md's provider count**

`CLAUDE.md` currently documents the AI tab as having three providers and
explicitly says "**Deliberately three**... the direction record defers
provider expansion... this is not the place to widen it." Update the
relevant paragraph(s) in the `/ai` and `src/lib/ai/providers.ts` discussion
to state there are now six providers (OpenAI, Anthropic, Gemini, Mistral,
Qwen, DeepSeek), that Mistral/Qwen/DeepSeek all have fixed endpoints and
share the extracted `openaiCompatibleChatProbe()`/`callOpenaiCompatible()`
helpers, and add a new bullet documenting the `ai_requests`
table/`checkAndRecordAiUsage()` chokepoint and the new
`POST /api/v1/ai/prompt` endpoint, following the file's existing prose
density and rationale-first style (state the decision, then **Why:** the
reasoning already captured in the design spec).

- [ ] **Step 2: Update the direction record's phase-completion status**

Find the current direction record with
`ls docs/superpowers/specs/*migration-direction*.md`, read its "carried
forward" / phase-status sections, and add a short note recording that
provider expansion (deferred explicitly in phase 7's writeup) and the new
mobile prompt endpoint have now shipped, with a pointer to this plan's
design spec.

- [ ] **Step 3: Run doc-consuming tests and commit**

```bash
npm run format:check
git add CLAUDE.md docs/superpowers/specs/
git commit -m "docs: document the expanded AI provider list and the mobile prompt endpoint"
```

---

## Final verification (after all tasks)

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
```
All four must pass before this plan is considered complete.
