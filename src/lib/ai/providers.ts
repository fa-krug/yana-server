/**
 * What each AI provider *is* -- its models, whether its endpoint is
 * configurable, and how a rate limit from it should be read.
 *
 * **This module imports nothing, and that is the point of it existing
 * separately from `./probes`.** It is the `src/lib/users/fields.ts` to that
 * module's `queries.ts`: everything here is rendered by the `/ai` page's client
 * components -- the provider tabs, the model `<Select>`, whether a base-URL
 * field appears at all -- so anything reachable from here reaches the browser
 * bundle. The three live probes are `fetch` calls that only a server action ever
 * makes, and they are one import away in `./probes`, keyed by the same
 * `AiProviderKey`. Splitting them was a human ruling; keep the halves apart.
 *
 * **Why a registry rather than three hand-written sections.** Phase 6 shipped
 * two credential providers as two near-twin sequences and phase 7's refactor
 * turned that into `defineIntegrationIn()` precisely because five copies is a
 * drift problem rather than a length one. These three are declared the same
 * way: adding a fourth provider is an entry in `AI_PROVIDERS` plus an entry in
 * `AI_PROBES`, not an edit to the form, the action and the client.
 */

export type AiProviderKey = "openai" | "anthropic" | "gemini";

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
   * All three answers, and why they are not the same:
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
   */
  quotaMeansVerified: boolean;
};

/**
 * The three providers, in the order the page renders them.
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
 * **Deliberately three.** The direction record defers provider expansion (the
 * iOS client supports seven) as a separate concern; this is not the place to
 * widen it.
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
    quotaMeansVerified: true,
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
