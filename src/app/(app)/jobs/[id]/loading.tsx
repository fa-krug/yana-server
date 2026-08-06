import { Skeleton } from "@/components/ui/skeleton";

/**
 * The route's own fallback, replacing `(app)/loading.tsx`'s generic
 * `<TableSkeleton>` for this segment specifically. `JobDetailPage` awaits
 * `requireUserFreshRole()` and then `getJob()`/`listJobLogs()` before
 * returning any JSX, so without this file a navigation to `/jobs/[id]` shows
 * the group's unrelated fallback for however long that takes.
 *
 * The real title is `t("detailTitle", { id: job.id })` -- it needs the
 * fetched job's id, so a `<Skeleton>` bar stands in for it rather than
 * translated text around a placeholder id. Below it: a bar for `<JobActions>`,
 * a `grid-cols-2 sm:grid-cols-3` grid of label+value skeleton pairs matching
 * the real `<dl>` (kind, feed, status, attempts, progress, createdAt), and a
 * large block standing in for `<JobLogViewer>`.
 */
export default function Loading() {
  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-9 w-24" />
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-4 w-20" />
          </div>
        ))}
      </div>

      <div>
        <Skeleton className="mb-2 h-4 w-12" />
        <Skeleton className="h-64 w-full" />
      </div>
    </div>
  );
}
