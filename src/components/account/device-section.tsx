"use client";

import { Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { Suspense, use, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { removeDevice } from "@/lib/account/actions";
import { attempt } from "@/lib/account/result";
import type { AccountOverview, DeviceSummary } from "@/lib/account/queries";

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
 *
 * **`devices === undefined` (paired with `pending`) is the "not loaded yet"
 * state, and it is the one spot in this card a `<Skeleton>` still belongs**:
 * the number of paired devices is genuinely unknowable, unlike a field's
 * value, so there is no real control to show in its place. The card's heading
 * and description need no data at all and render for real either way.
 */
export function DeviceSectionForm({
  devices,
  pending = false,
}: {
  devices?: DeviceSummary[];
  pending?: boolean;
}) {
  const t = useTranslations("account");
  const format = useFormatter();
  const router = useRouter();
  const [saving, start] = useTransition();

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

  const disabled = pending || saving;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("devices.title")}</CardTitle>
        <CardDescription>{t("devices.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {devices === undefined ? (
          // The pending list: the row count is genuinely unknowable, unlike a
          // field's value, so this is the one place in this card a <Skeleton>
          // is still the right affordance. Do not "fix" this into a real
          // control -- there is no data to render one against yet.
          <Skeleton className="h-16 w-full" />
        ) : devices.length === 0 ? (
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
                  disabled={disabled}
                  onClick={() => revoke(device.id)}
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

/** Calls use(); suspends until the promise resolves; renders the form for real. */
function DeviceSectionResolved({ promise }: { promise: Promise<AccountOverview> }) {
  const { devices } = use(promise);
  return <DeviceSectionForm devices={devices} />;
}

/**
 * What the page renders. The fallback is the real form, in its pending
 * state -- see the Design Reference in
 * docs/superpowers/plans/2026-08-16-streaming-controls-migration.md -- so the
 * heading is on screen from the first frame; only the list -- the one spot a
 * `<Skeleton>` is still correct -- streams in afterward.
 */
export function DeviceSection({ promise }: { promise: Promise<AccountOverview> }) {
  return (
    <Suspense fallback={<DeviceSectionForm pending />}>
      <DeviceSectionResolved promise={promise} />
    </Suspense>
  );
}
