import { openaiCompatibleChatProbe } from "@/lib/integrations/probe";
import type { ProbeResult } from "@/lib/integrations/probe";

const QWEN_API_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";

export async function testQwenKey({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): Promise<ProbeResult> {
  return openaiCompatibleChatProbe({
    providerName: "qwen",
    endpoint: QWEN_API_URL,
    apiKey,
    model,
  });
}
