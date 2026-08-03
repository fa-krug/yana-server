import { attemptIn } from "@/lib/attempt";

/**
 * The `feeds` binding of `attempt()` (see `src/lib/attempt.ts`). The one
 * client-side call that needs it today is the identifier search in
 * `src/components/feeds/identifier-autocomplete.tsx` — `feed-form.tsx`'s own
 * `createFeed`/`updateFeed` calls predate this convention and are unchanged
 * by this feature.
 */
export const attempt = attemptIn("feeds", {
  sessionEnded: "sessionEnded",
  requestFailed: "requestFailed",
});
