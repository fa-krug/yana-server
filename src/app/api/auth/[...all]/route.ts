import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth/server";

/**
 * Every Better Auth endpoint, mounted under /api/auth/*. The catch-all segment
 * is what the library's `basePath` default expects.
 *
 * No `connection()` call, unlike /health: a route whose only segment is dynamic
 * (`[...all]`) and which declares no `generateStaticParams` is never
 * prerendered, so the reason /health needs it -- a GET with no dynamic input
 * that Next would happily bake at build time -- does not apply. `next build`
 * lists this route as dynamic; if that ever changes, add `await connection()`
 * here rather than `dynamic = "force-dynamic"`.
 *
 * Better Auth only serves GET and POST. `toNextJsHandler` also returns PUT,
 * PATCH and DELETE, and exporting them would advertise methods that answer 404
 * for every path, so they stay unexported.
 */
export const { GET, POST } = toNextJsHandler(auth);
