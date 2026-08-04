import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { JobLogViewer } from "@/components/jobs/job-log-viewer";
import { StatusBadge } from "@/components/jobs/jobs-table";
import { requireUser } from "@/lib/auth/session";
import { getJob, listJobLogs } from "@/lib/jobs/queue";

export default async function JobDetailPage({
  params,
}: {
  // Structural, not the generated `PageProps<"/jobs/[id]">` -- see
  // src/app/(app)/users/[id]/page.tsx for why.
  params: Promise<{ id: string }>;
}) {
  /** The gate, first -- `requireUser()` awaits `headers()`, opting this route
   *  out of static prerendering the same way src/app/(app)/users/[id]/page.tsx
   *  does with requireAdmin(); see the connection() bullet in CLAUDE.md. */
  await requireUser();

  const { id } = await params;
  const jobId = Number(id);
  const job = Number.isInteger(jobId) ? getJob(jobId) : null;
  if (!job) notFound();

  const logs = listJobLogs(job.id);
  const t = await getTranslations("jobs");

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("detailTitle", { id: job.id })}</h1>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">{t("kind")}</dt>
          <dd className="font-mono">{job.kind}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("status")}</dt>
          <dd>
            <StatusBadge status={job.status} />
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("attempts")}</dt>
          <dd>
            {job.attempts} / {job.maxAttempts}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("progress")}</dt>
          <dd>{job.progress}%</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t("createdAt")}</dt>
          <dd>{job.createdAt.toLocaleString()}</dd>
        </div>
      </dl>

      <div>
        <h2 className="mb-2 text-sm font-medium">{t("log")}</h2>
        <JobLogViewer
          jobId={job.id}
          initialLines={logs.map((line) => ({
            id: line.id,
            stream: line.stream as "stdout" | "stderr",
            line: line.line,
            createdAt: line.createdAt.toISOString(),
          }))}
        />
      </div>
    </div>
  );
}
