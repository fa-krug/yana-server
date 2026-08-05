"use client";

import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import { updateGeneralSettings } from "@/lib/settings/actions";
import { attempt } from "@/lib/settings/result";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// `as const`, so `value` below is "light" | "dark" | "system" rather than
// string and t(`theme.${value}`) resolves to real catalog keys the compiler can
// check (see src/i18n/next-intl.d.ts). A plain string[] widens the template
// literal to `theme.${string}`, which matches nothing.
const THEMES = ["light", "dark", "system"] as const;
const LANGUAGES = ["en", "de"] as const;

type Theme = (typeof THEMES)[number];

function isTheme(value: string | undefined): value is Theme {
  return THEMES.includes(value as Theme);
}

/**
 * True once the client has hydrated, false on the server and during the
 * hydration render itself.
 *
 * useSyncExternalStore rather than useState + useEffect, the same technique
 * src/hooks/use-mobile.ts uses: React renders getServerSnapshot() on the server
 * *and* during hydration, then switches to getSnapshot() on the first commit
 * after. That yields a deliberate second render with no setState in an effect
 * body, which react-hooks/set-state-in-effect forbids here. The store never
 * emits, so subscribe() is a no-op returning a no-op unsubscribe.
 */
const subscribeNothing = () => () => {};
const alwaysTrue = () => true;
const alwaysFalse = () => false;

function useHydrated(): boolean {
  return useSyncExternalStore(subscribeNothing, alwaysTrue, alwaysFalse);
}

/**
 * Theme has two stores, and they answer different questions:
 *
 * - **localStorage is authoritative for the *applied* theme.** next-themes
 *   resolves `localStorage.getItem(key) || defaultTheme`, so once this device
 *   has ever picked a theme, its own choice is what paints -- the database
 *   value the root layout passes in as `defaultTheme` is only the
 *   pre-hydration fallback for a browser that has no stored value yet. See
 *   src/components/theme-provider.tsx.
 * - **The database row is authoritative for the *portable* preference.** It is
 *   what a fresh browser starts from, so the write is kept.
 *
 * The control therefore displays useTheme()'s value, never the server prop:
 * seeding it from the prop made it show the losing store (toggle to dark here,
 * light on a phone, come back -- the page is dark and the Select said light,
 * and re-picking "dark" was a no-op from its perspective).
 *
 * The `theme` prop survives as the pre-hydration value only. next-themes'
 * state initializer bails out when `typeof window === "undefined"`, so
 * useTheme().theme is `undefined` on the server and would render an empty
 * control; and it is already the localStorage value during the hydration
 * render, so switching to it there is a guaranteed hydration mismatch on the
 * trigger's text. useHydrated() defers the switch to the commit after
 * hydration, which is the one point where the two are allowed to differ.
 */
export function GeneralSection({ theme, language }: { theme: string; language: string }) {
  const t = useTranslations("settings");
  // One list per Select, feeding both the root's `items` and the popup's
  // SelectItems, so the collapsed trigger and the open popup cannot disagree.
  //
  // `items` is what makes the trigger readable at all: Base UI's
  // <Select.Value> only consults it (or an explicit children function) to
  // resolve a label. With `items` undefined it falls through to
  // stringifyAsLabel(value) -- see resolveSelectedLabel() in
  // @base-ui/react/internals/resolveValueLabel -- which rendered the raw enum
  // ("dark", "en") on the trigger while the popup items were translated. It
  // never reads <Select.ItemText>, so the popup being right proves nothing
  // about the trigger. Passing `items` also gives an unselected Select a real
  // placeholder instead of a serialized empty value.
  //
  // Mapping over the `as const` tuples keeps every t() argument a literal, so
  // the catalog keys stay compiler-checked (see src/i18n/next-intl.d.ts); a
  // cast at the t() call site would have silently switched that off.
  const themeItems = THEMES.map((value) => ({ value, label: t(`theme.${value}`) }));
  const languageItems = LANGUAGES.map((value) => ({ value, label: t(`language.${value}`) }));
  const { theme: appliedTheme, setTheme } = useTheme();
  const hydrated = useHydrated();
  const [pending, start] = useTransition();
  // Controlled, not defaultValue: a language change revalidates the whole
  // layout (see actions.ts), which re-renders this already-mounted component
  // with fresh theme/language props without remounting it. An uncontrolled
  // Select only reads defaultValue once at mount, and Base UI logs a console
  // error if that prop later changes anyway -- controlling the value sidesteps
  // that rather than fighting an uncontrolled component.
  const [languageValue, setLanguageValue] = useState(language);

  // isTheme() guards the localStorage read: next-themes hands back whatever
  // string is under its key, and a value outside this list would leave the
  // trigger blank with no matching item.
  const themeValue = hydrated && isTheme(appliedTheme) ? appliedTheme : theme;

  function save(next: { theme: string; language: string }) {
    start(async () => {
      // attempt(), never a bare await. An action can fail *without returning*
      // -- a dropped connection, the container restarting mid-request -- and an
      // unhandled rejection inside this transition scope escalates to the (app)
      // group's error.tsx, replacing the whole page. It also tells a session
      // that ended from a request that failed: the proxy answers a cookie-less
      // action POST with a 307 to /login, which arrives here as an unparseable
      // RSC payload. See @/lib/settings/result.
      const result = await attempt(() => updateGeneralSettings(next));
      if (result.ok) {
        toast.success(t("saved"));
      } else {
        toast.error(result.errorKey ? t(result.errorKey) : t("saveFailed"));
      }
    });
  }

  return (
    <GeneralSectionShell
      themeControl={
        <Select
          items={themeItems}
          value={themeValue}
          disabled={pending}
          onValueChange={(value) => {
            // Base UI's Select reports `null` for a clearable selection, which
            // this one never is (every item list is exhaustive, no empty
            // option) -- the guard exists to satisfy that wider type, not
            // because null is reachable here.
            if (value === null) return;
            // setTheme() is both the local apply and the display update: it
            // writes localStorage and moves next-themes' state, which is what
            // `themeValue` above reads. No separate useState to keep in sync.
            setTheme(value);
            save({ theme: value, language: languageValue });
          }}
        >
          <SelectTrigger id="theme" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {themeItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
      languageControl={
        <Select
          items={languageItems}
          value={languageValue}
          disabled={pending}
          onValueChange={(value) => {
            if (value === null) return;
            setLanguageValue(value);
            save({ theme: themeValue, language: value });
          }}
        >
          <SelectTrigger id="language" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {languageItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}

/**
 * The section's chrome alone: the heading and both field labels, with no
 * dependency on `theme`/`language` -- `settings/page.tsx` renders this as its
 * own `<Suspense>` fallback (with skeleton bars for `themeControl`/
 * `languageControl`) so the heading and labels never disappear while the
 * database read resolves, matching what `<GeneralSection>` above renders once
 * it has. A plain presentational split, not a state-sharing one: unlike the
 * CRUD tables' `<DataTableHeader>`/`<DataTableBody>`, nothing here needs to
 * survive the `<Suspense>` boundary, so the fallback and the resolved render
 * are just two independent calls to this same component.
 */
export function GeneralSectionShell({
  themeControl,
  languageControl,
}: {
  themeControl: ReactNode;
  languageControl: ReactNode;
}) {
  const t = useTranslations("settings");

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">{t("general.title")}</h2>

      <div className="grid gap-2">
        <Label htmlFor="theme">{t("general.theme")}</Label>
        {themeControl}
      </div>

      <div className="grid gap-2">
        <Label htmlFor="language">{t("general.language")}</Label>
        {languageControl}
      </div>
    </section>
  );
}
