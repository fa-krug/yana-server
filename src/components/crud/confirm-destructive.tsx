"use client";

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
import { attemptCall } from "@/lib/attempt";

export type ConfirmCopy = {
  /** All three are already translated: only the caller knows what is at stake. */
  title: string;
  description: string;
  confirmLabel: string;
};

/**
 * A confirmation in front of an irreversible action.
 *
 * **It closes only when `onConfirm` resolves `true`.** An operator who sees the
 * dialog vanish concludes the delete worked, so a failure has to leave it
 * standing -- the caller's error toast is then read against the thing it refers
 * to rather than appearing over a list that looks unchanged.
 *
 * **Success is a returned `boolean`, not the absence of a throw**, and that is
 * the whole reason this signature is not `Promise<void>`. Every server action
 * called from a client component here goes through its feature's `attempt()`
 * (`@/lib/attempt`), and `attempt()` **never rejects**: it catches, re-throws
 * only Next's control flow, and *resolves* `{ ok: false, errorKey }`. A
 * conforming caller therefore resolves on failure, so a void contract would
 * close the dialog on exactly the path it exists to keep open. An
 * `{ ok }`-shaped result is the settled convention across every namespace here,
 * so `return result.ok` is all a caller has to do.
 *
 * A **thrown** error still counts as failure and still leaves the dialog open.
 * That is the backstop for a caller who forgot `attempt()`: forgetting it
 * should cost an unreported error in the console, never the dialog. It goes
 * through the same core that `attempt()` does, so the one failure a console
 * line cannot help with -- the session having ended -- still sends the browser
 * to `/login` rather than leaving a dialog standing over a signed-out page.
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
  /** `true` when the action succeeded -- anything else keeps the dialog open. */
  onConfirm: () => Promise<boolean>;
}) {
  const tCommon = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  function confirm() {
    // useTransition rather than a hand-rolled `pending` flag, for the reason
    // CLAUDE.md gives: a rejection inside a transition scope escalates to the
    // nearest error boundary rather than becoming a stray unhandled rejection.
    start(async () => {
      // `attemptCall()` is the same core `attempt()` is built on (`@/lib/attempt`),
      // used here without a namespace: it re-throws Next's control flow before
      // anything else, logs the rejection nobody else will report, and asks
      // whether the session ended. This kit has no catalog of its own, and it
      // does not need one -- the branch that matters here navigates rather than
      // translating.
      const attempted = await attemptCall(onConfirm, {
        label: "A confirmed action rejected instead of reporting",
      });
      // Only `true` closes it. A caller that resolves `false` has already
      // reported the failure and wants the dialog kept, and so does a
      // rejection: that is the backstop path, for a caller that skipped
      // `attempt()`.
      if (attempted.status === "returned" && attempted.result) setOpen(false);
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
