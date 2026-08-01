import { render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";

import { ThemeProvider } from "@/components/theme-provider";

import de from "../../messages/de.json";
import en from "../../messages/en.json";

// The real catalogs, not invented ones: a test with its own message objects
// would stay green while the shipped catalogs were broken, which is most of
// what these tests exist to notice.
const CATALOGS = { en, de };

export type TestLocale = keyof typeof CATALOGS;

type Options = {
  /** Which catalog the tree renders with. */
  locale?: TestLocale;
  /**
   * Mount next-themes' provider with this `defaultTheme`. Omit it for trees
   * that do not read the theme -- the provider writes localStorage and reads
   * matchMedia, and no test should carry that unless it is the subject.
   */
  theme?: string;
};

/**
 * Render inside the providers the app's client components require.
 *
 * The layout and the sidebar/breadcrumbs are client components calling
 * useTranslations(), so they need the intl provider; the settings controls also
 * need next-themes. Anything else a component needs belongs in the test that
 * needs it, not here.
 */
export function renderWithProviders(ui: ReactNode, { locale = "en", theme }: Options = {}) {
  const tree =
    (
      /**
       * `timeZone` is pinned, and it is not incidental. next-intl otherwise
       * formats dates in the *environment's* zone, so a date assertion here
       * would pass or fail depending on the developer's laptop and on CI's
       * `TZ`. UTC matches what `src/i18n/request.ts` configures when the
       * container sets none, so a test and a default deployment format the same
       * instant the same way.
       */
      <NextIntlClientProvider locale={locale} messages={CATALOGS[locale]} timeZone="UTC">
        {ui}
      </NextIntlClientProvider>
    );
  return render(
    theme === undefined ? tree : <ThemeProvider defaultTheme={theme}>{tree}</ThemeProvider>,
  );
}
