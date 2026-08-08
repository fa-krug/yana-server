import { eq } from "drizzle-orm";

import { ApiError, apiErrorResponse, requireApiUser } from "@/lib/api/auth";
import { AI_COLUMNS } from "@/lib/ai/columns";
import { activeProvider } from "@/lib/ai/queries";
import { AIClient } from "@/lib/ai/run";
import { getDb } from "@/lib/db/client";
import { userSettings } from "@/lib/db/schema";

/**
 * The native client's server-mediated "ask AI" call: a free-form prompt run
 * against the caller's configured AI provider, using their stored
 * credentials and global tuning values -- no per-request overrides. See the
 * design spec at
 * `docs/superpowers/specs/2026-08-04-ai-provider-expansion-and-prompt-endpoint-design.md`.
 *
 * Settings are read directly by `user.id`, not via `getSettings()` -- that
 * helper is bound to the cookie-session-derived `currentUserId()` and would
 * not resolve correctly for a Bearer-token caller. This is the same pattern
 * `src/lib/jobs/handlers/retention.ts` already uses outside a session
 * context.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const user = await requireApiUser(request);

    const settings = getDb()
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, user.id))
      .get();
    if (!settings) {
      // A provisioning bug, never expected for a real account -- propagates
      // past this route's ApiError-only catch to Next's default 500.
      throw new Error(`no user_settings row for user "${user.id}"`);
    }

    const body: unknown = await request.json().catch(() => null);
    const rawPrompt =
      typeof body === "object" && body !== null && "prompt" in body
        ? (body as { prompt: unknown }).prompt
        : undefined;
    const prompt = typeof rawPrompt === "string" ? rawPrompt.trim() : "";
    if (!prompt) {
      throw new ApiError(400, "invalid_prompt", "prompt is required.");
    }
    if (prompt.length > settings.aiMaxPromptLength) {
      throw new ApiError(400, "prompt_too_long", "prompt exceeds the configured length limit.");
    }

    const providerKey = activeProvider(settings);
    if (!providerKey) {
      throw new ApiError(409, "no_active_provider", "No AI provider is configured.");
    }

    const client = new AIClient(settings);
    const result = await client.generateResponse(prompt);

    if (!result.ok) {
      if (result.reason === "dailyLimitExceeded") {
        throw new ApiError(429, "daily_limit_exceeded", "The daily AI request limit is reached.");
      }
      if (result.reason === "monthlyLimitExceeded") {
        throw new ApiError(
          429,
          "monthly_limit_exceeded",
          "The monthly AI request limit is reached.",
        );
      }
      if (result.reason === "noProvider") {
        throw new ApiError(409, "no_active_provider", "No AI provider is configured.");
      }
      if (result.reason === "providerUnauthorized") {
        throw new ApiError(
          502,
          "provider_unauthorized",
          "The configured AI provider rejected the stored credentials.",
        );
      }
      throw new ApiError(502, "provider_error", "The AI provider could not fulfil this prompt.");
    }

    return Response.json({
      response: result.text,
      provider: providerKey,
      model: settings[AI_COLUMNS[providerKey].model],
    });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
