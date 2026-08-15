import { connection } from "next/server";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { DeviceSection, DeviceSectionShell } from "@/components/account/device-section";
import { PasskeySection, PasskeySectionShell } from "@/components/account/passkey-section";
import { PasswordSection, PasswordSectionShell } from "@/components/account/password-section";
import { ProfileSection, ProfileSectionShell } from "@/components/account/profile-section";
import { CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getAccountOverview } from "@/lib/account/queries";

/**
 * The `<Suspense>` fallback for `<Sections>` below: the same four section
 * shells `<Sections>` itself renders once `getAccountOverview()` resolves,
 * with a skeleton standing in for each control -- so the headings, field
 * labels and help text never disappear behind an anonymous skeleton block,
 * only the values nobody can know yet. See the doc comment on
 * `SectionsFallback` in `../settings/page.tsx` for the reference version of
 * this pattern.
 *
 * `<ProfileSectionShell>` takes its default no-op `onSubmit`, deliberately
 * omitted rather than passed as a function value: this is a Server Component,
 * and a closure it creates cannot cross into a Client Component (it isn't a
 * Server Action) -- the shell defaults it itself instead.
 */
function SectionsFallback() {
  return (
    <div className="space-y-6">
      <ProfileSectionShell
        avatarControl={
          <div className="flex flex-wrap items-center gap-4">
            <Skeleton className="size-16 rounded-full" />
            <Skeleton className="h-9 w-28" />
          </div>
        }
        emailControl={<Skeleton className="h-9 w-full" />}
        firstNameControl={<Skeleton className="h-9 w-full" />}
        lastNameControl={<Skeleton className="h-9 w-full" />}
        saveControl={<Skeleton className="h-9 w-24" />}
      />
      <PasswordSectionShell
        description={<Skeleton className="h-4 w-64" />}
        formControl={
          <CardContent className="space-y-4">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-24" />
          </CardContent>
        }
      />
      <PasskeySectionShell
        listControl={<Skeleton className="h-16 w-full" />}
        addControl={<Skeleton className="h-9 w-32" />}
      />
      <DeviceSectionShell listControl={<Skeleton className="h-16 w-full" />} />
    </div>
  );
}

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
      <Suspense fallback={<SectionsFallback />}>
        <Sections />
      </Suspense>
    </div>
  );
}
