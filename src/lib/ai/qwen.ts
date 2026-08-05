import { openaiCompatibleChatProbe } from "@/lib/integrations/probe";
import type { ProbeResult } from "@/lib/integrations/probe";

import { QWEN_API_URL } from "./providers";

/**
 * Qwen's endpoint is fixed (no operator setting, see `providers.ts`), so
 * unlike OpenAI's probe there is no URL to validate — this only ever calls
 * the shared OpenAI-compatible probe with a literal endpoint. The base URL
 * itself is `QWEN_API_URL`, imported rather than declared here, so this probe
 * and `run.ts`'s `callQwen()` cannot drift apart on it.
 */
export async function testQwenKey({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): Promise<ProbeResult> {
  return openaiCompatibleChatProbe({
    providerName: "qwen",
    endpoint: `${QWEN_API_URL}/chat/completions`,
    apiKey,
    model,
  });
}
