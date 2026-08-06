"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import { updateLibrarySettings } from "@/lib/settings/actions";
import { attempt } from "@/lib/settings/result";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LibrarySection({ articleRetentionDays }: { articleRetentionDays: number }) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const [retention, setRetention] = useState(String(articleRetentionDays));
  const [pending, start] = useTransition();

  function save() {
    start(async () => {
      // attempt(), never a bare await: a rejected action inside this transition
      // scope escalates to the (app) group's error.tsx and takes the
      // half-edited field with it, and a session that ended is otherwise
      // indistinguishable from a failed request. See @/lib/settings/result.
      const result = await attempt(() =>
        updateLibrarySettings({ articleRetentionDays: Number(retention) }),
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
      saveControl={
        <Button onClick={save} disabled={pending} className="w-full sm:w-auto">
          {tCommon("save")}
        </Button>
      }
    />
  );
}

/**
 * The section's chrome alone: the heading, the field's label and help text,
 * with no dependency on `articleRetentionDays` -- see the doc comment on
 * `GeneralSectionShell` in `./general-section.tsx` for why `settings/page.tsx`
 * renders this directly as its own `<Suspense>` fallback (with a skeleton bar
 * standing in for the control slot) instead of a generic skeleton block.
 */
export function LibrarySectionShell({
  retentionControl,
  saveControl,
}: {
  retentionControl: ReactNode;
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

      {saveControl}
    </section>
  );
}
