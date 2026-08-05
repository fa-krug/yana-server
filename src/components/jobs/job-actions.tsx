"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { ConfirmDestructive } from "@/components/crud/confirm-destructive";
import { useTrackBackgroundTask } from "@/components/jobs/active-runs-context";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cancelJobs, deleteJobs } from "@/lib/jobs/actions";
import { attempt } from "@/lib/jobs/result";
import { waitForJobsTerminal } from "@/lib/jobs/wait-for-jobs-terminal";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** The Cancel/Delete controls for one job's detail page. Takes only the two
 * columns it renders, never the whole `Job` row -- see the CLAUDE.md rule on
 * component props. */
export function JobActions({ job }: { job: { id: number; status: string } }) {
  const t = useTranslations("jobs");
  const router = useRouter();
  const trackBackgroundTask = useTrackBackgroundTask();
  const [cancelling, startCancel] = useTransition();

  function cancelThisJob(): void {
    startCancel(async () => {
      const result = await attempt(() => cancelJobs([job.id]));
      if (!result.ok) {
        toast.error(t(result.errorKey));
        return;
      }

      router.refresh();
      if (result.affected === 0) toast.info(t("cancelNone"));
      else toast.success(t("cancelRequested", { count: result.affected }));
    });
  }

  /**
   * The follow-up for a job `deleteJobs()` could only ask to stop --
   * tracked via `trackBackgroundTask()` (see `jobs-table.tsx`'s copy of this
   * same comment) so the confirmation dialog closes and this page navigates
   * away immediately rather than waiting for the job to actually stop.
   */
  async function finishStoppingDeletion(jobId: number): Promise<void> {
    const stopped = await waitForJobsTerminal([jobId]);
    if (!stopped) {
      toast.error(t("requestFailed"));
      return;
    }
    const second = await attempt(() => deleteJobs([jobId]));
    if (!second.ok) {
      toast.error(t(second.errorKey));
      return;
    }
    router.refresh();
    toast.success(t("deleted", { count: second.deleted }));
  }

  async function deleteThisJob(): Promise<boolean> {
    const result = await attempt(() => deleteJobs([job.id]));
    if (!result.ok) {
      toast.error(t(result.errorKey));
      return false;
    }

    if (result.stopping.length > 0) {
      trackBackgroundTask(finishStoppingDeletion(job.id));
    } else {
      toast.success(t("deleted", { count: result.deleted }));
    }
    router.push("/jobs");
    return true;
  }

  return (
    <div className="flex gap-2">
      {!TERMINAL_STATUSES.has(job.status) && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={cancelThisJob}
          disabled={cancelling}
        >
          {cancelling && <Spinner className="mr-1" />}
          {t("bulkCancel")}
        </Button>
      )}
      <ConfirmDestructive
        trigger={
          <Button type="button" variant="destructive" size="sm">
            {t("bulkDelete")}
          </Button>
        }
        title={t("bulkDeleteTitle", { count: 1 })}
        description={t("bulkDeleteDescription", { count: 1 })}
        confirmLabel={t("deleteConfirm")}
        onConfirm={deleteThisJob}
      />
    </div>
  );
}
