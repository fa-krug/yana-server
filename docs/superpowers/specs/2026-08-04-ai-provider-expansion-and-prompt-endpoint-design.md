# AI provider expansion + mobile prompt endpoint

Status: draft, pending user review.

## Goal

1. Expand the server's AI provider registry from three providers (OpenAI,
   Anthropic, Gemini) to six, adding Mistral, Qwen and DeepSeek — the three
   yana-ios supports that this server does not yet.
2. Add a mobile-facing endpoint, `POST /api/v1/ai/prompt`, so the native
   client can send a free-form prompt to the server and have the server run
   it against the caller's configured AI provider, instead of (or in addition
   to) the iOS app's own on-device provider calls.
3. Add real enforcement of the existing (currently decorative)
   `aiDefaultDailyLimit`/`aiDefaultMonthlyLimit` settings, since this endpoint
   is the first place a user can trigger AI calls on demand.

## Sources consulted

- `src/lib/ai/*` — this repo's existing provider registry, probes, action
  layer and runtime client.
- `yana-ios/Yana/Models/AppSettings.swift` and
  `yana-ios/Yana/Services/AIClient.swift` — the iOS provider list, models and
  request shapes.
- `old/core/models.py` and `old/core/ai_client.py` — the retired Django
  implementation. Confirmed it only ever supported three providers (the same
  three this repo already has) and never enforced the daily/monthly limits
  either — there is no oracle behavior to port for enforcement; it is new.
- `src/app/api/v1/**` and `src/lib/api/auth.ts` — the existing Bearer-token
  mobile API's conventions, which the new endpoint follows.

## Decisions already made (confirmed with the user)

- **Endpoint semantics**: generic free-form prompt passthrough — the client
  sends prompt text, the server calls the user's active AI provider and
  returns the raw completion. Not a templated/purpose-specific endpoint.
- **Provider scope**: the endpoint must work with the full expanded
  provider list from day one, not just the original three.
- **Response mode**: synchronous JSON, not SSE/streaming.
- **Tuning values**: the endpoint uses the account's stored nine global
  tuning values (temperature, max tokens, timeout, retries, etc.) — no
  per-request overrides.
- **Apple Intelligence**: excluded from the server registry. It is
  on-device-only in iOS (no API key, no network call) — there is nothing for
  a server to call, so it is not a server-side "provider" at all.
- **Base URL**: the three new providers get fixed, non-configurable base
  URLs, matching yana-ios exactly. This also avoids re-deriving OpenAI's
  SSRF hardening (redirect refusal, userinfo rejection, URL validation) for
  providers that don't need it.
