import { getRequestConfig } from "next-intl/server";

import { isLoginRedirect } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings/queries";

/** The locale used when the stored preference cannot be read at all. */
const FALLBACK_LOCALE = "en";

export default getRequestConfig(async () => {
  // Locale comes from the user's stored preference, not from Accept-Language:
  // this is a single-user-per-session app where the setting is explicit.
  //
  // Wrapped, because this runs in the *root* layout via getLocale(): every
  // route in the app resolves its locale here, so an exception thrown from
  // this function is an unrecoverable 500 on every page including /settings,
  // the one page that could repair the underlying state. getSettings() throws
  // by design when the user_settings row is missing (see queries.ts) and the
  // bootstrap seed is memoized per process, so that state persists until a
  // restart. Locale resolution must never be able to take the application
  // down over it -- an English UI is a far better failure mode than a blank
  // error page. This is the only place the read is allowed to degrade; the
  // dashboard and /settings still surface the real error through their own
  // error boundary.
  let locale: "en" | "de" = FALLBACK_LOCALE;
  try {
    const settings = await getSettings();
    locale = settings.language === "de" ? "de" : FALLBACK_LOCALE;
  } catch (error) {
    // The signed-out case is not a failure and must not escape: getSettings()
    // reaches currentUserId(), which redirects to /login when there is no
    // session -- and this code runs in the root layout, which the login page
    // renders too. Letting that redirect through would send /login to /login
    // forever; logging it would put a stack in the log on every unauthenticated
    // page view. Real protection is src/app/(app)/layout.tsx's own
    // requireUser(), outside any catch. See isLoginRedirect().
    //
    // Anything else is logged, not swallowed silently: without this the
    // fallback is invisible and the app just looks like it forgot the language
    // setting.
    if (!isLoginRedirect(error)) {
      console.error(
        `Locale resolution failed; falling back to "${FALLBACK_LOCALE}". ` +
          "The stored language preference could not be read.",
        error,
      );
    }
  }
  return { locale, messages: (await import(`../../messages/${locale}.json`)).default };
});
