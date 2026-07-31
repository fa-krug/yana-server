import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";

import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { getSettings } from "@/lib/settings/queries";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Yana",
  description: "Self-hosted RSS aggregator",
};

/** The theme applied when the stored preference cannot be read at all. */
const FALLBACK_THEME = "system";

/**
 * The stored theme, or "system" if it cannot be read.
 *
 * Degrades for the same reason src/i18n/request.ts does: this read happens in
 * the *root* layout, so an exception here is a 500 on every route in the app
 * -- including /settings, the only page from which a user could fix the
 * underlying state. getSettings() throws by design when the user_settings row
 * is missing (see queries.ts) and the bootstrap seed is memoized per process,
 * so that state survives until a restart. The value is only a pre-hydration
 * default for next-themes, so falling back costs at most a wrong first paint;
 * propagating costs the whole application. Deliberately limited to this one
 * call: the dashboard's and /settings' own reads of getSettings() still throw
 * and surface a real error through the error boundary.
 */
async function themePreference(): Promise<string> {
  try {
    return (await getSettings()).theme;
  } catch (error) {
    // Logged, not swallowed silently: otherwise the fallback is invisible and
    // the app just looks like it forgot the theme setting.
    console.error(
      `Root layout: could not read the stored theme; falling back to "${FALLBACK_THEME}".`,
      error,
    );
    return FALLBACK_THEME;
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // getLocale() below resolves via src/i18n/request.ts, which calls
  // getSettings() -- a synchronous better-sqlite3 query. Synchronous driver
  // queries complete during prerendering (see Next's docs on `connection`,
  // "Synchronous database drivers"), so without this the production build
  // would prerender "/" against data/, which is gitignored and starts empty
  // until the entrypoint's migration step runs. connection() opts this
  // layout out of prerendering instead; force-dynamic can't be used here
  // because Next 16 drops it once Cache Components is enabled.
  await connection();
  const locale = await getLocale();
  // getSettings() is cache()d (see src/lib/settings/queries.ts), so this
  // shares the request's single SELECT with getLocale() above rather than
  // issuing a second one -- adding the theme bridge below costs no extra query.
  const theme = await themePreference();
  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      {/* suppressHydrationWarning is required: next-themes sets the class on
          <html> before React hydrates, to avoid a flash of the wrong theme. */}
      <body className="min-h-full flex flex-col">
        <ThemeProvider defaultTheme={theme}>
          <NextIntlClientProvider>{children}</NextIntlClientProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
