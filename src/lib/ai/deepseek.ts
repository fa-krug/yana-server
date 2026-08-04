import { openaiCompatibleChatProbe } from "@/lib/integrations/probe";
import type { ProbeResult } from "@/lib/integrations/probe";

const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";

/**
 * DeepSeek's endpoint is fixed (no operator setting, see `providers.ts`), so
 * unlike OpenAI's probe there is no URL to validate — this only ever calls
 * the shared OpenAI-compatible probe with a literal endpoint.
 */
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
