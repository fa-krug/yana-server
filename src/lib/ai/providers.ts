import type { ProbeResult } from "@/lib/integrations/probe";

import { testAnthropicKey } from "./anthropic";
import { testGeminiKey } from "./gemini";
import { testOpenaiKey } from "./openai";

/**
 * One declaration per AI provider: its models, whether its endpoint is
 * configurable, how a rate limit should be read, and the probe that answers for
 * it.
 *
 * **Why a registry rather than three sections.** Phase 6 shipped two credential
 * providers as two near-twin sequences and phase 7's refactor turned that into
 * `defineIntegrationIn()` precisely because five copies is a drift problem
 * rather than a length one. These three are declared the same way: adding a
 * fourth provider is an entry in `AI_PROVIDERS`, not an edit to the form, the
 * action and the client.
 *
 * **This module holds no secrets and reaches no database.** It is the
 * declaration; `src/lib/ai/{openai,anthropic,gemini}.ts` hold the live probes
 * and the reasoning behind each one's two answers, and the actions/queries that
 * consume it are the tasks after this one.
 */

export type AiProviderKey = "openai" | "anthropic" | "gemini";

/** One entry in a provider's model select. `label` is a brand name, never translated. */
export type AiModel = { value: string; label: string };

/**
 * What a probe is handed.
 *
 * `apiUrl` is optional because only one provider has a column for it
 * (`user_settings.openaiApiUrl`); `hasCustomUrl` below is the declared fact and
 * the credential shape follows it. A provider whose `hasCustomUrl` is `false`
 * destructures without `apiUrl` in its own signature, so it is structurally
 * unable to read one it was handed by mistake.
 */
export type AiCredentials = {
  apiKey: string;
  model: string;
  apiUrl?: string;
};

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
   * declared here rather than at the descriptor so that the fact and the probe
   * that produces the `quota` cause are decided in one place; the actions task
   * passes it straight through.
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
   *   consulted -- see `openai.ts` -- so what reaches `quota` really is only a
   *   rate limit, and it is still not trusted.)
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
  probe: (credentials: AiCredentials) => Promise<ProbeResult>;
};

/**
 * The three providers, in the order the page renders them.
 *
 * **Model lists are cheapest-capable first, and were looked up rather than
 * carried over.** The schema's column defaults (`gpt-4o-mini`,
 * `claude-3-5-sonnet-20240620`, `gemini-1.5-flash`) are stale by two model
 * generations; phase 2 copied them verbatim so that refreshing them would be a
 * visible change here. Each `defaultModel` is the cheapest entry on its list,
 * because the workload is summarising an article. Sources are recorded in the
 * commit message and in the task report.
 *
 * **Deliberately three.** The direction record defers provider expansion (the
 * iOS client supports seven) as a separate concern; this is not the place to
 * widen it.
 */
export const AI_PROVIDERS: readonly AiProvider[] = [
  {
    key: "openai",
    label: "OpenAI",
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
    probe: ({ apiKey, apiUrl, model }) => testOpenaiKey({ apiKey, apiUrl, model }),
  },
  {
    key: "anthropic",
    label: "Anthropic",
    models: [
      { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      { value: "claude-sonnet-5", label: "Claude Sonnet 5" },
      { value: "claude-opus-5", label: "Claude Opus 5" },
    ],
    defaultModel: "claude-haiku-4-5",
    hasCustomUrl: false,
    quotaMeansVerified: true,
    // Destructured without `apiUrl`: this provider has no column for one and
    // cannot read one it is handed.
    probe: ({ apiKey, model }) => testAnthropicKey({ apiKey, model }),
  },
  {
    key: "gemini",
    label: "Gemini",
    models: [
      { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
      { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
      { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
    ],
    defaultModel: "gemini-3.5-flash-lite",
    hasCustomUrl: false,
    quotaMeansVerified: true,
    probe: ({ apiKey, model }) => testGeminiKey({ apiKey, model }),
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
