"use client";

import { useTranslations } from "next-intl";
import { Suspense, use, useState, useTransition } from "react";
import { toast } from "sonner";

import { updateLibrarySettings } from "@/lib/settings/actions";
import { attempt } from "@/lib/settings/result";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The presentational form: heading, field, label and help text, all with no
 * dependency on `articleRetentionDays` beyond what to show in the input.
 * `articleRetentionDays === undefined` (paired with `pending`) is the "not
 * loaded yet" state -- the real control renders disabled with an empty value
 * rather than a `<Skeleton>` standing in for it, so the chrome and the control
 * never visually appear or disappear once the value arrives.
 */
export function LibrarySectionForm({
  articleRetentionDays,
  pending = false,
}: {
  articleRetentionDays?: number;
  pending?: boolean;
}) {
  const t = useTranslations("settings");
  const tCommon = useTranslations("common");
  const [retention, setRetention] = useState(
    articleRetentionDays === undefined ? "" : String(articleRetentionDays),
  );
  const [saving, start] = useTransition();

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
            disabled={pending}
            className="w-24"
          />
          <span className="text-sm text-muted-foreground">{t("library.days")}</span>
        </div>
        <p className="text-sm text-muted-foreground">{t("library.retentionHelp")}</p>
      </div>

      <Button onClick={save} disabled={pending || saving} className="w-full sm:w-auto">
        {tCommon("save")}
      </Button>
    </section>
  );
}

/** Calls use(); suspends until the promise resolves; renders the form for real. */
function LibrarySectionResolved({
  promise,
}: {
  promise: Promise<{ articleRetentionDays: number }>;
}) {
  const settings = use(promise);
  return <LibrarySectionForm articleRetentionDays={settings.articleRetentionDays} />;
}

/**
 * What the page renders. The fallback is the real form, in its pending
 * state -- see the Design Reference in
 * docs/superpowers/plans/2026-08-16-streaming-controls-migration.md -- so the
 * heading, label and help text are on screen from the first frame and only
 * the retention value streams in afterward.
 */
export function LibrarySection({
  promise,
}: {
  promise: Promise<{ articleRetentionDays: number }>;
}) {
  return (
    <Suspense fallback={<LibrarySectionForm pending />}>
      <LibrarySectionResolved promise={promise} />
    </Suspense>
  );
}
