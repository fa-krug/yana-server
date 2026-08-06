import dns from "node:dns";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAdminExists } from "@/lib/auth/bootstrap";
import { applyPendingMigrations } from "@/lib/db/migrate";
import { startScheduler } from "@/lib/jobs/scheduler";
import { startWorker } from "@/lib/jobs/worker";

/**
 * Resolves the directory where Yana stores SQLite database files and media.
 * Precedence: explicit argument > YANA_DATA_DIR env > ~/.yana
 */
export function resolveDataDir(explicit?: string): string {
  const envDir = process.env.YANA_DATA_DIR?.trim();
  const targetDir = explicit?.trim() || envDir || path.join(os.homedir(), ".yana");
  const resolvedPath = path.resolve(targetDir);
  fs.mkdirSync(resolvedPath, { recursive: true });
  return resolvedPath;
}

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
  /**
   * Node's default DNS result order is "verbatim" -- whatever the resolver
   * returns, AAAA first or not. Docker's default bridge network gives
   * containers no IPv6 route, so a dual-stack source whose AAAA record sorts
   * first makes every `fetch()` pay for a failed IPv6 connection attempt
   * before falling back to IPv4. Forcing IPv4 first removes that wasted
   * attempt everywhere in the process, including every aggregator's fetch.
   */
  dns.setDefaultResultOrder("ipv4first");

  applyPendingMigrations();
  await ensureAdminExists();
  startWorker();
  startScheduler();
}
