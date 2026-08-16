"use client";

import { useTranslations } from "next-intl";
import { Suspense, use, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveAdvanced } from "@/lib/ai/actions";
import { AI_ADVANCED_BOUNDS, AI_ADVANCED_FIELDS, type AiAdvancedField } from "@/lib/ai/bounds";
import type { AiAdvanced, AiStatus } from "@/lib/ai/queries";
import { attempt } from "@/lib/ai/result";

/**
 * The nine global tuning values, saved as one unit.
 *
 * **One Save for the whole card, not one per field, because the values are
 * interdependent.** `monthlyLimit >= dailyLimit` is a rule about a *pair*, so a
 * field that saved itself could never state it: lowering the monthly cap first
 * would be refused against a daily cap the operator is about to lower too. The
 * server checks the pair in one `.superRefine()` (`@/lib/ai/actions`) and this
 * card submits the pair.
 *
 * **`min`/`max` on the inputs are a convenience, never the check.** They are the
 * same bounds the server enforces, spelled out here so a browser can catch a
 * typo without a round trip -- but a number input accepts an out-of-range value
 * typed by hand and `saveAdvanced()` is what refuses it, with a catalog key that
 * names the range.
 *
 * ## Why the state is strings
 *
 * `<input type="number">` reports a string, and every intermediate keystroke of
 * a real edit is one: `""` while the field is being cleared, `"1."` on the way
 * to `1.5`. Holding numbers would mean coercing on every change, which turns an
 * empty field into `0` and silently saves it -- `0` is a *valid* temperature, so
 * nothing would refuse it. {@link numeric} maps an empty field to `NaN`
 * instead, which zod rejects, and the operator is told which field and what its
 * range is.
 *
 * ## The `…Form` / `…Resolved` / `…Section({ promise })` split
 *
 * `advanced` is now optional, and `pending` (paired with it being `undefined`)
 * means "not loaded yet" -- the same shape
 * `@/components/settings/library-section.tsx` establishes. Unlike the provider
 * card, this needs no separate pending branch: `min`/`max`/`step` come from
 * `AI_ADVANCED_BOUNDS`, which is dependency-free and needs no query, so every
 * one of the nine inputs already renders with its real bounds regardless of
 * `advanced` -- only the *value* differs, an empty draft rather than one seeded
 * from a loaded row, and `disabled` follows `pending` the same way it follows
 * `saving`.
 */

/**
 * The step a field's input moves in, from the one fact the server also reads.
 *
 * **Nothing about a bound is written in this file.** `min`, `max` and `integer`
 * come from `AI_ADVANCED_BOUNDS`, which `@/lib/ai/actions` builds its zod schema
 * out of, so the browser's hint and the server's rule are the same numbers by
 * construction. They used to be two lists that merely agreed.
 */
function stepFor(name: AiAdvancedField): number {
  return AI_ADVANCED_BOUNDS[name].integer ? 1 : 0.1;
}

/** What a number input holds: the typed text, not a number. */
type Draft = Record<AiAdvancedField, string>;

function draftFrom(advanced: AiAdvanced): Draft {
  return Object.fromEntries(
    AI_ADVANCED_FIELDS.map((name) => [name, String(advanced[name])]),
  ) as Draft;
}

/** The pending draft: every field empty, since no row has loaded yet. */
function emptyDraft(): Draft {
  return Object.fromEntries(AI_ADVANCED_FIELDS.map((name) => [name, ""])) as Draft;
}

/**
 * A field's text as the number the action expects.
 *
 * An empty field is `NaN`, deliberately: `Number("")` is `0`, and `0` is a value
 * several of these accept, so coercing would save a number the operator never
 * typed. zod refuses `NaN` and the reply names the field.
 */
function numeric(value: string): number {
  return value.trim() === "" ? Number.NaN : Number(value);
}

