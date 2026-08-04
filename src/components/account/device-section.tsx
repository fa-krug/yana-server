"use client";

import { Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { removeDevice } from "@/lib/account/actions";
import { attempt } from "@/lib/account/result";
import type { DeviceSummary } from "@/lib/account/queries";

/**
 * List and revoke device sessions paired with the API (see `listDevices()` in
 * `@/lib/account/queries` and phase 13's device-pairing route).
 *
 * **No delete guard here the way `PasskeySection` has one, and no confirmation
 * dialog either.** Revoking every device only means re-pairing: the browser's
 * own cookie session is a separate, unmarked session that `listDevices()`
 * never lists, so there is no lockout to guard against and nothing
 * irreversible to confirm -- unlike deleting the last passkey, which can leave
 * an account with no way back in at all.
 *
 * `removeDevice()`'s doc comment notes that Better Auth's `revokeSession`
 * silently no-ops on a token that is not the caller's, rather than throwing --
 * so `ok: true` here does not by itself prove the row was deleted. That does
 * not matter for this UI: every token passed to `revoke()` came from the
 * `devices` prop this component was just rendered with, which is this same
 * user's own `getAccountOverview()` read, so the mismatch this note warns
 * about cannot arise from normal use of this card.
 */
export function DeviceSection({ devices }: { devices: DeviceSummary[] }) {
  const t = useTranslations("account");
  const format = useFormatter();
  const router = useRouter();
  const [pending, start] = useTransition();

  function revoke(token: string) {
    start(async () => {
      // attempt(), never a bare await. See @/lib/account/result.
      const result = await attempt(() => removeDevice({ token }));
      if (result.ok) {
        toast.success(t("devices.revoked"));
        router.refresh();
        return;
      }
      toast.error(result.errorKey ? t(result.errorKey) : t("devices.revokeFailed"));
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("devices.title")}</CardTitle>
        <CardDescription>{t("devices.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("devices.empty")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {devices.map((device) => (
              <li key={device.token} className="flex items-center gap-3 p-3">
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
                  onClick={() => revoke(device.token)}
                >
                  {t("devices.revoke")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
