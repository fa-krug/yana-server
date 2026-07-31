"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { updateLibrarySettings } from "@/lib/settings/actions";
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
      const result = await updateLibrarySettings({
        articleRetentionDays: Number(retention),
        updateIntervalMinutes: Number(updateInterval),
      });
      if (result.ok) {
        toast.success(t("saved"));
      } else {
        toast.error(result.error ?? t("saveFailed"));
      }
    });
  }

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">{t("library.title")}</h2>

      <div className="grid gap-2">
        <Label htmlFor="retention">{t("library.retention")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="retention"
            type="number"
            min={1}
            max={3650}
            value={retention}
            onChange={(event) => setRetention(event.target.value)}
            className="w-24"
          />
          <span className="text-sm text-muted-foreground">{t("library.days")}</span>
        </div>
        <p className="text-sm text-muted-foreground">{t("library.retentionHelp")}</p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="interval">{t("library.interval")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="interval"
            type="number"
            min={1}
            max={1440}
            value={updateInterval}
            onChange={(event) => setUpdateInterval(event.target.value)}
            className="w-24"
          />
          <span className="text-sm text-muted-foreground">{t("library.minutes")}</span>
        </div>
        <p className="text-sm text-muted-foreground">{t("library.intervalHelp")}</p>
      </div>

      <Button onClick={save} disabled={pending} className="w-full sm:w-auto">
        {tCommon("save")}
      </Button>
    </section>
  );
}
