"use client";

import { useEffect, useState } from "react";

import { attemptCall } from "@/lib/attempt";
import { userImpact } from "@/lib/users/actions";

/** What deleting a set of users would take with it. */
export type UserImpact = { feeds: number; tags: number; articles: number };

/**
 * The cascade counts for a selection, or `null` while they are unknown.
 *
 * **Why this is fetched ahead of the click rather than during it.** The counts
 * exist to be *read before* the operator confirms -- "this also removes 402
 * articles" is the entire reason the confirmation is there -- and
 * `<ConfirmDestructive>` takes its description as a plain string prop, rendered
 * before the dialog opens. The plan's wording ("its `run` calls `userImpact`
 * first") would put the read *after* the confirm button, where it could no
 * longer inform it. So the selection drives the read, and the dialog reads
 * whatever has arrived.
 *
 * **`null` is a real state and callers must render it**, never zeros: a
 * confirmation claiming "0 articles" while the count is still in flight is
 * worse than one that declines to give a number. Both call sites pair a
 * `…Description` key with a `…DescriptionPending` one for exactly that.
 *
 * Three details:
 *
 * - **The dependency is the joined key, not the array.** A fresh `string[]` on
 *   every render would re-run the effect forever; `ids.join(",")` is stable for
 *   an unchanged selection. The ids are recovered by splitting it, so nothing
 *   reads a value the dependency list does not name.
 * - **The key is stored beside the counts**, and stale counts are withheld. On
 *   the way from one selection to another the previous answer is not merely old
 *   -- it is the answer to a different question, and showing it would name
 *   numbers belonging to accounts that are no longer selected.
 * - **`attemptCall`, not `attempt`.** `userImpact()` returns bare counts rather
 *   than the `{ ok, errorKey }` shape `attempt()` is typed for, but it is still
 *   a server action and still may never return -- and an unhandled rejection
 *   here would escalate to the (app) error boundary and replace the page. A
 *   rejection leaves the counts unknown, which the pending copy already covers.
 */
export function useUserImpact(ids: string[]): UserImpact | null {
  const key = ids.join(",");
  const [loaded, setLoaded] = useState<{ key: string; impact: UserImpact } | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;

    void (async () => {
      const attempted = await attemptCall(() => userImpact(key.split(",")), {
        label: "Could not read what deleting these users would remove",
      });
      // An unmounted component -- or one whose selection moved on -- must not
      // set state; the guard covers the first, the stored key the second.
      if (!cancelled && attempted.status === "returned") {
        setLoaded({ key, impact: attempted.result });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [key]);

  return loaded && loaded.key === key ? loaded.impact : null;
}
