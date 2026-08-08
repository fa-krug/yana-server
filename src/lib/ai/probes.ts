import type { ProbeResult } from "@/lib/integrations/probe";

import { testAnthropicKey } from "./anthropic";
import { testDeepseekKey } from "./deepseek";
import { testGeminiKey } from "./gemini";
import { testMistralKey } from "./mistral";
import { testOpenaiKey } from "./openai";
import { testOpenrouterKey } from "./openrouter";
import { testQwenKey } from "./qwen";
import type { AiProviderKey } from "./providers";

/**
 * The server half of the AI provider registry: which live probe answers for
 * which provider.
 *
 * **Split from `./providers` by a human ruling, and the split is the same one
 * `src/lib/users/fields.ts` and `queries.ts` make.** `./providers` is rendered
 * by client components -- the provider tabs, the model select, whether a
 * base-URL field exists -- so anything reachable from it reaches the browser
 * bundle. These are outbound `fetch` calls that only a server action makes, and
 * a form has no business importing them. Nothing here throws a bundler error if
 * it is imported from the wrong side, which is exactly why the separation has
 * to be structural rather than remembered.
 *
 * The per-provider reasoning -- what each probe requests, whether it inspects a
 * 200 body, and how it reads each status -- lives in the six modules this
 * imports, not here. This file is only the wiring.
 */

/**
 * What a probe is handed.
 *
 * `apiUrl` is optional because only one provider has a column for it
 * (`user_settings.openaiApiUrl`); `AiProvider.hasCustomUrl` is the declared fact
 * and the credential shape follows it. Each entry below destructures only the
 * fields its provider owns, so a provider with no base URL is structurally
 * unable to read one it was handed by mistake.
 */
export type AiCredentials = {
  apiKey: string;
  model: string;
  apiUrl?: string;
};

export type AiProbe = (credentials: AiCredentials) => Promise<ProbeResult>;

/**
 * A `Record` keyed by the union rather than a list, so that widening
 * `AiProviderKey` without adding a probe is a `npm run typecheck` failure at
 * this object instead of an `undefined` discovered when someone presses Test.
 */
export const AI_PROBES: Record<AiProviderKey, AiProbe> = {
  openai: ({ apiKey, apiUrl, model }) => testOpenaiKey({ apiKey, apiUrl, model }),
  // Destructured without `apiUrl`: these five have no column for one and cannot
  // read one they are handed.
  anthropic: ({ apiKey, model }) => testAnthropicKey({ apiKey, model }),
  gemini: ({ apiKey, model }) => testGeminiKey({ apiKey, model }),
  mistral: ({ apiKey, model }) => testMistralKey({ apiKey, model }),
  qwen: ({ apiKey, model }) => testQwenKey({ apiKey, model }),
  deepseek: ({ apiKey, model }) => testDeepseekKey({ apiKey, model }),
  openrouter: ({ apiKey, model }) => testOpenrouterKey({ apiKey, model }),
};