export function AdvancedSectionForm({
  advanced,
  pending = false,
}: {
  advanced?: AiAdvanced;
  pending?: boolean;
}) {
  const t = useTranslations("ai");
  const [draft, setDraft] = useState<Draft>(() => (advanced ? draftFrom(advanced) : emptyDraft()));
  const [saving, start] = useTransition();

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    start(async () => {
      const values = Object.fromEntries(
        AI_ADVANCED_FIELDS.map((name) => [name, numeric(draft[name])]),
      ) as AiAdvanced;
      // Through `attempt()`, never a bare await: an action can fail without
      // returning, and the rejection would escalate to the (app) error boundary
      // and replace the page along with the nine half-edited fields.
      const result = await attempt(() => saveAdvanced(values));
      if (result.ok) {
        toast.success(t("advanced.saved"));
      } else {
        toast.error(t(result.errorKey ?? "saveFailed"));
      }
    });
  }

  // Bounds come from `AI_ADVANCED_BOUNDS`, which is dependency-free and needs
  // no query, so every input renders with its real `min`/`max`/`step`
  // regardless of `pending` -- only the value (empty until a row has loaded)
  // and `disabled` depend on it.
  const controls = Object.fromEntries(
    AI_ADVANCED_FIELDS.map((name) => [
      name,
      <Input
        key={name}
        id={`ai-${name}`}
        type="number"
        inputMode="decimal"
        min={AI_ADVANCED_BOUNDS[name].min}
        max={AI_ADVANCED_BOUNDS[name].max}
        step={stepFor(name)}
        value={draft[name]}
        disabled={pending}
        onChange={(event) => setDraft((current) => ({ ...current, [name]: event.target.value }))}
      />,
    ]),
  ) as Record<AiAdvancedField, ReactNode>;

  return (
    <AdvancedSectionShell
      controls={controls}
      saveControl={
        <Button type="submit" disabled={pending || saving} className="w-full sm:w-auto">
          {saving ? t("advanced.saving") : t("advanced.save")}
        </Button>
      }
      onSubmit={pending ? undefined : save}
    />
  );
}

/**
 * The card's chrome alone: the heading, every field's label and help text, and
 * the grid they sit in -- with no dependency on `advanced`, so
 * `<AdvancedSectionForm>` can render it for both its resolved state and its
 * `pending` one from the same markup.
 *
 * **Deliberately not exported.** Only `<AdvancedSectionForm>` in this file
 * renders it, and that is the whole point of the arrangement: the pending
 * fallback is that form with `pending`, never this shell reached for directly
 * from a page. `../settings/general-section.tsx` and
 * `../integrations/youtube-section.tsx` needed no shell split at all once
 * their pending and resolved renders converged on one component.
 *
 * The `<form>` lives here rather than in `<AdvancedSectionForm>`, exactly as
 * in `ProviderSectionShell` in its sibling file: `onSubmit` is just a
 * callback the shell forwards, so keeping the element here is what lets the
 * pending render lay out identically to the resolved one without a form of
 * its own ever being submitted.
 */
function AdvancedSectionShell({
  controls,
  saveControl,
  // Optional, defaulted to a no-op: `<AdvancedSectionForm>`'s `pending`
  // branch renders this shell with no `onSubmit` at all, the same reasoning
  // `ProviderSectionShell` in `./provider-section.tsx` carries.
  onSubmit = (event) => event.preventDefault(),
}: {
  controls: Record<AiAdvancedField, ReactNode>;
  saveControl: ReactNode;
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
}) {
  const t = useTranslations("ai");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("advanced.title")}</CardTitle>
        <CardDescription>{t("advanced.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          {/* One column on a phone, two from `sm:` -- nine labelled numbers in
              one column is a long scroll, and two columns of a 100000-wide
              number do not fit a narrow viewport. */}
          <div className="grid gap-4 sm:grid-cols-2">
            {AI_ADVANCED_FIELDS.map((name) => (
              <div key={name} className="grid gap-2">
                <Label htmlFor={`ai-${name}`}>{t(`advanced.${name}`)}</Label>
                {controls[name]}
                <p className="text-sm text-muted-foreground">{t(`advanced.${name}Help`)}</p>
              </div>
            ))}
          </div>
          {saveControl}
        </form>
      </CardContent>
    </Card>
  );
}

/** Calls use(); suspends until the promise resolves; renders the form for real. */
function AdvancedSectionResolved({ promise }: { promise: Promise<AiStatus> }) {
  const status = use(promise);
  return <AdvancedSectionForm advanced={status.advanced} />;
}

/**
 * What the page renders. The fallback is the real form, in its pending
 * state -- see the Design Reference in
 * docs/superpowers/plans/2026-08-16-streaming-controls-migration.md -- so the
 * heading, every label, help text and all nine inputs (with their real bounds
 * already set) are on screen, disabled, from the first frame and only the
 * stored values stream in afterward.
 *
 * `promise` is the whole `AiStatus` `getAiStatus()` resolves to, shared with
 * `<ProviderSection>` -- see that component's doc comment in
 * `./provider-section.tsx` for why one promise serves both.
 */
export function AdvancedSection({ promise }: { promise: Promise<AiStatus> }) {
  return (
    <Suspense fallback={<AdvancedSectionForm pending />}>
      <AdvancedSectionResolved promise={promise} />
    </Suspense>
  );
}
