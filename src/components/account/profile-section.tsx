"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserAvatar } from "@/components/user-avatar";
import { removeAvatar, updateProfile, uploadAvatar } from "@/lib/account/actions";
import { attempt, type AccountKey, type AccountResult } from "@/lib/account/result";
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
 */
export function ProfileSection({ user }: { user: AvatarUser & { image: string | null } }) {
  const t = useTranslations("account");
  const [email, setEmail] = useState(user.email);
  const [firstName, setFirstName] = useState(user.firstName);
  const [lastName, setLastName] = useState(user.lastName);
  const [pending, start] = useTransition();
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

  return (
    <ProfileSectionShell
      onSubmit={saveProfile}
      avatarControl={
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
                style={{ backgroundColor: colourFor(user.id), color: AVATAR_FOREGROUND }}
              >
                {initialsFor(user)}
              </AvatarFallback>
            </Avatar>
          ) : (
            <UserAvatar user={user} size="lg" />
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              onClick={() => fileInput.current?.click()}
            >
              {pending ? t("avatar.uploading") : t("avatar.choose")}
            </Button>
            {user.image ? (
              <Button type="button" variant="ghost" disabled={pending} onClick={discardPicture}>
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
            onChange={pickFile}
          />
        </div>
      }
      emailControl={
        <Input
          id="account-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      }
      firstNameControl={
        <Input
          id="account-first-name"
          autoComplete="given-name"
          value={firstName}
          onChange={(event) => setFirstName(event.target.value)}
        />
      }
      lastNameControl={
        <Input
          id="account-last-name"
          autoComplete="family-name"
          value={lastName}
          onChange={(event) => setLastName(event.target.value)}
        />
      }
      saveControl={
        <Button type="submit" disabled={pending}>
          {t("profile.save")}
        </Button>
      }
    />
  );
}

/**
 * The section's chrome alone: the card heading, the avatar-limits help text
 * and the three field labels, with no dependency on `user` or any pending
 * state -- see the doc comment on `GeneralSectionShell` in
 * `../settings/general-section.tsx` for why `account/page.tsx` renders this
 * directly as its own `<Suspense>` fallback (with skeletons standing in for
 * the avatar area and each field) instead of a generic skeleton block. The
 * avatar block is one slot rather than several: every piece of it (the image,
 * the choose/remove buttons, the hidden input) depends on `user` or local
 * state, so there is no static chrome left to split out of it.
 */
export function ProfileSectionShell({
  avatarControl,
  emailControl,
  firstNameControl,
  lastNameControl,
  saveControl,
  // Optional, and defaulted here rather than by the caller -- see the same
  // comment on `YoutubeSectionShell` in
  // `../integrations/youtube-section.tsx`: `account/page.tsx`'s Suspense
  // fallback and `account/loading.tsx` are Server Components and cannot pass
  // a function across the RSC boundary, so they pass nothing and this
  // "use client" module supplies the no-op.
  onSubmit = (event) => event.preventDefault(),
}: {
  avatarControl: ReactNode;
  emailControl: ReactNode;
  firstNameControl: ReactNode;
  lastNameControl: ReactNode;
  saveControl: ReactNode;
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
}) {
  const t = useTranslations("account");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("profile.title")}</CardTitle>
        <CardDescription>{t("profile.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {avatarControl}

        <p className="text-sm text-muted-foreground">
          {t("avatar.help", {
            megabytes: AVATAR_MAX_MEGABYTES,
            megapixels: AVATAR_MAX_MEGAPIXELS,
            size: AVATAR_SIZE,
          })}
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="account-email">{t("profile.email")}</Label>
            {emailControl}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="account-first-name">{t("profile.firstName")}</Label>
              {firstNameControl}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="account-last-name">{t("profile.lastName")}</Label>
              {lastNameControl}
            </div>
          </div>

          {saveControl}
        </form>
      </CardContent>
    </Card>
  );
}
