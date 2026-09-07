import type { UserSettings } from "@/lib/db/schema";
import { activeProvider } from "@/lib/ai/queries";
import { wantsAi } from "@/lib/ai/run";

/**
 * The one place "can this feed's AI options actually run right now" is
 * decided.
 *
 * - `"notNeeded"` -- the feed asks for no AI processing at all
 *   ({@link wantsAi} is false), so readiness is moot.
 * - `"ok"` -- AI is wanted and a provider will actually answer for it.
 * - `"noProvider"` -- AI is wanted, but no working provider is configured.
 *   Enqueueing aggregation in this state is the bug this module exists to
 *   prevent: `applyAiToBlocks()` (`./run`) would return
 *   `{ status: "failed", reason: "noProvider" }` for *every* article, and
 *   `handleAggregateJob` treats that as transient -- skip, retry next run --
 *   which for a permanent misconfiguration means every article ages out of
 *   the feed's window and is lost for good, on a job that reports success.
 *
 * **Reuses two existing predicates rather than writing a third "is AI on"
 * check.** `wantsAi()` (`./run`) already carries a doc comment recording that
 * it was duplicated once before and the copies silently disagreed -- do not
 * repeat that here. `activeProvider()` (`./columns`, re-exported from
 * `./queries`) is the version that requires the provider's own probe-derived
 * `*Enabled` flag to agree with the stored `activeAiProvider` preference --
 * `AIClient` (`./run`) routes through the identical function now too, so a
 * provider some other, unverified process pointed the preference at without
 * ever confirming it can answer is refused consistently everywhere, not just
 * here -- see `AiStatus.active`'s doc comment in `./queries` for why that
 * distinction matters.
 *
 * Consumed by every path that enqueues aggregation for a feed: the scheduler
 * (`@/lib/jobs/scheduler`), the feed dashboard's bulk/single update action
 * (`updateFeedsBulk` in `@/lib/feeds/actions`), and the feeds list UI, so a
 * misconfigured feed is refused consistently rather than each caller
 * re-deriving its own answer.
 */
export type AiReadiness = "ok" | "noProvider" | "notNeeded";

export function aiReadinessFor(
  feedOptions: Record<string, unknown> | null | undefined,
  settings: UserSettings | null | undefined,
): AiReadiness {
  if (!wantsAi(feedOptions)) return "notNeeded";
  if (settings && activeProvider(settings)) return "ok";
  return "noProvider";
}
