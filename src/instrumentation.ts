/**
 * Next's startup hook: `register()` runs **once per server instance**, before
 * the first request is served (`next dev`, `next start`, and the standalone
 * server the Dockerfile ships alike). It is the only place in this app that
 * gets to run code at boot rather than per request.
 *
 * It does **not** run during `next build`, and that is a framework guarantee
 * rather than something this file arranges: `registerInstrumentation()` in
 * node_modules/next/dist/server/lib/router-utils/instrumentation-globals.external.js
 * returns early when `process.env.NEXT_PHASE === "phase-production-build"`,
 * which `next build` sets before it compiles anything. That matters here
 * because the bootstrap opens SQLite, and `data/` does not exist until
 * docker-entrypoint.sh applies the migrations at container start -- a build
 * that ran this would create an empty, unmigrated database on the build
 * machine. Verified against next@16.2.12; if a future Next drops that guard,
 * this file needs its own `NEXT_PHASE` check.
 *
 * Errors are deliberately **not** swallowed, and it is worth knowing exactly
 * what that looks like, because it was measured rather than assumed: Next wraps
 * the throw as "An error occurred while loading instrumentation hook", logs
 * `Failed to prepare server` plus an unhandled rejection, keeps the process
 * alive, and answers 500 to every route -- re-running (and re-failing) the
 * preparation on each request. Loud and unusable, in other words, which is the
 * honest outcome for a database that cannot be reached or was never migrated:
 * /health fails too, so a container healthcheck sees it. The one failure that
 * must *not* reach here -- a second concurrent bootstrap losing the
 * `users.email` unique race -- is absorbed inside `ensureAdminExists()` itself.
 */
export async function register(): Promise<void> {
  // Node runtime only: the edge runtime has no better-sqlite3, and importing
  // the bootstrap there would fail at module resolution rather than at a query.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Imported dynamically, inside the guard: a static import would pull
  // better-sqlite3 into the edge bundle too.
  const { ensureAdminExists } = await import("@/lib/auth/bootstrap");
  await ensureAdminExists();
}
