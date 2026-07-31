import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";

import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

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
  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      {/* suppressHydrationWarning is required: next-themes sets the class on
          <html> before React hydrates, to avoid a flash of the wrong theme. */}
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <NextIntlClientProvider>{children}</NextIntlClientProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
