import { connection } from "next/server";

import { ApiError, apiErrorResponse, requireApiBearerSession } from "@/lib/api/auth";
import { mintWebviewSessionToken } from "@/lib/auth/webview-session";

/**
 * Mints a short-lived, single-use token the native client immediately loads
 * into `GET /webview-session` inside its `WKWebView`, to bootstrap a real
 * browser session for the server's own web UI without ever handling the
 * session cookie's value itself. See
 * `docs/superpowers/plans/2026-08-11-webview-session-bootstrap-server.md`.
 */
export async function POST(request: Request): Promise<Response> {
  await connection();

  try {
    const { token: sessionToken } = await requireApiBearerSession(request);
    const { token, expiresAt } = await mintWebviewSessionToken(sessionToken);
    return Response.json({ token, expiresAt: expiresAt.toISOString() });
  } catch (error) {
    if (error instanceof ApiError) return apiErrorResponse(error);
    throw error;
  }
}
