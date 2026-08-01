"use client";

import { LogOut } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { SidebarMenuButton } from "@/components/ui/sidebar";
import { signOut } from "@/lib/auth/client";
import { LOGIN_PATH } from "@/lib/auth/next-path";
import { replaceLocation } from "@/lib/browser-location";

/**
 * The way out. Sessions last 30 days, so there has to be one.
 *
 * It lives in the **sidebar footer**, directly under the profile entry, rather
 * than on `/account`: the footer is the only chrome present on every route in
 * the group, it is where the signed-in identity is already displayed, and
 * "sign out lives next to who you are signed in as" is what a user looks for
 * first. `/account` would have made it a page you must navigate to in order to
 * leave.
 *
 * **The navigation is a full document load** (`replaceLocation()`), for exactly
 * the reason sign-*in* is one: the root layout owns `<html lang>`, the intl
 * provider and the theme, and it does not re-render on a soft navigation.
 * Identity changes at this moment and the locale changes with it -- a signed-in
 * user's stored preference gives way to `Accept-Language` negotiation
 * (`src/i18n/request.ts`) -- so `router.replace()` would leave the sign-in page
 * wrapped in chrome built for the person who just left. That is the mixed-locale
 * render phase 4 already fixed once on the way in; this is the same property on
 * the way out.
 *
 * `replace`, not a push: the signed-in page must not sit in the history stack
 * behind /login, where Back would restore a view of it from the bfcache.
 */
export function SignOutButton() {
  const t = useTranslations("auth");
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);

    /**
     * `@better-fetch/fetch` turns *HTTP* failures into `{ data, error }` but
     * leaves its own `await fetch(...)` unwrapped, so a network-level failure
     * rejects instead -- the same trap that left the login form stuck on
     * "Signing in" forever (see `attempt()` in `./login-form.tsx`). Both shapes
     * are handled here: a rejection and an `{ error }` result mean the same
     * thing to the user, and both must clear `busy` or the only way out of the
     * application becomes a dead button.
     */
    try {
      const { error } = await signOut();
      if (error) {
        setBusy(false);
        toast.error(t("signOutFailed"));
        return;
      }
    } catch (thrown) {
      // A platform `TypeError: fetch failed`: untranslated, and the browser has
      // already logged the failed request.
      console.error("Signing out failed before it produced a result", thrown);
      setBusy(false);
      toast.error(t("signOutFailed"));
      return;
    }

    // `busy` stays true: the document is on its way out, and re-enabling the
    // button only invites a second sign-out on top of it.
    replaceLocation(LOGIN_PATH);
  }

  return (
    // Base UI's `render`, not Radix's `asChild` -- and no `render` at all here,
    // because the default element for SidebarMenuButton is already a <button>.
    <SidebarMenuButton onClick={run} disabled={busy} tooltip={t("signOut")}>
      <LogOut />
      <span>{busy ? t("signingOut") : t("signOut")}</span>
    </SidebarMenuButton>
  );
}
