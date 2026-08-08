# OpenRouter AI provider, auto-collected model catalog, and a clearer
# "provider rejected the credentials" error on the mobile prompt endpoint

Status: approved for planning.

## Context

`/ai` currently supports six AI providers (OpenAI, Anthropic, Gemini, Mistral,
Qwen, DeepSeek), declared as a client-safe registry in `src/lib/ai/providers.ts`
plus a matching `defineIntegration()` descriptor per provider in
`src/lib/ai/actions.ts`. Every one of the six ships a **static, hand-maintained
model list** looked up from the vendor's docs at a point in time.

OpenRouter is a seventh provider, but it cannot use that pattern as-is:
OpenRouter aggregates hundreds of underlying models (400 at the time this was
written) that change continuously, including a rotating set of zero-cost
`:free`-tagged models. A static list would be wrong the day it ships. This
design adds OpenRouter following the existing six-provider shape everywhere
that shape still fits, and deviates only where the dynamic catalog forces it.

Separately, `POST /api/v1/ai/prompt` (the mobile client's ask-AI endpoint)
collapses every non-2xx response from the active provider into one generic
`provider_error` / 502. A revoked or mistyped key produces the same response as
a transient outage, so the mobile client has no way to tell a user "go fix your
AI settings" from "try again later." This design adds a distinct error for
that case.

## 1. OpenRouter as a provider

Follows the Mistral/Qwen/DeepSeek shape exactly (fixed endpoint, OpenAI-request
shape, no operator-configurable base URL):

- `AiProviderKey` gains `"openrouter"`.
- `OPENROUTER_API_URL = "https://openrouter.ai/api/v1"` in `providers.ts`,
  beside `MISTRAL_API_URL` etc.
- Three new `user_settings` columns, added in one migration (pure additions,
  so `drizzle-kit generate` needs no interactive prompt):
  `openrouterEnabled` (bool, default `false`), `openrouterApiKey` (text,
  default `""`), `openrouterModel` (text, default `"openrouter/free"` — see
  §2). Mirrors the Mistral/Qwen/DeepSeek columns exactly; no `apiUrl` column,
  same as those three.
- `AI_COLUMNS.openrouter` in `columns.ts`: `{ enabled, apiKey, model }`.
- `src/lib/ai/openrouter.ts`: `testOpenrouterKey({ apiKey, model })`, calling
  `openaiCompatibleChatProbe()` with a literal `${OPENROUTER_API_URL}/chat/completions`
  endpoint — the same shape as `mistral.ts`. Default `maxTokensField` (`max_tokens`)
  applies; OpenRouter's own docs describe an OpenAI-compatible `/chat/completions`
  body with no o-series-style restriction.
- `AI_PROBES.openrouter` in `probes.ts`.
- `run.ts`: a `callOpenrouter()` private method calling
  `callOpenaiCompatible(OPENROUTER_API_URL, apiKey, model, prompt, jsonMode, timeout)`,
  wired into `generateResponse()`'s provider dispatch and into
  `AiRuntimeSettings` (`openrouter_enabled`/`openrouter_api_key`/`openrouter_model`
  snake_case fallbacks, matching every other provider).
- `actions.ts`: an `openrouter` `defineIntegration()` entry, `PROVIDER_KEYS.openrouter`
  (`required`/`rejected`/`quota`/`modelUnknown` — see §2 for why `modelUnknown`
  goes unused), added to `PROVIDER_ACTIONS`.
- Catalog: `messages/en.json` and `messages/de.json` gain an `ai.openrouter`
  block, worded like the Mistral/Qwen/DeepSeek ones ("OpenRouter would not
  accept these credentials...", "The key is valid — OpenRouter is rate
  limiting it right now...").

### `quotaMeansVerified: false`

Unlike Mistral/Qwen/DeepSeek's direct-endpoint reasoning (`true`, because
nothing sits in front of the provider's own key check), OpenRouter is itself
an aggregator/gateway in front of many upstream providers, and it applies its
own rate limiting — including extra throttling specific to free-tier `:free`
models — independent of whether the submitted key is valid. A 429 from it does
not prove the credential was accepted, so this follows OpenAI's `false`
reasoning rather than the other four's `true`, documented inline the same way.

## 2. Auto-collected model catalog, including free models

### What changes on `AiProvider`

`hasDynamicModels: boolean` (new field, mirroring `hasCustomUrl`), `true` only
for OpenRouter. `AiProvider.models` still exists and is still required — it is
the safe fallback rendered before any refresh, and what `resolveModel()` falls
back to for a stale stored id. For OpenRouter it holds exactly two entries,
both OpenRouter's own routing aliases rather than any specific vendor's model,
so neither can be discontinued the way a pinned model id can:

```
models: [
  { value: "openrouter/free", label: "Free (auto-routed)" },
  { value: "openrouter/auto", label: "Auto (any model, may cost)" },
],
defaultModel: "openrouter/free",
```

`openrouter/free` is OpenRouter's own router that "selects free models at
random from the models available on OpenRouter" and "smartly filters for
models that support features needed for your request" — confirmed live
against OpenRouter's own model page. It guarantees $0 cost on every request,
which is what makes it the right out-of-the-box default for a page whose
whole premise ("I will provide a token to test") is often a free-tier key.
`openrouter/auto` is offered alongside it for a user who wants OpenRouter's
best-available routing and accepts that it may pick a paid model.

### Fetching the live catalog

A new server action, `listOpenrouterModels()` in `src/lib/ai/actions.ts`:

- `GET https://openrouter.ai/api/v1/models` — public, unauthenticated,
  confirmed live (200, `{ data: [...] }`, 400 models at time of writing, 17
  tagged free via `pricing.prompt === "0" && pricing.completion === "0"`).
- Maps each entry to `{ value: id, label }`, where `label` is the vendor's
  `name` field with a `" (Free)"` suffix appended for zero-cost entries.
- Sorts free entries first (matches "including the free endpoint" from the
  request — a user should not have to scroll past 380 paid entries to find
  one).
- Every fetch failure (network, timeout, non-200, unparseable body) collapses
  to one outcome: `{ ok: false, errorKey: "openrouter.modelsFetchFailed" }`.
  Deliberately not reusing the integration catalog's `unreachable`/`timedOut`/
  `unexpected` keys — those are worded "...these credentials could not be
  verified," which is wrong for a catalog fetch that touches no credential at
  all. One new key, one plain message: "Could not load the current model list
  from OpenRouter. Try again in a moment."
- No server-side caching: refresh is manual (button-triggered), per the
  chosen approach, so there is no repeated-page-load cost to amortize.

### UI: `provider-section.tsx`

When the selected provider has `hasDynamicModels`, a "Refresh models" button
(new catalog key `ai.provider.refreshModels`, "Refreshing"/busy state reusing
the existing `busy` transition plumbing) renders beside the model `<Select>`.
Pressing it calls `listOpenrouterModels()` and, on success, replaces the
component's local `modelItems` state (currently derived directly from
`provider.models`; becomes state seeded from `provider.models` and
overwritable by a refresh) with the fetched list. On failure, a toast with
`t("openrouter.modelsFetchFailed")` and the list is left unchanged. The
currently-selected model value is preserved across a refresh even if it is not
in the freshly fetched list (Base UI's `<Select>` items rule already handles
an unlisted value by printing the raw id on the trigger — the existing
`resolveModel()` stale-id behavior, not a new concern).

### Validation on save

The shared `modelField(provider)` helper validates membership in the static
`provider.models` array — wrong for OpenRouter, whose valid ids come from a
live catalog the server does not re-fetch at submit time. OpenRouter's schema
uses a new, more permissive field instead:

```
const openrouterModelField = z.string().trim().min(1).max(200);
```

An actually-invalid id (typo, retired model) is still refused — by OpenRouter
itself at probe time, surfacing through the existing generic `unexpected`
probe-failure path ("The provider answered in a way Yana did not expect").
`PROVIDER_KEYS.openrouter.modelUnknown` is declared for consistency with the
other six (the `Record<AiProviderKey, ...>` shape requires it) but is never
wired into `fieldErrorKeys`, since there is no static list to validate against
before the probe runs. A one-line comment at the declaration says why, so a
reviewer does not "fix" the missing wiring as an oversight.

## 3. `/api/v1/ai/prompt`: a distinct "provider rejected the credentials" error

### Today

`AIClient.requestWithRetry()` returns `null` on any non-2xx, non-429 response,
indistinguishable from a 500 or a malformed body by the time `generateResponse()`
sees it; both become `{ ok: false, reason: "providerError" }`, and the route
answers `502 provider_error` either way.

### Change

`requestWithRetry()` gains one new case: on `response.status === 401 || response.status === 403`,
throw `new ProviderUnauthorizedError()` (new class, same file) instead of
returning `null` — no retry, matching the existing no-retry behavior for every
non-429 failure status today. This propagates automatically through
`callOpenai()`/`callAnthropic()`/`callOpenaiCompatible()` (none of them catch)
to `generateResponse()`'s existing outer `try`/`catch`, which gains one check:

```
catch (e: unknown) {
  if (e instanceof ProviderUnauthorizedError) {
    return { ok: false, reason: "providerUnauthorized" };
  }
  console.warn(`AI API call failed: ${describeError(e)}`);
  return { ok: false, reason: "providerError" };
}
```

`AiGenerationResult`'s `reason` union gains `"providerUnauthorized"`.

`src/app/api/v1/ai/prompt/route.ts` gains one more branch, before the generic
fallback:

```
if (result.reason === "providerUnauthorized") {
  throw new ApiError(
    502,
    "provider_unauthorized",
    "The configured AI provider rejected the stored credentials.",
  );
}
```

Still 502 (the mobile client did nothing wrong; this server's stored
configuration is what's broken), but a distinct machine-readable `code` the
client can use to point the user at re-entering their key, instead of a
generic "try again" retry loop against a key that will never start working on
its own.

## Testing

- `providers.test.ts` / `columns.test.ts`: extend existing parity assertions
  (all `AiProviderKey`s present, `apiUrl` presence matches `hasCustomUrl`) to
  cover the seventh provider and the new `hasDynamicModels` field.
- `openrouter.test.ts`: mirrors `mistral.test.ts` — probe status
  classification (200/401/403/404/429/network/timeout), following the existing
  per-provider probe test shape.
- `run.test.ts`: extend the existing `AIClient` provider-dispatch tests with an
  `openrouter` case, and add cases for the new `ProviderUnauthorizedError` path
  (401 and 403 → `reason: "providerUnauthorized"`, distinct from a 500 →
  `"providerError"`).
- `actions.test.ts`: extend to cover `saveProvider("openrouter", ...)`,
  `testProvider`, `removeProvider`, and a new `listOpenrouterModels()` suite —
  success (parses a fixture response, free entries sorted first, labels
  suffixed), and every failure path collapsing to `modelsFetchFailed`.
- `src/app/api/v1/ai/prompt/route.test.ts` (new or extended, if one doesn't
  already exist for this route): a 401 from the active provider surfaces
  `provider_unauthorized`, not `provider_error`.
- `defaults.test.ts`: extend the schema-default-vs-registry-default parity
  check to `openrouterModel` / `"openrouter/free"`.
- `messages/en.json` / `de.json`: the existing key-parity test
  (`src/i18n/messages.test.ts`) covers the new `ai.openrouter.*` and
  `ai.provider.refreshModels` keys automatically once both files define them.

## Out of scope

- No server-side caching of the OpenRouter model catalog (manual refresh only,
  per the chosen approach).
- No "free models only" filter/toggle in the UI — free entries are sorted
  first and labeled, which was judged sufficient; a dedicated filter can be
  added later if it turns out to be needed.
- No changes to `applyAiOptions()`'s silent-failure behavior (a different gap,
  explicitly deferred — see the brainstorming transcript).
- No OpenRouter-specific headers (`HTTP-Referer`, `X-Title`) — optional
  attribution headers OpenRouter's docs mention, not required for the API to
  function, and no current requirement calls for them.
