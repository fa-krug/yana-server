"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import { updateLibrarySettings } from "@/lib/settings/actions";
import { attempt } from "@/lib/settings/result";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LibrarySection({
  articleRetentionDays,
  updateIntervalMinutes,
}: {
  articleRetentionDays: number;
  updateIntervalMinutes: number;
}) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const [retention, setRetention] = useState(String(articleRetentionDays));
  // Named updateInterval, not interval: "interval" would shadow the global
  // setInterval() inside this component.
  const [updateInterval, setUpdateInterval] = useState(String(updateIntervalMinutes));
  const [pending, start] = useTransition();

  function save() {
    start(async () => {
      // attempt(), never a bare await: a rejected action inside this transition
      // scope escalates to the (app) group's error.tsx and takes the two
      // half-edited fields with it, and a session that ended is otherwise
      // indistinguishable from a failed request. See @/lib/settings/result.
      const result = await attempt(() =>
        updateLibrarySettings({
          articleRetentionDays: Number(retention),
          updateIntervalMinutes: Number(updateInterval),
        }),
      );
      if (result.ok) {
        toast.success(t("saved"));
      } else {
        toast.error(result.errorKey ? t(result.errorKey) : t("saveFailed"));
      }
    });
  }

  return (
    <LibrarySectionShell
      retentionControl={
        <Input
          id="retention"
          type="number"
          min={1}
          max={3650}
          value={retention}
          onChange={(event) => setRetention(event.target.value)}
          className="w-24"
        />
      }
      intervalControl={
        <Input
          id="interval"
          type="number"
          min={0}
          max={1440}
          value={updateInterval}
          onChange={(event) => setUpdateInterval(event.target.value)}
          className="w-24"
        />
      }
      saveControl={
        <Button onClick={save} disabled={pending} className="w-full sm:w-auto">
          {tCommon("save")}
        </Button>
      }
    />
  );
}

/**
 * The section's chrome alone: the heading, both field labels and their help
 * text, with no dependency on `articleRetentionDays`/`updateIntervalMinutes`
 * -- see the doc comment on `GeneralSectionShell` in `./general-section.tsx`
 * for why `settings/page.tsx` renders this directly as its own `<Suspense>`
 * fallback (with skeleton bars for the three control slots) instead of a
 * generic skeleton block.
 */
export function LibrarySectionShell({
  retentionControl,
  intervalControl,
  saveControl,
}: {
  retentionControl: ReactNode;
  intervalControl: ReactNode;
  saveControl: ReactNode;
}) {
  const t = useTranslations("settings");

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">{t("library.title")}</h2>

      <div className="grid gap-2">
        <Label htmlFor="retention">{t("library.retention")}</Label>
        <div className="flex items-center gap-2">
          {retentionControl}
          <span className="text-sm text-muted-foreground">{t("library.days")}</span>
        </div>
        <p className="text-sm text-muted-foreground">{t("library.retentionHelp")}</p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="interval">{t("library.interval")}</Label>
        <div className="flex items-center gap-2">
          {intervalControl}
          <span className="text-sm text-muted-foreground">{t("library.minutes")}</span>
        </div>
        <p className="text-sm text-muted-foreground">{t("library.intervalHelp")}</p>
      </div>

      {saveControl}
    </section>
  );
}
