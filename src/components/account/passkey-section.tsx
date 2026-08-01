"use client";

import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { removePasskey } from "@/lib/account/actions";
import { attempt } from "@/lib/account/result";
import type { PasskeySummary } from "@/lib/account/queries";
import { authClient } from "@/lib/auth/client";
import {
  PASSKEY_ALREADY_REGISTERED_CODE,
  passkeyErrorKey,
  type SignInError,
} from "@/lib/auth/sign-in-errors";

/**
 * Register, list and remove passkeys.
 *
 * **Registration is a browser ceremony, so it cannot be a server action.**
 * `authClient.passkey.addPasskey()` calls `navigator.credentials.create()`,
 * which only exists in the browser and only resolves after the user has
 * approved with a fingerprint, face or device PIN. The server sees it as two
 * ordinary `/api/auth/passkey/*` requests. `router.refresh()` afterwards is
 * what re-renders the server component that lists them; there is no action
 * return value to carry a `revalidatePath()`.
 *
 * **The delete guard is enforced in the server action, not here.** This card
 * only decides whether to *offer* the button, so a stale render, a second tab
 * or a hand-made action call still cannot strip an account of its last
 * credential -- see `removePasskey()` in `@/lib/account/actions`.
 */
export function PasskeySection({
  passkeys,
  hasPassword,
}: {
  passkeys: PasskeySummary[];
  hasPassword: boolean;
}) {
  const t = useTranslations("account");
  const tCommon = useTranslations("common");
  const format = useFormatter();
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [pending, start] = useTransition();
  /**
   * Which passkey's confirmation is open, if any.
   *
   * The dialog is controlled rather than left to its trigger because
   * `AlertDialogAction` is a plain `<Button>` in this component library, not
   * Base UI's `Close` -- so confirming would run the delete and leave the
   * dialog standing over the list it just changed.
   */
  const [confirming, setConfirming] = useState<string | null>(null);

  /**
   * Would removing this passkey leave the account unreachable?
   *
   * True only for the last one on an account with no password credential: no
   * self-registration, no mail transport and therefore no recovery path exist
   * here, so the way back in would be editing SQLite by hand.
   */
  const lastResort = (id: string) => !hasPassword && passkeys.length === 1 && passkeys[0].id === id;

  async function add() {
    // Feature-detected the same way the login form does it: `PublicKeyCredential`
    // is absent in older browsers and in a number of embedded webviews, where
    // addPasskey() would reject somewhere inside the ceremony and leave a button
    // that appears to do nothing.
    if (typeof window === "undefined" || !("PublicKeyCredential" in window)) {
      toast.error(t("passkeys.unsupported"));
      return;
    }

    setAdding(true);
    try {
      // The whole call is wrapped, not just its result: `@better-fetch/fetch`
      // turns *HTTP* failures into `{ data, error }` but leaves its own
      // `await fetch(...)` unwrapped, so a network-level failure rejects. Same
      // trap the login form documents.
      const result = await authClient.passkey.addPasskey();
      // Read through the structural `SignInError`, the same shape
      // passkeyErrorKey() takes: the client's own return type is a union whose
      // `code` is present in some members and absent in others, so the field
      // is not reachable on the union itself.
      const error: SignInError | undefined = result?.error ?? undefined;
      if (error) {
        // Three outcomes, not two. "Already enrolled" is separated first
        // because passkeyErrorKey() prefix-matches every ERROR_* code into the
        // cancelled branch, which would tell someone nothing happened when in
        // fact the server refused a duplicate via excludeCredentials.
        if (error.code === PASSKEY_ALREADY_REGISTERED_CODE) {
          toast.error(t("passkeys.alreadyRegistered"));
          return;
        }
        // passkeyErrorKey() then maps a cancelled ceremony (or a device with
        // nothing to offer) away from a real failure; the two need different
        // words.
        const cancelled = passkeyErrorKey(error) === "passkeyUnavailable";
        toast.error(cancelled ? t("passkeys.addCancelled") : t("passkeys.addFailed"));
        return;
      }
      toast.success(t("passkeys.added"));
      router.refresh();
    } catch (error) {
      console.error("Passkey registration failed before it reached the server", error);
      toast.error(t("passkeys.addFailed"));
    } finally {
      setAdding(false);
    }
  }

  function remove(id: string) {
    start(async () => {
      // attempt(), never a bare await. See @/lib/account/result.
      const result = await attempt(() => removePasskey({ id }));
      if (result.ok) {
        toast.success(t("passkeys.removed"));
        return;
      }
      toast.error(result.errorKey ? t(result.errorKey) : t("passkeys.removeFailed"));
    });
  }

  const busy = adding || pending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("passkeys.title")}</CardTitle>
        <CardDescription>{t("passkeys.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {passkeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("passkeys.none")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {passkeys.map((passkey) => (
              <li key={passkey.id} className="flex items-center gap-3 p-3">
                <KeyRound aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {passkey.name?.trim() || t("passkeys.unnamed")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t("passkeys.created", {
                      // Through next-intl's formatter, so the date is written
                      // the way the resolved locale writes dates rather than
                      // the way the server's ICU default does.
                      date: format.dateTime(passkey.createdAt, { dateStyle: "medium" }),
                    })}
                  </p>
                </div>
                {lastResort(passkey.id) ? (
                  // No dialog to open: the action would refuse this anyway, and
                  // an explanation beats a confirmation that ends in an error.
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => toast.error(t("passkeys.lastOneNeedsPassword"))}
                  >
                    {t("passkeys.remove")}
                  </Button>
                ) : (
                  <AlertDialog
                    open={confirming === passkey.id}
                    onOpenChange={(open) => setConfirming(open ? passkey.id : null)}
                  >
                    {/* Base UI's `render`, never Radix's `asChild`. */}
                    <AlertDialogTrigger
                      disabled={busy}
                      render={<Button type="button" variant="ghost" size="sm" />}
                    >
                      {t("passkeys.remove")}
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t("passkeys.removeTitle")}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("passkeys.removeDescription")}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                        <AlertDialogAction
                          variant="destructive"
                          onClick={() => {
                            setConfirming(null);
                            remove(passkey.id);
                          }}
                        >
                          {t("passkeys.remove")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </li>
            ))}
          </ul>
        )}

        <Button type="button" onClick={add} disabled={busy}>
          <KeyRound aria-hidden="true" />
          {adding ? t("passkeys.adding") : t("passkeys.add")}
        </Button>
      </CardContent>
    </Card>
  );
}
