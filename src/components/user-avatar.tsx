import { useTranslations } from "next-intl";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  AVATAR_FOREGROUND,
  type AvatarUser,
  colourFor,
  displayNameFor,
  initialsFor,
  safeAvatarSrc,
} from "@/lib/avatar";

/**
 * A user's avatar: their uploaded image if there is one, otherwise their
 * initials on a colour derived from their id.
 *
 * **Deliberately not marked `"use client"`.** It calls `useTranslations()`,
 * which next-intl supports in both a client component and a *synchronous*
 * server component, and holds no state of its own -- so it adopts whichever
 * context renders it. That is what lets phase 5 drop it into a client sidebar
 * menu and a server-rendered user table alike. It is also why `@/lib/avatar`
 * imports nothing: this component reaches the browser bundle, and
 * `@/lib/avatar-storage` (sharp, node:fs) must never follow it there.
 *
 * **Two things about Base UI's `<Avatar>` that a Radix-shaped snippet gets
 * wrong here.** `AvatarImage` renders *nothing* until a `new window.Image()`
 * load resolves in the browser (`useImageLoadingStatus`), so the server always
 * paints the fallback and the photograph swaps in after hydration -- the
 * initials are the first frame for every user, not a loading state for some of
 * them. And `AvatarFallback` is shown by the root's `imageLoadingStatus`, not
 * by the absence of a sibling, so it renders correctly whether or not the
 * conditional below emits an image.
 *
 * **Accessibility lives on the root, not on the two children**, because the two
 * children are never both present. `alt` on the image would name the avatar
 * only once it had loaded, and the fallback's initials read aloud as "AL",
 * which is noise. `role="img"` plus one translated label gives the same
 * announcement in both states; the initials are then decoration.
 */
export function UserAvatar({
  user,
  className,
  size,
}: {
  user: AvatarUser & { image: string | null };
  className?: string;
  size?: "default" | "sm" | "lg";
}) {
  const t = useTranslations("avatar");
  const label = t("label", { name: displayNameFor(user) });
  // Never `user.image` directly: the column is attacker-controlled, and this
  // component renders in other people's browsers. See safeAvatarSrc().
  const src = safeAvatarSrc(user);

  return (
    <Avatar className={className} size={size} role="img" aria-label={label}>
      {src ? <AvatarImage src={src} alt="" /> : null}
      <AvatarFallback
        aria-hidden="true"
        style={{ backgroundColor: colourFor(user.id), color: AVATAR_FOREGROUND }}
      >
        {initialsFor(user)}
      </AvatarFallback>
    </Avatar>
  );
}
