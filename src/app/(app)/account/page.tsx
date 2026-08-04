import { connection } from "next/server";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { DeviceSection } from "@/components/account/device-section";
import { PasskeySection } from "@/components/account/passkey-section";
import { PasswordSection } from "@/components/account/password-section";
import { ProfileSection } from "@/components/account/profile-section";
import { CardSkeletonGroup } from "@/components/data-skeleton";
import { getAccountOverview } from "@/lib/account/queries";

/**
 * The data region. Async, inside the `<Suspense>` below, with the (app) group's
 * `error.tsx` above it -- the streaming pattern CLAUDE.md describes. The error
 * boundary is not optional here: once the shell has flushed, the response is
 * already a 200 and a throw with nothing to catch it just truncates the stream.
 *
 * Untested by design: testing-library cannot render an async server component,
 * and the fix for that is not to reshape this into something it can render.
 * What the three cards *do* is covered by their own `.tsx` tests, and what
 * `getAccountOverview()` returns is covered against a real database.
 */
async function Sections() {
  const { user, passkeys, devices, hasPassword } = await getAccountOverview();

  return (
    <div className="space-y-6">
      {/* Five named columns, not the `User` row -- the same rule the (app)
          layout applies to the sidebar footer, and for the same reason: the
          row also carries `role`, the three ban columns, `emailVerified` and
          the timestamps, and passing it whole serializes all of them into the
          RSC payload for no purpose. Own-row data, so nothing crosses between
          users; it is still more than the card renders. */}
      <ProfileSection
        user={{
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          image: user.image,
        }}
      />
      <PasswordSection hasPassword={hasPassword} />
      <PasskeySection passkeys={passkeys} hasPassword={hasPassword} />
      <DeviceSection devices={devices} />
    </div>
  );
}

export default async function AccountPage() {
  /**
   * Opt out of prerendering before anything can reach SQLite -- every route
   * that can needs its own call, first thing. `getTranslations()` below already
   * resolves the next-intl request config, which reads `getSettings()`, which
   * opens the database; without this, `next build` bakes this page against a
   * `data/` directory that does not exist until the server's own startup hook
   * migrates one.
   */
  await connection();
  const t = await getTranslations("account");

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <Suspense fallback={<CardSkeletonGroup count={4} />}>
        <Sections />
      </Suspense>
    </div>
  );
}