- **Rate limiting**: full enforcement, at a shared chokepoint that covers
  both this new endpoint and the (currently unwired) background
  AI-post-processing path in `applyAiOptions()` — not just the new endpoint
  — so the limit means what its own label says ("the most AI requests Yana
  makes"), not "the most prompt-endpoint calls."

## Part 1 — Provider expansion

Three new providers, added by extending the same per-file registries the
existing three already use — no new pattern, just three more entries in
each:

| Provider   | Models (cheapest-capable first)                                                 | Base URL                                             | `hasCustomUrl` | `quotaMeansVerified` |
|------------|----------------------------------------------------------------------------------|-------------------------------------------------------|----------------|----------------------|
| `mistral`  | `mistral-small-latest`, `mistral-large-latest`, `mistral-medium-latest`          | `https://api.mistral.ai/v1`                            | `false`        | `true`               |
| `qwen`     | `qwen3.5-flash`, `qwen3.5-plus`, `qwen3-max`                                     | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` | `false`      | `true`               |
| `deepseek` | `deepseek-v4-flash`, `deepseek-v4-pro`                                           | `https://api.deepseek.com/v1`                          | `false`        | `true`               |

Model lists and base URLs are taken from yana-ios's `AppSettings.swift`
(`AIProvider` enum) — the same source of truth this repo's own comments cite
for its default model ids drifting from upstream over time. As with the
existing three, `providers.ts` should note the date/source they were copied
from.

`quotaMeansVerified: true` for all three, by the same reasoning already
written for Anthropic and Gemini: each has a fixed endpoint (this design
deliberately gives none of them an operator-configurable gateway), so
nothing can shed load at an edge before the real provider evaluates the API
key — a 429 can only mean the key was already accepted.

### Files touched, and what changes in each

- **`src/lib/ai/providers.ts`** — three new `AiProvider` entries in
  `AI_PROVIDERS`.
- **`src/lib/integrations/probe.ts`** — extract the OpenAI-compatible
  chat-completions probe body (request construction, 200/401/403/404/429/400
  classification) that `testOpenaiKey()` already implements, into a shared
  helper parameterized by base URL, provider name (for `transportFailure()`'s
  log tag) and whether userinfo/scheme validation applies (OpenAI only,
  since it's the only one with an operator-supplied URL). `testOpenaiKey()`
  and the three new probes below all call it. This avoids three more ~170
  line near-copies of the same status-classification logic — the exact kind
  of drift risk `defineIntegrationIn()` and `AI_COLUMNS` already exist to
  prevent elsewhere in this module.
- **`src/lib/ai/{mistral,qwen,deepseek}.ts`** — three new thin probe modules
  (`testMistralKey`, `testQwenKey`, `testDeepseekKey`), each calling the
  shared helper with their fixed base URL. No URL-validation logic needed
  (fixed URL, not user input).
- **`src/lib/ai/probes.ts`** — three new entries in `AI_PROBES`.
- **`src/lib/ai/columns.ts`** — three new entries in `AI_COLUMNS`
  (`{provider}Enabled`/`{provider}ApiKey`/`{provider}Model`, no `apiUrl`
  since none is user-configurable).
- **`src/lib/db/schema/users.ts`** — nine new columns (three providers ×
  three columns each), plus a migration. Defaults follow the existing
  hand-maintained-duplicate convention (`defaults.test.ts` already checks
  this pattern and will need the three new providers added to it).
- **`src/lib/ai/run.ts`** (`AIClient`) — three new provider branches. Since
  Mistral, Qwen and DeepSeek all speak the same OpenAI-compatible
  `/chat/completions` shape as `callOpenai()` (just a different fixed base
  URL and no configurable one), extract a shared
  `callOpenaiCompatible(baseUrl, apiKey, model, prompt, jsonMode)` helper
  that `callOpenai()` and the three new branches all use, rather than
  pasting the same request-building/response-parsing block four times.
- **`src/lib/ai/actions.ts`** — three new `defineIntegration()` blocks (one
  per provider) and three new `PROVIDER_KEYS` entries, following the
  Anthropic/Gemini shape exactly (no `apiUrl` field in the schema).
- **`messages/en.json` + `messages/de.json`** — three new provider blocks
  under the `ai` namespace (`required`/`rejected`/`quota`/`modelUnknown`),
  parallel to the existing `anthropic`/`gemini` blocks.
- **`src/components/ai/provider-section.tsx`** — no code change expected; it
  already iterates `AI_PROVIDERS` and `AI_COLUMNS` generically. Verify by
  running it against the expanded list.
- **Tests**: `providers.test.ts`, `columns.test.ts`, `probes.test.ts` (or
  equivalent) extended for completeness against the three new providers;
  `defaults.test.ts` extended for the nine new column defaults; new probe
  tests for the three providers' status classification, following
  `openai.test.ts`'s shape.

## Part 2 — AI usage limits (new subsystem)

### Storage

New table `ai_requests`:

```ts
export const aiRequests = sqliteTable(
  "ai_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [index("ai_requests_user_created_idx").on(table.userId, table.createdAt)],
);
```

One row per attempted AI call (see "what counts as usage" below).

### Check-and-record

A new function, `checkAndRecordAiUsage(tx, userId, dailyLimit, monthlyLimit)`
in `src/lib/ai/usage.ts`, called inside a `writeTransaction()` (so the
read-then-write is atomic under `BEGIN IMMEDIATE`, the same ordering hazard
`setActiveProvider()` already guards against):

1. Compute UTC start-of-day and start-of-month for "now".
2. Delete this user's rows older than start-of-month (bounds table growth
   without a separate cleanup job — nothing needs rows older than the
   longer of the two windows).
3. Count this user's remaining rows since start-of-day; if `>= dailyLimit`,
   return `"dailyLimitExceeded"` without inserting.
4. Count this user's rows since start-of-month; if `>= monthlyLimit`, return
   `"monthlyLimitExceeded"` without inserting.
5. Otherwise insert a new row and return `"ok"`.

**What counts as usage**: every attempted call, not just successful ones.
The setting is documented as "the most AI requests Yana makes," which is
about outbound calls to the provider, not about successful completions —
and counting only successes would let a provider outage or a string of 500s
bypass the limit entirely.

**Reset semantics**: calendar UTC day/month, not a rolling window — simplest
to reason about, and consistent with this repo's existing `timeZone: "UTC"`
convention for anything server-side.

### Chokepoint: `AIClient.generateResponse()`

`generateResponse()`'s return type changes from `string | null` to:

```ts
type AiGenerationResult =
  | { ok: true; text: string }
  | { ok: false; reason: "noProvider" | "dailyLimitExceeded" | "monthlyLimitExceeded" | "providerError" };
```

It calls `checkAndRecordAiUsage()` first (using `this.settings.userId`,
`aiDefaultDailyLimit`, `aiDefaultMonthlyLimit` off the settings row), before
making any outbound call. `applyAiOptions()` (same file, the only existing
caller) is updated to match on `.ok` instead of truthiness — a contained,
mechanical change since both live in `run.ts`. `applyAiOptions()` itself has
no live caller yet (`src/lib/jobs/handlers/aggregate.ts` calls `aggregate()`
with no `userSettings`, per the existing comment in `aggregators/base.ts`),
so this change carries no behavior risk today — it just means the limit is
already correctly wired for whenever that gets connected.

If `this.settings.userId` is missing (nothing currently passes a settings
object without one in practice, since both real call sites read a full
`user_settings` row), the usage check is skipped with a logged warning
rather than thrown — consistent with this module's existing
warn-and-return-null-on-misconfiguration style.

## Part 3 — `POST /api/v1/ai/prompt`

New file: `src/app/api/v1/ai/prompt/route.ts`. Follows
`src/app/api/v1/aggregate/route.ts`'s conventions (no `connection()` call —
POST route handlers aren't prerendered, so there's nothing to opt out of).

