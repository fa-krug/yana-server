import { connection } from "next/server";

import { getDb } from "@/lib/db/client";

export async function GET() {
  // SELECT 1 succeeds even against an empty, freshly-created database, so a
  // prerendered response here would bake a permanent { status: "ok" } that
  // never touches the database again -- exactly what this check exists to
  // catch. connection() (the same primitive the root layout uses instead of
  // the legacy `dynamic = "force-dynamic"`, which Next 16 drops once Cache
  // Components is enabled) opts this route out of prerendering so every
  // request actually runs the query. Next's Route Handler docs list
  // connection() alongside cookies()/headers() as one of the calls that stop
  // prerendering in a GET handler, so it is legal here.
  await connection();
  try {
    // Prove the database is actually reachable, not just that Node is up.
    // `getDb().get()` (drizzle-orm's raw-SQL escape hatch, distinct from
    // `$client`) runs this without reaching for the `$client` handle that
    // client.ts documents as coupled to a single call site (writeTransaction);
    // it also keeps this read off the type-unsafe `$client` cast the brief
    // used, which does not typecheck against this repo's drizzle-orm version.
    getDb().get("SELECT 1");
    return Response.json({ status: "ok" });
  } catch (error) {
    // Logged, not returned. This is the only unauthenticated route in the app,
    // and the failure messages available here are exactly the ones worth not
    // publishing: getDb() starts with fs.mkdirSync(), whose EACCES message
    // carries an absolute server path ("mkdir '/app/data'"), and
    // better-sqlite3's own errors disclose driver internals. The operator gets
    // the detail from the container log; the caller gets the status only.
    console.error("Health check failed: the database is not reachable", error);
    return Response.json({ status: "error" }, { status: 503 });
  }
}
