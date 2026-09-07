"use client";

import { useTranslations } from "next-intl";
import { Suspense, use, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePassword } from "@/lib/account/actions";
import { attempt } from "@/lib/account/result";
import type { AccountOverview } from "@/lib/account/queries";

/**
 * Better Auth's own minimum, restated for the client-side hint. The server is
 * still the authority -- `MIN_PASSWORD_LENGTH` in `@/lib/account/actions`
 * rejects a short password whatever this input says -- so this is a `minLength`
 * that saves a round trip, not a check.
 */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Change the password.
 *
 * `hasPassword` is false for an account provisioned with passkeys only, which
 * phase 5's admin user creation will be able to produce. There is nothing to
 * change in that case and no "set a password" flow in this phase, so the card
 * says so rather than offering a form whose every submission would come back
 * `CREDENTIAL_ACCOUNT_NOT_FOUND`.
 *
 * **The confirmation is compared here, before the round trip.** It is the one
 * validation the server cannot do -- the second field is never sent -- and
 * catching it locally means a typo does not spend the user's current password
 * on a request that was always going to fail.
 *
 * `hasPassword === undefined` (paired with `pending`) is the "not loaded yet"
 * state, and it defaults to `true` -- the same choice the shell it replaces
 * made for its `<Suspense>` fallback: a password credential is the common
 * case, so the real three-field form is what renders (disabled), rather than
 * betting on the passkey-only branch and showing nothing.
 */
export function PasswordSectionForm({
  hasPassword = true,
  pending = false,
}: {
  hasPassword?: boolean;
  pending?: boolean;
}) {
  const t = useTranslations("account");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, start] = useTransition();

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (next !== confirm) {
      toast.error(t("password.mismatch"));
      return;
    }

    start(async () => {
      // attempt(), never a bare await -- a rejected action would take the page
      // to the error boundary with three filled password fields on it. See
      // @/lib/account/result.
      const result = await attempt(() =>
        changePassword({ currentPassword: current, newPassword: next }),
      );
      if (result.ok) {
        // Cleared only on success: a wrong *current* password should leave the
        // new one typed, so the retry is one field and not three.
        setCurrent("");
        setNext("");
        setConfirm("");
        toast.success(t("password.changed"));
        return;
      }
      // `min` is passed unconditionally: `password.tooShort` interpolates it
      // and the other keys ignore it, which is cheaper than a per-key table.
      toast.error(
        result.errorKey ? t(result.errorKey, { min: MIN_PASSWORD_LENGTH }) : t("saveFailed"),
      );
    });
  }

  const disabled = pending || saving;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("password.title")}</CardTitle>
        <CardDescription>
          {hasPassword ? t("password.description") : t("password.none")}
        </CardDescription>
      </CardHeader>
      {hasPassword ? (
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            {/* autoComplete matters here: without current-password /
                new-password a password manager neither fills the first field
                nor offers to store the new one, and on a self-hosted install
                the manager is most people's only copy. */}
            <div className="grid gap-2">
              <Label htmlFor="current-password">{t("password.current")}</Label>
              <Input
                id="current-password"
                type="password"
                required
                autoComplete="current-password"
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
                disabled={disabled}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-password">{t("password.new")}</Label>
              <Input
                id="new-password"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
                value={next}
                onChange={(event) => setNext(event.target.value)}
                disabled={disabled}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="confirm-password">{t("password.confirm")}</Label>
              <Input
                id="confirm-password"
                type="password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                autoComplete="new-password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                disabled={disabled}
              />
            </div>
            <Button type="submit" disabled={disabled}>
              {saving ? t("password.changing") : t("password.submit")}
            </Button>
          </form>
        </CardContent>
      ) : null}
    </Card>
  );
}

/** Calls use(); suspends until the promise resolves; renders the form for real. */
function PasswordSectionResolved({ promise }: { promise: Promise<AccountOverview> }) {
  const { hasPassword } = use(promise);
  return <PasswordSectionForm hasPassword={hasPassword} />;
}

/**
 * What the page renders. The fallback is the real form, in its pending
 * state -- see the Design Reference in
 * docs/superpowers/plans/2026-08-16-streaming-controls-migration.md -- so the
 * heading and all three field labels are on screen from the first frame and
 * only the values stream in afterward.
 */
export function PasswordSection({ promise }: { promise: Promise<AccountOverview> }) {
  return (
    <Suspense fallback={<PasswordSectionForm pending />}>
      <PasswordSectionResolved promise={promise} />
    </Suspense>
  );
}
