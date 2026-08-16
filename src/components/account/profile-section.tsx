"use client";

import { useTranslations } from "next-intl";
import { Suspense, use, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserAvatar } from "@/components/user-avatar";
import { removeAvatar, updateProfile, uploadAvatar } from "@/lib/account/actions";
import { attempt, type AccountKey, type AccountResult } from "@/lib/account/result";
import type { AccountOverview } from "@/lib/account/queries";
import {
  AVATAR_FOREGROUND,
  AVATAR_MAX_BYTES,
  AVATAR_MAX_MEGABYTES,
  AVATAR_MAX_MEGAPIXELS,
  AVATAR_SIZE,
  type AvatarUser,
  colourFor,
  initialsFor,
} from "@/lib/avatar";

/** What the card needs of a user row -- never the whole `User`. */
type ProfileUser = AvatarUser & { image: string | null };

/**
 * Name, address and picture.
 *
 * The picture lives in this card rather than one of its own because it is the
 * same record: one "who am I" section with two submit paths, which is also what
 * keeps the live preview next to the fields it belongs to.
 *
 * **The preview is a local object URL, and it has to be.** The stored avatar is
 * served from `/media/avatars/<id>`, a URL with no version token (deliberately
 * -- see the route handler), so re-uploading changes the bytes behind an
 * unchanged `src` and neither React nor the browser has any reason to fetch it
 * again. Showing the file the user just picked is both the immediate feedback
 * and the only honest way to prove the upload landed without inventing a
 * cache-buster that `safeAvatarSrc()` would then refuse.
 *
 * `user === undefined` (paired with `pending`) is the "not loaded yet" state:
 * the real card renders -- heading, help text, avatar frame, all three fields
 * and Save, all disabled -- rather than a `<Skeleton>` standing in for each of
 * them. Only the avatar picker (which needs the real id to derive a colour and
 * to compare against `safeAvatarSrc()`) has nothing to show but an empty frame
 * until then.
 */
