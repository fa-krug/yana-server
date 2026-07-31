import { headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import { FALLBACK_LOCALE, negotiateLocale, type AppLocale } from "@/i18n/locale";
import { isLoginRedirect } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings/queries";

/**
 * The locale for a request with no stored preference behind it.
 *
 * **The stored preference wins whenever there is one** -- this runs only when
 * `getSettings()` could not answer, which in practice means /login, the one
 * page rendered without a session. Before this, that page was always English:
 * a German visitor met the application for the first time in the wrong
 * language, on the only screen with no settings control on it.
 *
 * Wrapped again, and falling back again, for the same reason the caller does:
 * this is the *root* layout's locale resolution, and `headers()` failing here
 * must not be able to 500 every route in the application.
 */
async function browserLocale(): Promise<AppLocale> {
  try {
    return negotiateLocale((await headers()).get("accept-language"));
  } catch (error) {
    console.error(`Could not read Accept-Language; falling back to "${FALLBACK_LOCALE}".`, error);
    return FALLBACK_LOCALE;
  }
}

export default getRequestConfig(async () => {
  // A signed-in user's locale is their stored preference and nothing else --
  // the setting is explicit, and a browser header must never override a choice
  // the user made in the application. Accept-Language is consulted only when
  // there is no stored preference to read, which is the signed-out case; see
  // browserLocale() above.
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
  let locale: AppLocale = FALLBACK_LOCALE;
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
        "Locale resolution failed; falling back to the browser's preference. " +
          "The stored language preference could not be read.",
        error,
      );
    }
    // Both branches, not just the signed-out one: a request whose stored
    // preference could not be read has no preference to honour either way, and
    // the browser's is a better guess than a constant.
    locale = await browserLocale();
  }
  return { locale, messages: (await import(`../../messages/${locale}.json`)).default };
});
