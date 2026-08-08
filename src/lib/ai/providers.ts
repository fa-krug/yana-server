/**
 * What each AI provider *is* -- its models, whether its endpoint is
 * configurable, and how a rate limit from it should be read.
 *
 * **This module imports nothing, and that is the point of it existing
 * separately from `./probes`.** It is the `src/lib/users/fields.ts` to that
 * module's `queries.ts`: everything here is rendered by the `/ai` page's client
 * components -- the provider tabs, the model `<Select>`, whether a base-URL
 * field appears at all -- so anything reachable from here reaches the browser
 * bundle. The six live probes are `fetch` calls that only a server action ever
 * makes, and they are one import away in `./probes`, keyed by the same
 * `AiProviderKey`. Splitting them was a human ruling; keep the halves apart.
 *
 * **Why a registry rather than six hand-written sections.** Phase 6 shipped
 * two credential providers as two near-twin sequences and phase 7's refactor
 * turned that into `defineIntegrationIn()` precisely because five copies is a
 * drift problem rather than a length one. These six are declared the same
 * way: adding a seventh provider is an entry in `AI_PROVIDERS` plus an entry in
 * `AI_PROBES`, not an edit to the form, the action and the client.
 */

export type AiProviderKey =
  "openai" | "anthropic" | "gemini" | "mistral" | "qwen" | "deepseek" | "openrouter";

/**
 * Where an OpenAI credential is probed, and what a fresh `user_settings` row
 * starts on, when the operator configured no base URL of their own.
 *
 * **It lives in the client-safe half deliberately**, even though `./openai` is
 * its only *probe*-side reader. Three other places need the same string and none
 * of them may import a probe module: the column default in
 * `src/lib/db/schema/users.ts`, the empty-field fallback in
 * `src/lib/ai/actions.ts`, and the `/ai` form's placeholder in task 3 -- which is
 * a client component, and `eslint.config.mjs` restricts the whole of
 * `src/lib/ai/*` probe surface from `src/components/**` for bundle weight. Task
 * 1 put it in `./openai`, where it was the one fact about the provider that a
 * form could not reach; moving it here is the "reconcile" the phase-7 task-2
 * addendum asked for.
 *
 * The schema's DDL default is a hand-maintained duplicate of this value --
 * `defaults.test.ts` migrates a real database and compares the two, so a change
 * here that is not accompanied by a migration fails a test rather than leaving a
 * fresh account pointed at a stale endpoint.
 */
export const OPENAI_DEFAULT_API_URL = "https://api.openai.com/v1";

/**
 * Mistral's, Qwen's and DeepSeek's fixed base URLs -- the same reason
 * `OPENAI_DEFAULT_API_URL` lives here rather than in a probe module: both
 * sides that need one (each provider's probe, in `./mistral`, `./qwen` and
 * `./deepseek`, and `run.ts`'s matching `callMistral`/`callQwen`/`callDeepseek`
 * methods) must agree, and a client-safe constant is the only place both can
 * import from without a probe module reaching the browser bundle. Unlike
 * OpenAI's, none of these three is an operator setting -- there is no column,
 * no form field and no fallback logic around them, just one literal each.
 */
export const MISTRAL_API_URL = "https://api.mistral.ai/v1";
export const QWEN_API_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
export const DEEPSEEK_API_URL = "https://api.deepseek.com/v1";

/**
 * OpenRouter's fixed base URL -- same reason as the three above: both sides
 * that need it (the probe in `./openrouter` and `run.ts`'s matching
 * `callOpenrouter` method) must agree, and a client-safe constant is the only
 * place both can import from without a probe module reaching the browser
 * bundle. Not an operator setting -- no column, no form field, one literal.
 */
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";

/** One entry in a provider's model select. `label` is a brand name, never translated. */
export type AiModel = { value: string; label: string };

