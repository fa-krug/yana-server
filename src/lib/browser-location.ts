/**
 * A full document navigation that replaces the current history entry.
 *
 * **Signing in is the one navigation in this application that must not be a
 * client-side one**, and the reason is structural rather than cautious: the
 * root layout owns `<html lang>`, `NextIntlClientProvider`'s messages and the
 * theme, and it is *above* every route, so `router.replace()` re-renders the
 * destination page without ever re-rendering it. Identity changes at exactly
 * this moment -- and with it the locale, because a signed-out request
 * negotiates `Accept-Language` while a signed-in one reads the stored
 * preference (`src/i18n/request.ts`). A soft navigation therefore lands the
 * user on a page whose chrome is still in the language the *browser* asked for
 * while the freshly-rendered page is in the language they *chose*: observed, in
 * a real German-locale Chrome, as a German sidebar around an English settings
 * page that a manual reload then corrected.
 *
 * `replace`, not `assign`: /login must not sit in the history stack behind the
 * app, or the back button lands a signed-in user on a sign-in form.
 *
 * It exists as a module rather than an inline `window.location.replace()`
 * purely as a seam -- jsdom's `Location` methods cannot be spied on
 * ("Cannot redefine property: replace"), so a test could neither observe the
 * navigation nor stop jsdom from logging a not-implemented error for it.
 */
export function replaceLocation(url: string): void {
  window.location.replace(url);
}
