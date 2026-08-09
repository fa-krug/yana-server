import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { JobActions } from "@/components/jobs/job-actions";
import { JobLogViewer } from "@/components/jobs/job-log-viewer";
import { StatusBadge } from "@/components/jobs/jobs-table";
import { isAdminRole } from "@/lib/auth/roles";
import { requireUserFreshRole } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { articles, feeds } from "@/lib/db/schema";
import { getJob, listJobLogs } from "@/lib/jobs/queue";

export default async function JobDetailPage({
  params,
}: {
  // Structural, not the generated `PageProps<"/jobs/[id]">` -- see
  // src/app/(app)/users/[id]/page.tsx for why.
  params: Promise<{ id: string }>;
}) {
  /** The gate, first -- `requireUserFreshRole()` awaits `headers()`, opting this
   *  route out of static prerendering the same way src/app/(app)/users/[id]/page.tsx
   *  does with requireAdmin(); see the connection() bullet in CLAUDE.md. It reads
   *  `role` fresh rather than from the session cookie cache, because whether this
   *  page shows someone else's job is an authority decision -- see the doc
   *  comment on `requireUserFreshRole()` in src/lib/auth/session.ts. */
  const user = await requireUserFreshRole();
  const admin = isAdminRole(user.role);

  const { id } = await params;
  const jobId = Number.isInteger(Number(id)) ? Number(id) : null;
  const job = jobId !== null ? getJob(jobId) : null;
  if (!job || (!admin && job.userId !== user.id)) notFound();

  const logs = listJobLogs(job.id);
  const t = await getTranslations("jobs");

  const feedId = Number(job.payload?.feedId);
  const feed = feedId
    ? getDb()
        .select({ id: feeds.id, name: feeds.name })
        .from(feeds)
        .where(eq(feeds.id, feedId))
        .get()
    : undefined;

  const articleId = Number(job.payload?.articleId);
  const article = articleId
    ? getDb()
        .select({ id: articles.id, name: articles.name })
        .from(articles)
        .where(eq(articles.id, articleId))
        .get()
    : undefined;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{t("detailTitle", { id: job.id })}</h1>
        <JobActions job={{ id: job.id, status: job.status }} />
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">{t("kind")}</dt>
          <dd className="font-mono">{job.kind}</dd>
        </div>
        {feedId > 0 && (
          <div>
            <dt className="text-muted-foreground">{t("feed")}</dt>
            <dd>
              {feed ? (
                <Link href={`/feeds/${feed.id}`} className="hover:underline">
                  {feed.name}
                </Link>
              ) : (
                <span className="text-muted-foreground">{t("feedGone", { id: feedId })}</span>
              )}
            </dd>
          </div>
        )}
        {articleId > 0 && (
          <div>
            <dt className="text-muted-foreground">{t("article")}</dt>
            <dd>
              {article ? (
                <Link href={`/articles/${article.id}`} className="hover:underline">
                  {article.name}
                </Link>
              ) : (
                <span className="text-muted-foreground">{t("articleGone", { id: articleId })}</span>
              )}
            </dd>
          </div>
        )}
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