export type AiProvider = {
  key: AiProviderKey;
  /** The provider's own name. The one accepted untranslated literal, like "Yana". */
  label: string;
  models: readonly AiModel[];
  defaultModel: string;
  /** Whether this provider's base URL is an operator setting. */
  hasCustomUrl: boolean;
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
  /**
   * **Does a rate-limit answer from this provider prove the credential was
   * accepted?**
   *
   * A **required** field, mirroring `ProviderKeys.quotaMeansVerified` in
   * `@/lib/integrations/define`, so that adding a provider forces the decision
   * rather than inheriting a neighbour's answer by copying a branch. It is
   * declared here, in the client-safe half, because it is a *fact about the
   * provider* rather than part of the request its probe makes -- and because
   * the actions task reads it from the same entry everything else about the
   * provider comes from.
   *
   * **The reasoning below is duplicated, deliberately, at each probe's 429
   * branch in `./openai`, `./anthropic` and `./gemini`.** The fact and the code
   * that produces the `quota` cause now live in different files, and a reader
   * arriving at either one has to be able to see why the answer is what it is.
   * Change one and change the other; `providers.test.ts` pins the values, so a
   * divergence in the *values* fails a test even though a divergence in the
   * prose cannot.
   *
   * All seven answers, and why they are not the same:
   *
   * - **OpenAI: `false`.** Two independent reasons, either of which is
   *   sufficient. This is the one provider whose base URL is an operator
   *   setting, so what answers may be a gateway that sheds load at its edge
   *   before it ever reads the `Authorization` header -- Reddit's situation
   *   exactly. And OpenAI puts `insufficient_quota` on the same 429 as
   *   `rate_limit_exceeded`; unlike YouTube's daily budget that one does not
   *   heal overnight, so treating it as a pass would put an "Active" badge on
   *   an integration that cannot make a single call. (The probe pulls
   *   `insufficient_quota` out into `unauthorized` before this field is ever
   *   consulted, so what reaches `quota` really is only a rate limit, and it is
   *   still not trusted.)
   * - **Anthropic: `true`.** Rate limits are per-organisation and resolved from
   *   the key; an unrecognised key answers 401 `authentication_error` and never
   *   reaches accounting. Credit exhaustion, the one non-healing case, is a 403
   *   `billing_error` here rather than a 429. The endpoint is fixed, so nothing
   *   can answer in front of the auth check.
   * - **Gemini: `true`,** for YouTube's stated reason rather than by
   *   inheritance: quota is charged to the project the key resolves to, so the
   *   key is validated first, and a key Google does not recognise answers
   *   `400 API_KEY_INVALID` instead. The endpoint is fixed here too.
   * - **Mistral: `true`.** `api.mistral.ai` is Mistral's own direct API
   *   endpoint -- not a third-party gateway or a CDN-fronted edge in front of
   *   it, the same "fixed direct endpoint, no operator-configurable proxy"
   *   argument that justifies Anthropic's and Gemini's `true` above. There is
   *   nothing positioned to shed load before Mistral's own auth check runs, so
   *   a 429 from it can only mean the key was already accepted.
   * - **DeepSeek: `true`,** by the identical argument: `api.deepseek.com` is
   *   DeepSeek's own direct endpoint, fixed and non-configurable, with no
   *   intermediary that could answer on the provider's behalf. A rate limit
   *   from it is DeepSeek itself, past its own key check.
   * - **Qwen: `true`, but the least confident of the six.** `dashscope-intl.aliyuncs.com`
   *   is Alibaba Cloud's DashScope endpoint -- still the provider's own
   *   service rather than a third-party proxy, so the same "no operator-config
   *   gateway" reasoning applies in principle. But Reddit's argument for `false`
   *   does *not* transfer here to argue the other way either: Reddit's edge is
   *   a third-party CDN shedding load in front of an *unrelated* origin before
   *   authentication, which is a different shape from Alibaba Cloud's own edge
   *   sitting in front of Alibaba Cloud's own service. What is missing is
   *   simply public documentation, at the level Anthropic's and Gemini's API
   *   docs provide, confirming DashScope's rate limiting happens strictly
   *   after key evaluation rather than at a CDN layer in front of it. Absent
   *   that confirmation this is a reasoned `true`, not a verified one, and it
   *   is exactly what phase 7's carried-forward mandatory pre-release manual
   *   pass (see "Carried forward from phase 7's review" in this repository's
   *   `CLAUDE.md`) must check for Qwen specifically before `/ai` reaches a
   *   user with Qwen configured.
   * - **OpenRouter: `false`.** It is itself an aggregator in front of many
   *   upstream providers and applies its own rate limiting -- including extra
   *   throttling specific to free-tier `:free` models -- independent of
   *   whether the submitted key is valid. A 429 from it does not prove the
   *   credential was accepted, the same reasoning as OpenAI's `false` above
   *   (for a different underlying cause: OpenAI's is an operator-configurable
   *   gateway, OpenRouter's own edge is the gateway).
   */
  quotaMeansVerified: boolean;
};

