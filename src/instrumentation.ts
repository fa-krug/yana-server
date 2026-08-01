/**
 * Next's startup hook: `register()` runs **once per server instance**, before
 * the first request is served (`next dev`, `next start`, and the standalone
 * server the Dockerfile ships alike). It is the only place in this app that
 * gets to run code at boot rather than per request, and it owns both startup
 * tasks -- applying migrations and creating the default administrator, in that
 * order; see `src/lib/startup.ts`.
 *
 * **This is the single migration path.** It replaced the inline `node -e` in
 * docker-entrypoint.sh, which covered the container and nothing else: `npm run
 * dev` and a bare `npm start` had no migration step at all, so a fresh checkout
 * ran against an empty database until someone remembered `drizzle-kit`. One
 * call site now covers all three.
 *
 * It does **not** run during `next build`, and that is a framework guarantee
 * rather than something this file arranges: `registerInstrumentation()` in
 * node_modules/next/dist/server/lib/router-utils/instrumentation-globals.external.js
 * returns early when `process.env.NEXT_PHASE === "phase-production-build"`,
 * which `next build` sets before it compiles anything. That matters here
 * because both tasks open SQLite, and a build that ran them would create and
 * migrate a database on the build machine. Verified against next@16.2.12; if a
 * future Next drops that guard, this file needs its own `NEXT_PHASE` check.
 *
 * **A failed startup kills the process.** Deleting docker-entrypoint.sh dropped
 * a contract nobody had written down -- `set -e` plus `exit 1`, so a container
 * that could not migrate *died* -- and `process.exit(1)` restores it. What Next
 * does on its own is worse than it sounds: measured on 16.2.12 with a
 * deliberately unopenable `DATABASE_PATH`, the standalone production server logs
 * the failure and then **stays up answering 500 to every route**. Under compose
 * the `/health` check eventually marks that unhealthy, but a plain `docker run`
 * shows a *running* container serving nothing, and no restart policy fires.
 *
 * No `NODE_ENV` branch, and that is a measured decision rather than an omission:
 * `next dev` **already exits with code 1** when `register()` throws (same
 * experiment, dev server, exit code 1 and the port closed), so a "keep the dev
 * server alive" branch would be a comment describing behaviour that does not
 * exist. The exit is unconditional so the container path matches what dev does
 * anyway. Both log first.
 *
 * The one failure that must not reach here -- a second concurrent bootstrap
 * losing the `users.email` race -- is absorbed inside `ensureAdminExists()`.
 */
export async function register(): Promise<void> {
  // Node runtime only: the edge runtime has no better-sqlite3, and importing
  // the startup module there would fail at module resolution rather than at a
  // query.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // One dynamic import, one specifier -- `next.config.ts` cuts exactly this one
  // out of the edge compilation, because webpack follows it regardless of the
  // guard above. Do not add a second import to this file; add the step to
  // `runStartupTasks()` instead. `src/instrumentation.test.ts` fails if this
  // list ever stops matching the regexp in `next.config.ts`.
  const { runStartupTasks } = await import("@/lib/startup");

  try {
    await runStartupTasks();
  } catch (error) {
    // Logged before exiting: Next's own wrapper renames the message to "An
    // error occurred while loading instrumentation hook", and nothing would
    // print the original once the process is on its way out.
    console.error("Yana could not complete startup (migrations, admin bootstrap).", error);

    process.exit(1);

    // Unreachable in production. Kept so the failure is still a rejection under
    // a test (or any host) that stubs process.exit, rather than a silent
    // resolve that would make register() look like it succeeded.
    throw error;
  }
}
