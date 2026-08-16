"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveAdvanced } from "@/lib/ai/actions";
import { AI_ADVANCED_BOUNDS, AI_ADVANCED_FIELDS, type AiAdvancedField } from "@/lib/ai/bounds";
import type { AiAdvanced } from "@/lib/ai/queries";
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

export function AdvancedSection({ advanced }: { advanced: AiAdvanced }) {
  const t = useTranslations("ai");
  const [draft, setDraft] = useState<Draft>(() => draftFrom(advanced));
  const [pending, start] = useTransition();

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
        onChange={(event) => setDraft((current) => ({ ...current, [name]: event.target.value }))}
      />,
    ]),
  ) as Record<AiAdvancedField, ReactNode>;

  return (
    <AdvancedSectionShell
      controls={controls}
      saveControl={
        <Button type="submit" disabled={pending} className="w-full sm:w-auto">
          {pending ? t("advanced.saving") : t("advanced.save")}
        </Button>
      }
      onSubmit={save}
    />
  );
}

/**
 * The card's chrome alone: the heading, every field's label and help text, and
 * the grid they sit in -- with no dependency on `advanced`, so
 * `src/app/(app)/ai/page.tsx` can render this directly as its own `<Suspense>`
 * fallback (with a skeleton bar standing in for each of the nine inputs and the
 * Save button) instead of an anonymous skeleton block. See the doc comment on
 * `GeneralSectionShell` in `../settings/general-section.tsx` for why this split
 * exists.
 *
 * The `<form>` lives here rather than in `<AdvancedSection>`, exactly as in
 * `<ProviderSectionShell>` below its sibling file: `onSubmit` is just a
 * callback the shell forwards, so keeping the element here is what lets the
 * fallback lay out identically to the resolved render without a form of its
 * own ever being submitted.
 */
export function AdvancedSectionShell({
  controls,
  saveControl,
  // Optional, and defaulted here rather than by the caller -- see the same
  // comment on `ProviderSectionShell` in `./provider-section.tsx`: a Server
  // Component fallback cannot pass a function across the RSC boundary, so it
  // passes nothing and this "use client" module supplies the no-op.
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
