import { getTranslations } from "next-intl/server";

import { DeviceSectionShell } from "@/components/account/device-section";
import { PasskeySectionShell } from "@/components/account/passkey-section";
import { PasswordSectionShell } from "@/components/account/password-section";
import { ProfileSectionShell } from "@/components/account/profile-section";
import { CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically. Without this file, an
 * initial navigation to `/account` shows that unrelated fallback for however
 * long `AccountPage` takes to resolve, because the whole async page function
 * (including its own inline `<Suspense fallback={<SectionsFallback />}>`)
 * suspends as one unit until it returns. This hoists `AccountPage`'s own
 * "nothing loaded yet" shell -- the same shape `ffa29204` introduced as
 * `SectionsFallback` for later re-fetches -- up to the route level so it is
 * shown on the very first navigation too.
 *
 * `<ProfileSectionShell>` takes its default no-op `onSubmit` rather than
 * being handed one: this is a Server Component, and a closure it creates
 * cannot cross into a Client Component. See the fallback's doc comment in
 * `./page.tsx`.
 */
export default async function Loading() {
  const t = await getTranslations("account");

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
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
    </div>
  );
}
