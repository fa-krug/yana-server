import { connection } from "next/server";

import { AccountTitle } from "@/components/account/account-title";
import { DeviceSection } from "@/components/account/device-section";
import { PasskeySection } from "@/components/account/passkey-section";
import { PasswordSection } from "@/components/account/password-section";
import { ProfileSection } from "@/components/account/profile-section";
import { getAccountOverview } from "@/lib/account/queries";

/**
 * The instant-render-no-fallback migration (see
 * `src/app/(app)/settings/page.tsx`): this page body awaits nothing, so it
 * cannot suspend and `loading.tsx` -- deleted along with this rewrite -- is
 * unreachable.
 *
 * `await getTranslations()` is gone, replaced by `<AccountTitle>` -- a client
 * component reading `useTranslations("account")` off the
 * `NextIntlClientProvider` the root layout already renders, so nothing
 * crosses the RSC boundary for the title and nothing here suspends on it. See
 * `SettingsTitle`'s own comment for why the namespace is a literal rather
 * than a generic prop.
 */
export default function AccountPage() {
  /**
   * Opt this route out of prerendering -- **called, not awaited**, exactly as
   * `SettingsPage` does and for the same reason: `getAccountOverview()` below
   * is never awaited by this page body (it is handed straight to the four
   * client sections), so there is no other awaited Dynamic API left here to
   * do this job. `connection()` throws synchronously during `next build`'s
   * static generation pass regardless of whether anything awaits its result,
   * which is what still keeps `rm -rf data/ && npm run build` from baking
   * this page against an unmigrated `data/`.
   */
  connection();

  // Not awaited: the promise is handed to all four client components, which
  // render their real controls immediately and fill in the values when it
  // resolves. Awaiting here is what made the whole page suspend behind one
  // read. Passing the same promise to all four is still exactly one call to
  // getAccountOverview() -- it is the one Promise object that is shared, not
  // four separate invocations.
  const overview = getAccountOverview();

  return (
    <div className="max-w-2xl space-y-6">
      <AccountTitle />
      <div className="space-y-6">
        <ProfileSection promise={overview} />
        <PasswordSection promise={overview} />
        <PasskeySection promise={overview} />
        <DeviceSection promise={overview} />
      </div>
    </div>
  );
}
