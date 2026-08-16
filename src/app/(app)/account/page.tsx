import { connection } from "next/server";
import { getTranslations } from "next-intl/server";

import { DeviceSection } from "@/components/account/device-section";
import { PasskeySection } from "@/components/account/passkey-section";
import { PasswordSection } from "@/components/account/password-section";
import { ProfileSection } from "@/components/account/profile-section";
import { getAccountOverview } from "@/lib/account/queries";

/**
 * `await getTranslations()` stays in the page body for the same reason
 * `SettingsPage`'s doc comment gives: a generic `<PageTitle>` cannot stay
 * compiler-checked against `NamespaceKey<Namespace>` without a cast at the
 * `t()` call site, which CLAUDE.md forbids. This page suspends only on that
 * one per-request-`cache()`d read, never on `getAccountOverview()` below --
 * which is the read this migration takes off the critical path.
 */
export default async function AccountPage() {
  /**
   * Opt this route out of prerendering, **before** the first line that can
   * reach SQLite. `connection()` in the root layout is not enough -- see the
   * `connection()` bullet in CLAUDE.md: the layout and this page are sibling
   * render scopes, and `getTranslations()` below already resolves the
   * next-intl request config -> `getSettings()` -> `getDb()`.
   */
  await connection();
  const t = await getTranslations("account");

  // Not awaited: the promise is handed to all four client components, which
  // render their real controls immediately and fill in the values when it
  // resolves. Awaiting here is what made the whole page suspend behind one
  // read. Passing the same promise to all four is still exactly one call to
  // getAccountOverview() -- it is the one Promise object that is shared, not
  // four separate invocations.
  const overview = getAccountOverview();

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <div className="space-y-6">
        <ProfileSection promise={overview} />
        <PasswordSection promise={overview} />
        <PasskeySection promise={overview} />
        <DeviceSection promise={overview} />
      </div>
    </div>
  );
}
