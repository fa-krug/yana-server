"use client";

import { unstable_rethrow } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition, type ReactElement } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export type ConfirmCopy = {
  /** All three are already translated: only the caller knows what is at stake. */
  title: string;
  description: string;
  confirmLabel: string;
};

/**
 * A confirmation in front of an irreversible action.
 *
 * **It closes only when `onConfirm` resolves.** A rejected promise leaves the
 * dialog standing, so the caller's error message is read against the thing it
 * refers to instead of appearing over a list that looks unchanged -- an
 * operator who sees the dialog vanish concludes the delete worked.
 *
 * The confirm and cancel buttons are both disabled while the promise is in
 * flight, so a second press cannot start a second delete.
 *
 * `trigger` is a `ReactElement`, not the `ReactNode` a first sketch of this
 * component had. Base UI composes through the `render` prop, which takes an
 * element; passing arbitrary children to `<AlertDialogTrigger>` instead would
 * nest the caller's `<Button>` inside the trigger's own `<button>` -- invalid
 * HTML that the browser silently reparents into a hydration mismatch, the same
 * trap `route-breadcrumbs.tsx` documents for `<li>`.
 */
export function ConfirmDestructive({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
}: ConfirmCopy & {
  trigger: ReactElement;
  onConfirm: () => Promise<void>;
}) {
  const tCommon = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  function confirm() {
    // useTransition rather than a hand-rolled `pending` flag, for the reason
    // CLAUDE.md gives: a rejection inside a transition scope escalates to the
    // nearest error boundary rather than becoming a stray unhandled rejection.
    start(async () => {
      try {
        await onConfirm();
        setOpen(false);
      } catch (error) {
        // unstable_rethrow first, always: a `redirect()` or `notFound()` from
        // inside a server action arrives here as a rejection, and swallowing
        // it would cancel a navigation that was working.
        unstable_rethrow(error);
        // Anything else: stay open. Reporting is the caller's -- its
        // `onConfirm` goes through `attempt()` (see @/lib/account/result) --
        // but a promise that rejected *without* reporting would otherwise
        // leave no trace at all.
        console.error("A confirmed action rejected instead of reporting", error);
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      {/* Base UI's `render`, never Radix's `asChild`. */}
      <AlertDialogTrigger render={trigger} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{tCommon("cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={pending} onClick={confirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
