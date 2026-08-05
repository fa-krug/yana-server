import { and, count, eq, gte, lt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import { aiRequests } from "@/lib/db/schema";
import type * as schema from "@/lib/db/schema";

export type AiUsageOutcome = "ok" | "dailyLimitExceeded" | "monthlyLimitExceeded";

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Checked and recorded atomically -- the caller must run this inside its own
 * `writeTransaction()` (`BEGIN IMMEDIATE`), the same ordering guarantee
 * `setActiveProvider()` in `src/lib/ai/actions.ts` relies on, so two
 * concurrent calls from the same user cannot both read "one under the
 * limit" and both proceed.
 *
 * Usage is recorded for every attempted call the caller lets through here,
 * not only successful ones -- see the doc comment on `aiRequests`
 * (`src/lib/db/schema/ai.ts`) for why.
 *
 * Reset windows are calendar UTC day/month, not a rolling window --
 * simplest to reason about, and consistent with this repo's `timeZone:
 * "UTC"` convention for server-side date handling.
 */
export function checkAndRecordAiUsage(
  tx: BetterSQLite3Database<typeof schema>,
  userId: string,
  dailyLimit: number,
  monthlyLimit: number,
  now: Date = new Date(),
): AiUsageOutcome {
  const dayStart = startOfUtcDay(now);
  const monthStart = startOfUtcMonth(now);

  // Bounds table growth: nothing after this point needs a row older than
  // the start of the current month, since the daily window is a subset of
  // the monthly one.
  tx.delete(aiRequests)
    .where(and(eq(aiRequests.userId, userId), lt(aiRequests.createdAt, monthStart)))
    .run();

  // Monthly is checked before daily. When both limits are already exhausted
  // at once, the caller gets `monthlyLimitExceeded` -- "try again next
  // month" -- rather than `dailyLimitExceeded`'s "try again tomorrow", which
  // would be true of the daily window alone but misleading advice given the
  // wider constraint. Checking order changes only which reason is reported
  // in that simultaneous case; either limit alone still blocks the call.
  const monthlyCount =
    tx
      .select({ value: count() })
      .from(aiRequests)
      .where(and(eq(aiRequests.userId, userId), gte(aiRequests.createdAt, monthStart)))
      .get()?.value ?? 0;
  if (monthlyCount >= monthlyLimit) return "monthlyLimitExceeded";

  const dailyCount =
    tx
      .select({ value: count() })
      .from(aiRequests)
      .where(and(eq(aiRequests.userId, userId), gte(aiRequests.createdAt, dayStart)))
      .get()?.value ?? 0;
  if (dailyCount >= dailyLimit) return "dailyLimitExceeded";

  tx.insert(aiRequests).values({ userId, createdAt: now }).run();
  return "ok";
}
