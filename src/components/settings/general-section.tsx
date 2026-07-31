"use client";

import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { updateGeneralSettings } from "@/lib/settings/actions";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function GeneralSection({ theme, language }: { theme: string; language: string }) {
  const t = useTranslations("settings");
  const { setTheme } = useTheme();
  const [pending, start] = useTransition();
  // Controlled, not defaultValue: a language change revalidates the whole
  // layout (see actions.ts), which re-renders this already-mounted component
  // with fresh theme/language props without remounting it. An uncontrolled
  // Select only reads defaultValue once at mount, and Base UI logs a console
  // error if that prop later changes anyway -- controlling the value from
  // state sidesteps that rather than fighting an uncontrolled component.
  const [themeValue, setThemeValue] = useState(theme);
  const [languageValue, setLanguageValue] = useState(language);

  function save(next: { theme: string; language: string }) {
    start(async () => {
      const result = await updateGeneralSettings(next);
      if (result.ok) {
        toast.success(t("saved"));
      } else {
        toast.error(result.error ?? t("saveFailed"));
      }
    });
  }

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">{t("general.title")}</h2>

      <div className="grid gap-2">
        <Label htmlFor="theme">{t("general.theme")}</Label>
        <Select
          value={themeValue}
          disabled={pending}
          onValueChange={(value) => {
            // Base UI's Select reports `null` for a clearable selection, which
            // this one never is (every item list is exhaustive, no empty
            // option) -- the guard exists to satisfy that wider type, not
            // because null is reachable here.
            if (value === null) return;
            // Applied locally at once so the change is visible before the round
            // trip; the server write is what makes it persist.
            setThemeValue(value);
            setTheme(value);
            save({ theme: value, language: languageValue });
          }}
        >
          <SelectTrigger id="theme" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["light", "dark", "system"].map((value) => (
              <SelectItem key={value} value={value}>
                {t(`theme.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="language">{t("general.language")}</Label>
        <Select
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
            {["en", "de"].map((value) => (
              <SelectItem key={value} value={value}>
                {t(`language.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}
