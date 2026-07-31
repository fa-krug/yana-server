/**
 * Avatar presentation: the pure half.
 *
 * **This module imports nothing, and must stay that way** -- the same rule
 * `src/lib/auth/roles.ts` lives under, for the same reason. `<UserAvatar>` is
 * rendered from client components (a sidebar user menu, phase 5's user table)
 * as well as from the server, so anything reachable from here ends up in the
 * browser bundle. The server-only half -- `sharp`, `node:fs`, the media root --
 * lives in `./avatar-storage`, and nothing in `src/components` may import that.
 */

/** The user fields the presentation helpers read. */
export type AvatarUser = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
};

/**
 * One or two letters for the fallback.
 *
 * `firstName`/`lastName` are `notNull` with `""` defaults (see
 * `schema/users.ts`), so "no name at all" is the empty string here, never null,
 * and the email is what is left to initial. `"?"` covers the last case that
 * cannot happen through any provisioning path but would otherwise render an
 * empty circle.
 */
export function initialsFor(user: Pick<AvatarUser, "firstName" | "lastName" | "email">): string {
  const letters = [user.firstName, user.lastName]
    .map((part) => part.trim().charAt(0))
    .filter(Boolean);
  if (letters.length) return letters.join("").toUpperCase();
  return (user.email.trim().charAt(0) || "?").toUpperCase();
}

/**
 * What to call this user in an accessible label.
 *
 * The two name columns default to `""`, so a user provisioned without a name --
 * the bootstrap administrator, among others -- falls through to the address
 * rather than producing "Avatar of ".
 */
export function displayNameFor(user: Pick<AvatarUser, "firstName" | "lastName" | "email">): string {
  return `${user.firstName} ${user.lastName}`.trim() || user.email;
}

/**
 * Deterministic colour from the user id, so an avatar looks the same on every
 * device and across sessions -- there is nothing persisted to disagree with.
 * Fixed saturation and lightness keep contrast with white text predictable in
 * both themes.
 */
export function colourFor(id: string): string {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 360;
  }
  return `hsl(${hash} 55% 45%)`;
}

/**
 * The URL that serves this user's uploaded avatar.
 *
 * **The single source of the value `users.image` holds.** The route handler at
 * `src/app/media/avatars/[userId]/route.ts` answers exactly this path, and task
 * 6's upload writes exactly this string to the column, so the two cannot drift.
 *
 * Note what the path does *not* carry: no extension, because the segment is a
 * user id and never a filename -- there is nothing for the handler to strip,
 * and so nothing to strip wrongly. `<UserAvatar>` still renders `user.image`
 * verbatim rather than recomputing it, so a column holding some other URL
 * entirely would keep working.
 */
export function avatarUrlFor(userId: string): string {
  return `/media/avatars/${userId}`;
}