```ts
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser(request);

    const settings = getDb().select().from(userSettings)
      .where(eq(userSettings.userId, user.id)).get();
    if (!settings) throw new Error(`no user_settings row for user "${user.id}"`);

    const body = await request.json();
    const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) throw new ApiError(400, "invalid_prompt", "prompt is required.");
    if (prompt.length > settings.aiMaxPromptLength) {
      throw new ApiError(400, "prompt_too_long", "prompt exceeds the configured length limit.");
    }

    const providerKey = activeProvider(settings);
    if (!providerKey) throw new ApiError(409, "no_active_provider", "No AI provider is configured.");

    const client = new AIClient(settings);
    const result = await client.generateResponse(prompt);

    if (!result.ok) {
      switch (result.reason) {
        case "dailyLimitExceeded": throw new ApiError(429, "daily_limit_exceeded");
        case "monthlyLimitExceeded": throw new ApiError(429, "monthly_limit_exceeded");
        case "noProvider": throw new ApiError(409, "no_active_provider");
        case "providerError": throw new ApiError(502, "provider_error");
      }
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

Notes:

- Settings are read directly by `user.id` (not via `getSettings()`, which is
  bound to the cookie-session-derived `currentUserId()` and would not work
  correctly for a Bearer-token caller) — the same pattern
  `src/lib/jobs/handlers/retention.ts` already uses for non-session
  contexts.
- A missing `user_settings` row is a provisioning bug (per the existing
  `getSettings()` convention) and is thrown as a bare `Error`, which
  propagates past the `ApiError`-only catch to Next's default 500 — not a
  case worth a specific `ApiError` code, since it should never happen for a
  real account.
- `ApiError` codes (`invalid_prompt`, `prompt_too_long`, `no_active_provider`,
  `daily_limit_exceeded`, `monthly_limit_exceeded`, `provider_error`) are
  machine-readable strings for the native client to branch on, per this
  API's existing no-echo convention — no request content or provider prose
  is ever included in the message.

## Testing

- `checkAndRecordAiUsage()`: window boundaries (a request exactly at the
  limit, one over), UTC day/month rollover, the opportunistic cleanup, and
  that it is atomic under concurrent calls (mirroring how
  `setActiveProvider()`'s test covers its own read-then-write race).
- `route.test.ts` for the new endpoint: missing/invalid/oversized prompt, no
  active provider, a provider call succeeding, each rate-limit and
  provider-error path, Bearer-token and expired-token auth failures (mirrors
  existing `api/v1/**` route tests).
- Provider expansion tests as listed in Part 1.

## Open questions

None — all material decisions were confirmed with the user during
brainstorming. Implementation-level details (exact German copy for new
catalog strings, exact migration file numbering, etc.) are left to the
planning/implementation stage.
