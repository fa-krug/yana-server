import { getTranslations } from "next-intl/server";

import { DeviceSectionForm } from "@/components/account/device-section";
import { PasskeySectionForm } from "@/components/account/passkey-section";
import { PasswordSectionForm } from "@/components/account/password-section";
import { ProfileSectionForm } from "@/components/account/profile-section";

/**
 * This route's own fallback -- shown by Next while the RSC payload for a
 * **client-side soft navigation** into `/account` (e.g. clicking "Account" in
 * the sidebar footer) is still in flight over the network. That is real
 * latency server-side streaming cannot remove: `AccountPage`'s own client
 * components only help once the new route's payload has already arrived, and
 * `await getTranslations()` staying in the page body (see the fork recorded in
 * `AccountPage`'s doc comment) means the page still suspends briefly on that
 * per-request-cached read even server-side.
 *
 * It renders the **real form chassis in its pending state** -- the same
 * `…SectionForm` components `AccountPage`'s own `<Suspense fallback>`s use,
 * called with `pending` -- rather than `<Skeleton>` bars standing in for each
 * control. That is the whole point of this migration: the heading, both card
 * headings, every label, the avatar frame and every button are all on screen,
 * disabled, from the very first frame of the navigation, and only the values
 * (and the two list regions, whose row counts are genuinely unknowable) stream
 * in afterward -- no grey bars, and no visual swap once the real controls
 * mount.
 */
export default async function Loading() {
  const t = await getTranslations("account");

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <div className="space-y-6">
        <ProfileSectionForm pending />
        <PasswordSectionForm pending />
        <PasskeySectionForm pending />
        <DeviceSectionForm pending />
      </div>
    </div>
  );
}