/**
 * The six providers, in the order the page renders them.
 *
 * **Model lists were looked up, not carried over, and they go stale.** Each
 * entry carries the date and the vendor page it was read from, because the
 * whole reason phase 2 copied the Django-era ids verbatim was so that
 * refreshing them would be a visible, deliberate change -- and the next refresh
 * needs to know where to look without reading a commit message. The schema's
 * column defaults (`gpt-4o-mini`, `claude-3-5-sonnet-20240620`,
 * `gemini-1.5-flash`) still carry the stale values and are the actions task's
 * migration; `providers.test.ts` asserts none of them survived into here.
 *
 * **Each list is ordered cheapest-capable first, and each `defaultModel` is its
 * first entry,** because the workload is summarising one article.
 *
 * **Six providers now, matching yana-ios, plus OpenRouter as a seventh.** The
 * direction record originally deferred expansion beyond the initial three
 * (OpenAI, Anthropic, Gemini); that was widened to six to match yana-ios's
 * full provider list. Apple Intelligence (the seventh in yana-ios) is
 * deliberately excluded here as it is on-device only with no server-side
 * equivalent. OpenRouter is added independently of yana-ios parity -- it has
 * no yana-ios equivalent -- because it is an aggregator in front of hundreds
 * of upstream models rather than a single vendor's API, which is also why it
 * is the one entry with `hasDynamicModels: true`.
 */
export const AI_PROVIDERS: readonly AiProvider[] = [
  {
    key: "openai",
    label: "OpenAI",
    // Looked up 2026-08-01 against https://developers.openai.com/api/docs/models
    // `gpt-5.6` is documented as an alias of `gpt-5.6-sol`; the explicit id is
    // stored so the select's value and the model actually billed cannot drift.
    models: [
      { value: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
      { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
      { value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    ],
    defaultModel: "gpt-5.6-luna",
    // The only provider with a configurable base URL, for OpenAI-compatible
    // gateways. That single fact is also why its probe checks the 200 body and
    // why `quotaMeansVerified` is false -- both above.
    hasCustomUrl: true,
    hasDynamicModels: false,
    quotaMeansVerified: false,
  },
  {
    key: "anthropic",
    label: "Anthropic",
    // Looked up 2026-08-01 against
    // https://platform.claude.com/docs/en/about-claude/models/overview
    // $1/$5, $3/$15 and $5/$25 per MTok respectively. `claude-haiku-4-5` is the
    // documented alias for the pinned `claude-haiku-4-5-20251001`; the other two
    // ids are already dateless pinned snapshots.
    models: [
      { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { value: "claude-opus-5", label: "Claude Opus 5" },
    ],
    defaultModel: "claude-haiku-4-5",
    hasCustomUrl: false,
    hasDynamicModels: false,
    quotaMeansVerified: true,
  },
  {
    key: "gemini",
    label: "Gemini",
    // Looked up 2026-08-01 against https://ai.google.dev/gemini-api/docs/models
    // (page last updated 2026-07-30). All three are GA; the preview ids
    // (`gemini-3.1-pro-preview`, `gemini-3-flash-preview`) are excluded because
    // a preview can be withdrawn out from under a stored setting.
    //
    // **Ordered by tier, and Gemini's version numbers do not track tier** -- so
    // this list reads 3.5, 3.6, 3.5 and is still cheapest-capable first. The
    // docs' own words are the ordering: Flash-Lite is "fastest, most
    // cost-effective", 3.6 Flash "balances speed with intelligence", and 3.5
    // Flash is the "most intelligent model for sustained frontier performance".
    // Sorting these by version number would put the most expensive one in the
    // middle and make the default look arbitrary.
    models: [
      { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
      { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    ],
    defaultModel: "gemini-3.5-flash-lite",
    hasCustomUrl: false,
    hasDynamicModels: false,
    quotaMeansVerified: true,
  },
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
    hasDynamicModels: false,
    // Fixed endpoint, same reasoning as Anthropic/Gemini's `true`: a 429 can
    // only come from Mistral itself having already accepted the key.
    quotaMeansVerified: true,
  },
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
    hasDynamicModels: false,
    quotaMeansVerified: true,
  },
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
    hasDynamicModels: false,
    quotaMeansVerified: true,
  },
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
];

/**
 * The declaration for a stored `active_ai_provider`, or `undefined`.
 *
 * Takes a `string` rather than an `AiProviderKey` on purpose: every caller is
 * holding a value read out of the database or off a form, where the compiler
 * has nothing to check. Narrowing is what this function is for.
 */
export function providerByKey(key: string): AiProvider | undefined {
  return AI_PROVIDERS.find((provider) => provider.key === key);
}
