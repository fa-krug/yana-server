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
