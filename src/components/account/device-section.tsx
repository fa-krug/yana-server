"use client";

import { Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { removeDevice } from "@/lib/account/actions";
import { attempt } from "@/lib/account/result";
import type { DeviceSummary } from "@/lib/account/queries";

/**
 * List and revoke device sessions paired with the API (see `listDevices()` in
 * `@/lib/account/queries` and the device-pairing route from the client-API
 * plan's task 9).
 *
 * **No delete guard here the way `PasskeySection` has one, and no confirmation
 * dialog either.** Revoking every device only means re-pairing: the browser's
 * own cookie session is a separate, unmarked session that `listDevices()`
 * never lists, so there is no lockout to guard against and nothing
 * irreversible to confirm -- unlike deleting the last passkey, which can leave
 * an account with no way back in at all.
 *
 * **`devices` carries each session's `id`, never its `token`.** The token is a
 * live, durable Bearer credential valid for up to 30 days; `DeviceSummary`
 * (`@/lib/account/queries`) omits it precisely because this component's props
 * are serialized into `/account`'s RSC payload. `removeDevice()` resolves the
 * real token server-side, scoped to the caller's own userId, only when a
 * revoke actually happens.
 *
 * `removeDevice()`'s doc comment notes that Better Auth's `revokeSession`
 * silently no-ops on a token that is not the caller's, rather than throwing --
 * so `ok: true` here does not by itself prove the row was deleted. That does
 * not matter for this UI: every id passed to `revoke()` came from the
 * `devices` prop this component was just rendered with, which is this same
 * user's own `getAccountOverview()` read, so the mismatch this note warns
 * about cannot arise from normal use of this card.
 */
export function DeviceSection({ devices }: { devices: DeviceSummary[] }) {
  const t = useTranslations("account");
  const format = useFormatter();
  const router = useRouter();
  const [pending, start] = useTransition();

  function revoke(id: string) {
    start(async () => {
      // attempt(), never a bare await. See @/lib/account/result.
      const result = await attempt(() => removeDevice({ id }));
      if (result.ok) {
        toast.success(t("devices.revoked"));
        router.refresh();
        return;
      }
      toast.error(result.errorKey ? t(result.errorKey) : t("devices.revokeFailed"));
    });
  }

  return (
    <DeviceSectionShell
      listControl={
        devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("devices.empty")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {devices.map((device) => (
              <li key={device.id} className="flex items-center gap-3 p-3">
                <Smartphone aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{device.deviceName}</p>
                  <p className="text-sm text-muted-foreground">
                    {t("devices.pairedOn", {
                      // Through next-intl's formatter, so the date is written
                      // the way the resolved locale writes dates rather than
                      // the way the server's ICU default does.
                      date: format.dateTime(device.createdAt, { dateStyle: "medium" }),
                    })}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => revoke(device.id)}
                >
                  {t("devices.revoke")}
                </Button>
              </li>
            ))}
          </ul>
        )
      }
    />
  );
}

/**
 * The section's chrome alone: the card heading, with no dependency on
 * `devices` -- see the doc comment on `GeneralSectionShell` in
 * `../settings/general-section.tsx` for why `account/page.tsx` renders this
 * directly as its own `<Suspense>` fallback (with a skeleton standing in for
 * the list). One slot, because the list's shape -- an empty message or rows
 * each with their own revoke button -- depends on `devices` all the way
 * through; there is no static chrome left inside it to split out.
 */
export function DeviceSectionShell({ listControl }: { listControl: ReactNode }) {
  const t = useTranslations("account");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("devices.title")}</CardTitle>
        <CardDescription>{t("devices.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">{listControl}</CardContent>
    </Card>
  );
}