export function ProfileSectionForm({
  user,
  pending = false,
}: {
  user?: ProfileUser;
  pending?: boolean;
}) {
  const t = useTranslations("account");
  const [email, setEmail] = useState(user?.email ?? "");
  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  const [saving, start] = useTransition();
  const [preview, setPreview] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * Object URLs are a document-lifetime allocation until revoked, so each one
   * is released when it is replaced and when this component goes away. The
   * effect depends on `preview` alone: the cleanup runs with the URL that was
   * current when it was created, which is exactly the one to revoke.
   */
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  /**
   * The catalog message for an action's `errorKey`, or the generic fallback --
   * never a zod or driver message. See `@/lib/account/actions`.
   *
   * The limits are interpolated unconditionally: `avatar.tooLarge` and
   * `avatar.rejected` use them and every other key ignores them, and a
   * rejection that did not *name* the limit it hit would be the useless
   * "processing failed" message this is written to avoid.
   */
  function failed(errorKey: AccountKey | undefined): void {
    toast.error(
      errorKey
        ? t(errorKey, {
            megabytes: AVATAR_MAX_MEGABYTES,
            megapixels: AVATAR_MAX_MEGAPIXELS,
            size: AVATAR_SIZE,
          })
        : t("saveFailed"),
    );
  }

  function report(result: AccountResult, success: string): void {
    if (result.ok) toast.success(success);
    else failed(result.errorKey);
  }

  function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    start(async () => {
      // attempt(), never a bare await: a rejected action inside a transition
      // escalates to the (app) error boundary and replaces the whole page --
      // including the form the user is halfway through. See @/lib/account/result.
      report(
        await attempt(() => updateProfile({ email, firstName, lastName })),
        t("profile.saved"),
      );
    });
  }

  function pickFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    // Cleared immediately: picking the same file twice in a row fires no
    // `change` event otherwise, so a refused upload could not be retried with
    // the file that was refused.
    event.target.value = "";

    /**
     * **Refused here as well as twice on the server, and this one is not
     * redundant.** Next caps a Server Action request body (`bodySizeLimit` in
     * `next.config.ts`), so a file far above the avatar limit never reaches
     * `uploadAvatar()` at all -- the framework rejects the request and the
     * action has no `{ ok: false }` to return, which showed up in the browser
     * as an upload that produced no message whatsoever. Stopping it in the
     * client is what makes the answer a translated sentence naming the limit.
     * The server's two checks stay: this one is a courtesy to an honest
     * browser, not a control.
     */
    if (file.size > AVATAR_MAX_BYTES) {
      failed("avatar.tooLarge");
      return;
    }

    setPreview(URL.createObjectURL(file));
    const body = new FormData();
    body.set("avatar", file);

    start(async () => {
      const result = await attempt(() => uploadAvatar(body));
      if (!result.ok) setPreview(null);
      report(result, t("avatar.uploaded"));
    });
  }

  function discardPicture() {
    start(async () => {
      const result = await attempt(() => removeAvatar());
      if (result.ok) setPreview(null);
      report(result, t("avatar.removed"));
    });
  }

  const disabled = pending || saving;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("profile.title")}</CardTitle>
        <CardDescription>{t("profile.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-center gap-4">
          {preview ? (
            /* A plain <Avatar> and not <UserAvatar>: this src is a blob: URL
               for a file that has not been stored yet, and safeAvatarSrc()
               accepts nothing but avatarUrlFor(user.id) -- correctly, since it
               guards a column anyone might have written. */
            <Avatar size="lg" role="img" aria-label={t("avatar.title")}>
              <AvatarImage src={preview} alt="" />
              {/* The same fallback <UserAvatar> paints, because Base UI shows
                  it until the image load resolves -- an empty circle for that
                  frame would read as a failed upload. */}
              <AvatarFallback
                aria-hidden="true"
                style={
                  user
                    ? { backgroundColor: colourFor(user.id), color: AVATAR_FOREGROUND }
                    : undefined
                }
              >
                {user ? initialsFor(user) : null}
              </AvatarFallback>
            </Avatar>
          ) : user ? (
            <UserAvatar user={user} size="lg" />
          ) : (
            // No row yet: an empty frame rather than a coloured one -- the
            // colour and the initials both come from the id, which is not
            // known until the promise resolves. The frame itself still
            // renders, disabled, so nothing visually appears or disappears
            // once the real avatar mounts.
            <Avatar size="lg" aria-hidden="true">
              <AvatarFallback />
            </Avatar>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={disabled}
              onClick={() => fileInput.current?.click()}
            >
              {saving ? t("avatar.uploading") : t("avatar.choose")}
            </Button>
            {user?.image ? (
              <Button type="button" variant="ghost" disabled={disabled} onClick={discardPicture}>
                {t("avatar.remove")}
              </Button>
            ) : null}
          </div>

          {/* Hidden, and driven by the button above: a bare file input cannot
              be styled to match the rest of the form, and its own label text
              is supplied by the browser in the browser's language, not in the
              locale this app resolved. */}
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            disabled={disabled}
            onChange={pickFile}
          />
        </div>

        <p className="text-sm text-muted-foreground">
          {t("avatar.help", {
            megabytes: AVATAR_MAX_MEGABYTES,
            megapixels: AVATAR_MAX_MEGAPIXELS,
            size: AVATAR_SIZE,
          })}
        </p>

        <form onSubmit={saveProfile} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="account-email">{t("profile.email")}</Label>
            <Input
              id="account-email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={disabled}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="account-first-name">{t("profile.firstName")}</Label>
              <Input
                id="account-first-name"
                autoComplete="given-name"
                value={firstName}
                onChange={(event) => setFirstName(event.target.value)}
                disabled={disabled}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="account-last-name">{t("profile.lastName")}</Label>
              <Input
                id="account-last-name"
                autoComplete="family-name"
                value={lastName}
                onChange={(event) => setLastName(event.target.value)}
                disabled={disabled}
              />
            </div>
          </div>

          <Button type="submit" disabled={disabled}>
            {t("profile.save")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Calls use(); suspends until the promise resolves; renders the form for real. */
function ProfileSectionResolved({ promise }: { promise: Promise<AccountOverview> }) {
  // `AccountOverview.user` is already the five named columns this card
  // renders, not the whole `User` row -- narrowed in `getAccountOverview()`
  // (see `AccountUser` in `@/lib/account/queries`), *before* this promise was
  // ever constructed. That is deliberate, not merely convenient: React
  // serializes a promise's resolved value, not the type this parameter
  // declares, so narrowing here -- after `use()` has already resolved it --
  // would be too late. The whole row (`role`, the three ban columns,
  // `emailVerified`, the timestamps) would already have crossed into
  // `/account`'s RSC payload by the time this destructure ran.
  const { user } = use(promise);
  return <ProfileSectionForm user={user} />;
}

/**
 * What the page renders. The fallback is the real form, in its pending
 * state -- see the Design Reference in
 * docs/superpowers/plans/2026-08-16-streaming-controls-migration.md -- so the
 * heading, help text, avatar frame and all three field labels are on screen
 * from the first frame and only the values stream in afterward.
 */
export function ProfileSection({ promise }: { promise: Promise<AccountOverview> }) {
  return (
    <Suspense fallback={<ProfileSectionForm pending />}>
      <ProfileSectionResolved promise={promise} />
    </Suspense>
  );
}
