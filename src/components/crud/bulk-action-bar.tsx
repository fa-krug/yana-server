"use client";

import { unstable_rethrow } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

import { ConfirmDestructive, type ConfirmCopy } from "@/components/crud/confirm-destructive";
import { Button } from "@/components/ui/button";

/**
 * One action offered for the current selection.
 *
 * `label` is already translated -- the kit cannot know a caller's verbs.
 *
 * **`run` resolves `true` on success**, matching `<ConfirmDestructive>`'s
 * `onConfirm` because a destructive action's `run` *is* that `onConfirm`. The
 * two must agree or the dialog closes on failure: `attempt()`
 * (`@/lib/account/result`) never rejects -- it resolves `{ ok: false }` -- so
 * "did not throw" is not evidence that anything worked. `return result.ok` is
 * the whole of a caller's obligation; phase 5's task 4 makes that result shape
 * the shared convention for this kit's callers.
 *
 * **A destructive action must carry its confirmation copy**, which is why this
 * is a union rather than a flat `destructive?: boolean`. The brief's rule is
 * that destructive actions route through `<ConfirmDestructive>`, and that
 * dialog needs words the kit cannot invent: "this also removes 402 articles"
 * is the entire reason the confirmation exists, and a generic "are you sure?"
 * would be worse than none. Encoding it in the type makes a destructive action
 * with no confirmation a `npm run typecheck` failure rather than a silent
 * delete-on-first-click.
 */
export type BulkAction = {
  key: string;
  label: string;
  /** `true` when the action succeeded. A destructive action's dialog reads it. */
  run: () => Promise<boolean>;
} & ({ destructive?: false | undefined } | { destructive: true; confirm: ConfirmCopy });

/**
 * The bar that appears once rows are selected.
 *
 * It renders nothing at all when the selection is empty, so a caller can mount
 * it unconditionally. On a phone it sticks to the bottom of the viewport --
 * the selection is made by scrolling a long list, and an action bar that
 * scrolled away with the first row would be unreachable by the time the last
 * one is ticked. From `sm` up it sits inline above the table.
 *
 * The count is spelled out rather than implied: it is the operator's only
 * check that the selection matches what they think they picked, especially
 * after paging.
 */
export function BulkActionBar({
  count,
  actions,
  onClear,
}: {
  count: number;
  actions: BulkAction[];
  onClear: () => void;
}) {
  const t = useTranslations("crud");
  const [pending, start] = useTransition();

  function run(action: BulkAction) {
    // Same shape as ConfirmDestructive's: a transition scope, unstable_rethrow
    // first, and nothing swallowed silently. The resolved boolean is ignored
    // here on purpose -- there is no dialog to keep open, and reporting the
    // failure was the caller's job either way.
    start(async () => {
      try {
        await action.run();
      } catch (error) {
        unstable_rethrow(error);
        console.error("A bulk action rejected instead of reporting", error);
      }
    });
  }

  if (count === 0) return null;

  return (
    <div className="sticky bottom-0 z-10 -mx-2 flex flex-wrap items-center gap-2 border-t bg-background/95 px-2 py-2 backdrop-blur-sm sm:static sm:mx-0 sm:rounded-lg sm:border sm:px-3">
      <span className="text-sm font-medium">{t("selectedCount", { count })}</span>
      <Button type="button" variant="ghost" size="sm" onClick={onClear} disabled={pending}>
        {t("clearSelection")}
      </Button>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {actions.map((action) =>
          action.destructive ? (
            <ConfirmDestructive
              key={action.key}
              trigger={
                <Button type="button" variant="destructive" size="sm" disabled={pending}>
                  {action.label}
                </Button>
              }
              title={action.confirm.title}
              description={action.confirm.description}
              confirmLabel={action.confirm.confirmLabel}
              onConfirm={action.run}
            />
          ) : (
            <Button
              key={action.key}
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => run(action)}
            >
              {action.label}
            </Button>
          ),
        )}
      </div>
    </div>
  );
}
