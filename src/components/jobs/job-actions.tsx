"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { ConfirmDestructive } from "@/components/crud/confirm-destructive";
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

  async function deleteThisJob(): Promise<boolean> {
    const result = await attempt(() => deleteJobs([job.id]));
    if (!result.ok) {
      toast.error(t(result.errorKey));
      return false;
    }

    let deleted = result.deleted;
    if (result.stopping.length > 0) {
      const stopped = await waitForJobsTerminal(result.stopping);
      if (!stopped) {
        toast.error(t("requestFailed"));
        return false;
      }
      const second = await attempt(() => deleteJobs(result.stopping));
      if (!second.ok) {
        toast.error(t(second.errorKey));
        return false;
      }
      deleted += second.deleted;
    }

    toast.success(t("deleted", { count: deleted }));
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
