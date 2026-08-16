"use client";

import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { Suspense, use, useState, useSyncExternalStore, useTransition } from "react";
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
 * The presentational form: heading and both field labels/controls, with
 * `theme`/`language === undefined` (paired with `pending`) meaning "not loaded
 * yet". A pending `<Select>` omits `value` entirely rather than passing `""`
 * -- `""` is a legal option value elsewhere in this codebase (see the Base UI
 * bullet in CLAUDE.md) and Base UI would read it as a real, empty selection
 * rather than "nothing selected yet". `items` stays required on both either
 * way, and needs no query -- the option lists are the dependency-free
 * `THEMES`/`LANGUAGES` tuples above.
 *
 * Theme has two stores, and they answer different questions:
 *
 * - **localStorage is authoritative for the *applied* theme.** next-themes
 *   resolves `localStorage.getItem(key) || defaultTheme`, so once this device
 *   has ever picked a theme, its own choice is what paints -- the database
 *   value the page passes in as `theme` is only the pre-hydration fallback for
 *   a browser that has no stored value yet. See src/components/theme-provider.tsx.
 * - **The database row is authoritative for the *portable* preference.** It is
 *   what a fresh browser starts from, so the write is kept.
 *
 * The control therefore displays useTheme()'s value, never the `theme` prop,
 * once hydrated: seeding it from the prop made it show the losing store
 * (toggle to dark here, light on a phone, come back -- the page is dark and
 * the Select said light, and re-picking "dark" was a no-op from its
 * perspective).
 *
 * The `theme` prop survives as the pre-hydration value only. next-themes'
 * state initializer bails out when `typeof window === "undefined"`, so
 * useTheme().theme is `undefined` on the server and would render an empty
 * control; and it is already the localStorage value during the hydration
 * render, so switching to it there is a guaranteed hydration mismatch on the
 * trigger's text. useHydrated() defers the switch to the commit after
 * hydration, which is the one point where the two are allowed to differ. With
 * `theme === undefined` (pending) and not yet hydrated, the trigger shows the
 * placeholder, exactly like the unresolved-language case.
 */
export function GeneralSectionForm({
  theme,
  language,
  pending = false,
}: {
  theme?: string;
  language?: string;
  pending?: boolean;
}) {
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
  const [saving, start] = useTransition();
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
    <section className="space-y-4">
      <h2 className="text-lg font-medium">{t("general.title")}</h2>

      <div className="grid gap-2">
        <Label htmlFor="theme">{t("general.theme")}</Label>
        <Select
          items={themeItems}
          {...(themeValue !== undefined ? { value: themeValue } : {})}
          disabled={pending || saving}
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
            // `languageValue!`, not `?? value`: falling back to the theme's own
            // new value would silently submit it as the language if this were
            // ever reached with `languageValue` still undefined. It cannot be
            // today -- both Selects are `disabled={pending || saving}`, so
            // `onValueChange` never fires while a value is unresolved -- but a
            // wrong write with no error is worse than a loud one, so the
            // invariant is asserted here rather than papered over.
            save({ theme: value, language: languageValue! });
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
      </div>

      <div className="grid gap-2">
        <Label htmlFor="language">{t("general.language")}</Label>
        <Select
          items={languageItems}
          {...(languageValue !== undefined ? { value: languageValue } : {})}
          disabled={pending || saving}
          onValueChange={(value) => {
            if (value === null) return;
            setLanguageValue(value);
            // `themeValue!`, not `?? value`: same reasoning as the theme
            // Select's handler above, mirrored -- falling back to the
            // language's own new value would silently submit it as the theme.
            // `disabled={pending || saving}` is what makes `themeValue` defined
            // whenever this fires; that guarantee is the whole justification
            // for the assertion, so a later change to `disabled` must keep it.
            save({ theme: themeValue!, language: value });
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
      </div>
    </section>
  );
}

/** Calls use(); suspends until the promise resolves; renders the form for real. */
function GeneralSectionResolved({
  promise,
}: {
  promise: Promise<{ theme: string; language: string }>;
}) {
  const settings = use(promise);
  return <GeneralSectionForm theme={settings.theme} language={settings.language} />;
}

/**
 * What the page renders. The fallback is the real form, in its pending
 * state -- see the Design Reference in
 * docs/superpowers/plans/2026-08-16-streaming-controls-migration.md -- so the
 * heading and both labels are on screen from the first frame and only the
 * theme/language values stream in afterward.
 */
export function GeneralSection({
  promise,
}: {
  promise: Promise<{ theme: string; language: string }>;
}) {
  return (
    <Suspense fallback={<GeneralSectionForm pending />}>
      <GeneralSectionResolved promise={promise} />
    </Suspense>
  );
}
