import type { z } from "zod";

/**
 * One documented `/api/v1/**`-or-flow route. Mirrors the shape
 * `defineIntegration()` (src/lib/integrations/define.ts) established:
 * required fields the compiler enforces, so a new route with no entry -- or
 * an entry missing a field -- fails a build or a test rather than a review.
 */
export interface EndpointDoc<Req extends z.ZodType = z.ZodType, Res extends z.ZodType = z.ZodType> {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  tag: string;
  summary: string;
  description: string;
  /**
   * - "bearer-or-cookie": `requireApiUser()` -- Bearer authoritative when
   *   present, cookie fallback otherwise.
   * - "bearer-only": `requireApiBearerSession()` -- Bearer required, no
   *   cookie fallback.
   * - "session-cookie": `requireUser()` -- the ordinary signed-in-user
   *   session, no Bearer path at all (`/device/pair`).
   * - "one-time-token": a single-use token in the query string, verified via
   *   Better Auth's `verifyOneTimeToken` (`/webview-session`).
   * - "none": no authentication (`/health` -- not documented by this
   *   registry today, reserved for completeness).
   */
  auth: "bearer-or-cookie" | "bearer-only" | "session-cookie" | "one-time-token" | "none";
  request?: {
    query?: z.ZodType;
    body?: Req;
  };
  response: {
    status: number;
    schema: Res | null;
    description: string;
    contentType?: string;
  };
  errors: Array<{ status: number; code: string; when: string }>;
  example?: { request?: unknown; response?: unknown };
}

export function defineEndpoint<Req extends z.ZodType, Res extends z.ZodType>(
  doc: EndpointDoc<Req, Res>,
): EndpointDoc<Req, Res> {
  return doc;
}
