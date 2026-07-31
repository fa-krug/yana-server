"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({
  children,
  defaultTheme = "system",
}: {
  children: React.ReactNode;
  // Server-rendered default, sourced from the user's stored settings row
  // (see the root layout). next-themes embeds this in the pre-hydration
  // script it injects and only falls back to it when its own localStorage
  // key is empty, so a fresh browser paints the stored theme with no flash
  // instead of always starting at "system". Once a user has toggled the
  // theme locally, localStorage wins over this prop -- if they later change
  // it in another browser, this device keeps showing its own localStorage
  // value until it is cleared. That is intentional: theme is effectively
  // per-device after first use, not a bug to "fix" by forcing the database
  // value over local state.
  defaultTheme?: string;
}) {
  return (
    <NextThemesProvider attribute="class" defaultTheme={defaultTheme} enableSystem>
      {children}
    </NextThemesProvider>
  );
}
