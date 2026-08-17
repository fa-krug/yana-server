import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { JobActions } from "@/components/jobs/job-actions";
import { JobLogViewer } from "@/components/jobs/job-log-viewer";
import { StatusBadge } from "@/components/jobs/jobs-table";
import { getDb } from "@/lib/db/client";
import { articles, feeds } from "@/lib/db/schema";
import { getJobForCurrentUser } from "@/lib/jobs/queries";
import { listJobLogs } from "@/lib/jobs/queue";

export default async function JobDetailPage({
  params,
}: {
  // Structural, not the generated `PageProps<"/jobs/[id]">` -- see
  // src/app/(app)/users/[id]/page.tsx for why.
  params: Promise<{ id: string }>;
}) {
  /**
   * **No `requireUserFreshRole()` here any more -- `getJobForCurrentUser()`
   * carries it**, together with the ownership rule this page used to apply
   * itself (`!admin && job.userId !== user.id`). Both moved into
   * `src/lib/jobs/queries.ts`, so the answer for another user's job and for an
   * ownerless one is decided where the row is read rather than by a page body
   * remembering to compare ids. The role behind that decision is still read
   * with `disableCookieCache: true`, so a demoted admin loses cross-user
   * visibility at once -- see the doc comment on `requireUserFreshRole()` in
   * src/lib/auth/session.ts.
   *
   * It is also still what opts this route out of static prerendering: the gate
   * awaits `headers()` before anything reaches SQLite, so no `connection()`
   * call is needed (see the connection() bullet in CLAUDE.md).
   *
   * The record read stays here, at the top and outside every `<Suspense>`
   * boundary, because `notFound()` can only produce a real 404 while the
   * response status is still open.
   */
  const { id } = await params;
  const jobId = Number.isInteger(Number(id)) ? Number(id) : null;
  const job = jobId !== null ? await getJobForCurrentUser(jobId) : null;
  if (!job) notFound();

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
