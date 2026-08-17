import { connection } from "next/server";

import { AdvancedSection } from "@/components/ai/advanced-section";
import { AiTitle } from "@/components/ai/ai-title";
import { ProviderSection } from "@/components/ai/provider-section";
import { getAiStatus } from "@/lib/ai/queries";

/**
 * The instant-render-no-fallback migration (see
 * `src/app/(app)/settings/page.tsx`): this page body awaits nothing, so it
 * cannot suspend and `loading.tsx` -- deleted along with this rewrite -- is
 * unreachable.
 *
 * `await getTranslations()` is gone, replaced by `<AiTitle>` -- a client
 * component reading `useTranslations("ai")` off the `NextIntlClientProvider`
 * the root layout already renders, so nothing crosses the RSC boundary for
 * the heading/description and nothing here suspends on it. See
 * `SettingsTitle`'s own comment for why the namespace is a literal rather
 * than a generic prop.
 */
export default function AiPage() {
  /**
   * Opt this route out of prerendering -- **called, not awaited**, exactly as
   * `SettingsPage` does and for the same reason: `getAiStatus()` below is
   * never awaited by this page body (it is handed straight to both client
   * sections), so there is no other awaited Dynamic API left here to do this
   * job. See CLAUDE.md's `connection()` bullet for why calling it, unawaited,
   * is enough today -- and the `cacheComponents` precondition that fact
   * rests on.
   */
  connection();

  // Not awaited: handed to both sections below, whose real controls render
  // immediately and fill in the values once it resolves -- awaiting here is
  // what used to make the whole page suspend behind one read.
  // `getAiStatus()` reads the same `cache()`d `getSettings()` row the root
  // layout already read for this request, so sharing this one promise
  // between both sections still costs exactly one query.
  const status = getAiStatus();

  return (
    <div className="max-w-2xl space-y-6">
      <AiTitle />
      <div className="space-y-6">
        <ProviderSection promise={status} />
        <AdvancedSection promise={status} />
      </div>
    </div>
  );
}
