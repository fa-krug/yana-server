"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveAdvanced } from "@/lib/ai/actions";
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
 * One field, its bounds, and the step its input moves in.
 *
 * `as const` is what keeps `t(\`advanced.${name}\`)` compiler-checked: widened to
 * `string`, the template literal becomes `advanced.${string}`, which matches no
 * catalog key and would render the raw path (see `src/i18n/next-intl.d.ts`).
 * `satisfies` then holds the list to the projection's own field names, so a
 * renamed column fails `npm run typecheck` here rather than at a silently
 * ignored form field.
 *
 * The bounds are a hand-maintained duplicate of `advancedInput` in
 * `@/lib/ai/actions`, where each one carries the reason it is the number it is.
 * Change them together.
 */
const FIELDS = [
  { name: "temperature", min: 0, max: 2, step: 0.1 },
  { name: "maxTokens", min: 1, max: 200_000, step: 1 },
  { name: "dailyLimit", min: 1, max: 100_000, step: 1 },
  { name: "monthlyLimit", min: 1, max: 100_000, step: 1 },
  { name: "maxPromptLength", min: 1, max: 100_000, step: 1 },
  { name: "requestTimeout", min: 5, max: 600, step: 1 },
  { name: "maxRetries", min: 0, max: 10, step: 1 },
  { name: "retryDelay", min: 0, max: 60, step: 1 },
  { name: "requestDelay", min: 0, max: 60, step: 1 },
] as const satisfies readonly { name: keyof AiAdvanced; min: number; max: number; step: number }[];

type FieldName = (typeof FIELDS)[number]["name"];

/** What a number input holds: the typed text, not a number. */
type Draft = Record<FieldName, string>;

function draftFrom(advanced: AiAdvanced): Draft {
  return Object.fromEntries(FIELDS.map(({ name }) => [name, String(advanced[name])])) as Draft;
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
        FIELDS.map(({ name }) => [name, numeric(draft[name])]),
      ) as Record<FieldName, number>;
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("advanced.title")}</CardTitle>
        <CardDescription>{t("advanced.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          {/* One column on a phone, two from `sm:` -- nine labelled numbers in
              one column is a long scroll, and two columns of a 100000-wide
              number do not fit a narrow viewport. */}
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map(({ name, min, max, step }) => (
              <div key={name} className="grid gap-2">
                <Label htmlFor={`ai-${name}`}>{t(`advanced.${name}`)}</Label>
                <Input
                  id={`ai-${name}`}
                  type="number"
                  inputMode="decimal"
                  min={min}
                  max={max}
                  step={step}
                  value={draft[name]}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [name]: event.target.value }))
                  }
                />
                <p className="text-sm text-muted-foreground">{t(`advanced.${name}Help`)}</p>
              </div>
            ))}
          </div>
          <Button type="submit" disabled={pending} className="w-full sm:w-auto">
            {pending ? t("advanced.saving") : t("advanced.save")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
