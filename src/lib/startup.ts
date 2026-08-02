import { ensureAdminExists } from "@/lib/auth/bootstrap";
import { applyPendingMigrations } from "@/lib/db/migrate";
import { startScheduler } from "@/lib/jobs/scheduler";
import { startWorker } from "@/lib/jobs/worker";

/**
 * Everything that has to happen once, before the first request is served.
 *
 * `src/instrumentation.ts` is the only caller, and it reaches this module
 * through a single dynamic `import()` for a bundler reason worth knowing:
 * webpack compiles the instrumentation hook for the **edge** runtime too and
 * resolves its imports statically, so anything reachable from there drags
 * `node:fs` and `better-sqlite3` into a runtime that has neither. `next.config.
 * ts` cuts exactly this specifier out of the edge compilation -- which is why
 * the startup sequence lives behind **one** module boundary instead of being
 * two imports in the hook. Adding another startup step here costs nothing;
 * adding another import to `instrumentation.ts` breaks `next dev`.
 *
 * **Order is load-bearing.** Migrations first: `ensureAdminExists()` queries
 * `users`, which does not exist on a fresh database until they run.
 *
 * Worker & Scheduler startup: after migrations and admin bootstrap, the worker
 * loop and scheduler tick start.
 */
export async function runStartupTasks(): Promise<void> {
  applyPendingMigrations();
  await ensureAdminExists();
  startWorker();
  startScheduler();
}
