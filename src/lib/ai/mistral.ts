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
