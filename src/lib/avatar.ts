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

/**
 * The upload limits, as plain numbers.
 *
 * They live here rather than in `./avatar-storage` for one reason: the account
 * page has to **state** them ("at most 2 MB", "at most 25 megapixels") and the
 * account page is a client component, which ESLint forbids from importing
 * `avatar-storage` at all (sharp, `node:path`). Two hand-written copies of "25"
 * -- one in a limit and one in a sentence -- is exactly the pair that drifts.
 *
 * This does **not** move the enforcement out of `processAvatar()`, which is the
 * rule CLAUDE.md states: that function still applies `AVATAR_MAX_MEGAPIXELS`
 * itself, so no caller has to remember it. Only the *number* is shared, and the
 * reasoning for each value stays next to the code that applies it.
 *
 * `AVATAR_MAX_BYTES` is the one limit a caller does apply, because only the
 * caller has the upload: `uploadAvatar()` in `@/lib/account/actions` checks the
 * declared size and then the real byte length.
 */
export const AVATAR_MAX_MEGABYTES = 2;
export const AVATAR_MAX_BYTES = AVATAR_MAX_MEGABYTES * 1024 * 1024;
export const AVATAR_MAX_MEGAPIXELS = 25;

/** The square every avatar is cropped to. Large enough for a 2x 128px render. */
export const AVATAR_SIZE = 256;

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

/** The fallback's foreground. Every colour below is chosen to be legible under it. */
export const AVATAR_FOREGROUND = "#ffffff";

/** Saturation, fixed. Only lightness moves, and it moves to satisfy contrast. */
const SATURATION = 55;

/**
 * The contrast ratio each colour is solved for.
 *
 * WCAG AA for normal-size text is 4.5:1; the extra 0.1 is margin, so a hue
 * sitting exactly on the boundary cannot be pushed under it by a rounding
 * difference somewhere downstream.
 */
const TARGET_CONTRAST = 4.6;

/** The lightness window the search runs over, darkest last. */
const MAX_LIGHTNESS = 70;
const MIN_LIGHTNESS = 20;

/** sRGB companding, from the WCAG relative-luminance definition. */
function linearise(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** HSL (h in degrees, s and l in percent) to sRGB in 0..1. */
function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const s = saturation / 100;
  const l = lightness / 100;
  const a = s * Math.min(l, 1 - l);
  const component = (n: number) => {
    const k = (n + hue / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return [component(0), component(8), component(4)];
}

/** WCAG relative luminance. */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * linearise(r) + 0.7152 * linearise(g) + 0.0722 * linearise(b);
}

/**
 * Contrast ratio between this colour and white.
 *
 * White's luminance is 1, so the general `(lighter + 0.05) / (darker + 0.05)`
 * collapses to this -- every colour the search considers is darker than white.
 */
export function contrastWithWhite(hue: number, saturation: number, lightness: number): number {
  return 1.05 / (relativeLuminance(hslToRgb(hue, saturation, lightness)) + 0.05);
}

/**
 * The lightness (within the window above) that first clears `TARGET_CONTRAST`
 * against white for this hue, scanning from lightest to darkest.
 *
 * Extracted out of `colourFor()` so `src/lib/tags/colors.ts` can solve the same
 * problem for a fixed palette of hues instead of a hash-derived one, without a
 * second copy of the WCAG math.
 */
export function solveLightnessForHue(hue: number, saturation: number = SATURATION): number {
  for (let candidate = MAX_LIGHTNESS; candidate >= MIN_LIGHTNESS; candidate -= 1) {
    if (contrastWithWhite(hue, saturation, candidate) >= TARGET_CONTRAST) {
      return candidate;
    }
  }
  return MIN_LIGHTNESS;
}

/**
 * Deterministic colour from the user id, so an avatar looks the same on every
 * device and across sessions -- there is nothing persisted to disagree with.
 *
 * **Lightness varies with hue, and that is the whole point.** A fixed
 * `hsl(h 55% 45%)` -- what this returned first -- is *predictably* poor rather
 * than predictably good: white on it falls below AA 4.5:1 for **184 of 360
 * hues**, below even 3:1 for 40% of them, bottoming out at 2.26:1 around hue 60
 * where the colour is yellow. Ids are random, so that is not an edge case, it
 * is half of all users looking at an unreadable version of their own initials
 * forever. Relative luminance is wildly non-uniform across hue -- green carries
 * 0.7152 of it and blue 0.0722 -- so no single lightness can serve every hue.
 *
 * So the lightness is *solved* per hue via `solveLightnessForHue()`. Yellows
 * land near 30% and blues near 62%, and the resulting ratios sit in a narrow
 * 4.60-4.86 band, so the palette reads as one family instead of some colours
 * being much darker than they need to be.
 *
 * `src/lib/avatar.test.ts` asserts the ratio across the whole hue range, not
 * for a couple of sample ids -- sampling is what let the first version ship.
 */
export function colourFor(id: string): string {
  let hue = 0;
  for (let index = 0; index < id.length; index += 1) {
    hue = (hue * 31 + id.charCodeAt(index)) % 360;
  }

  const lightness = solveLightnessForHue(hue);
  return `hsl(${hue} ${SATURATION}% ${lightness}%)`;
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
 * and so nothing to strip wrongly.
 */
export function avatarUrlFor(userId: string): string {
  return `/media/avatars/${userId}`;
}

/**
 * The `src` to render for this user, or `null` for "use the initials".
 *
 * **`users.image` is attacker-controlled, so it is never rendered verbatim.**
 * Better Auth's `POST /api/auth/update-user` accepts an arbitrary `image`
 * string from any signed-in user; `src/lib/auth/server.ts` now closes that
 * endpoint, but the column is still reachable from the `admin()` plugin's
 * `/admin/update-user`, from a restored backup, and from any future write, and
 * `<UserAvatar>` renders in *other people's* browsers -- the sidebar footer,
 * the account page, phase 5's user list. A stored
 * `https://evil.example.com/track.gif` would therefore fire from every viewer,
 * leaking their IP, user-agent and referrer, and it would route around the
 * whole point of re-encoding uploads and serving them from a session-gated
 * route. This is the render-side half of that fix, and it is the half that
 * holds no matter how the value got into the column.
 *
 * The test is **equality with `avatarUrlFor(user.id)`**, not a prefix or a
 * protocol check. Same discipline as the route handler: compare against the one
 * value that is allowed and discard everything else, rather than trying to
 * enumerate the spellings that are not (`//evil.tld`, `javascript:`, `data:`,
 * a protocol-relative host, someone else's id, a query string appended to a
 * legitimate path). If a later phase adds a cache-busting token to the URL, it
 * changes `avatarUrlFor()` and this keeps matching by construction.
 */
export function safeAvatarSrc(
  user: Pick<AvatarUser, "id"> & { image: string | null },
): string | null {
  if (user.image === null) return null;
  return user.image === avatarUrlFor(user.id) ? user.image : null;
}
