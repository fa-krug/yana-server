"use client";

import { Suspense, use } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { RecordNotFound } from "@/components/record-not-found";
import type { JobStatus } from "@/lib/db/schema/enums";
import { JobActions } from "./job-actions";
import { JobLogViewer, type JobLogLine } from "./job-log-viewer";
import { StatusBadge } from "./jobs-table";

/**
 * The columns this view renders, never the whole `Job` row -- see CLAUDE.md's
 * "a component gets the columns it renders, never the row". The full row
 * also carries `payload`, `error`, `userId`, `runId`,
 * `runAt`/`startedAt`/`finishedAt`, `priority` and `updatedAt`, none of which
 * appear below; a promise resolving to the whole row would still serialize
 * all of them into this page's RSC payload the moment it crosses into this
 * Client Component. `/users/[id]`'s `UserRecord` and `/feeds`' `FeedListRow`
 * are the same projection discipline.
 */
export type JobSummary = {
  id: number;
  kind: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  progress: number;
  createdAt: Date;
};

/** What `/jobs/[id]/page.tsx` reads and hands down as one promise, so the
 * page body awaits nothing -- see `EditFeedResolved`'s equivalent comment
 * for the shape this belongs to. */
export type JobDetail = {
  job: JobSummary;
  logs: JobLogLine[];
  feedId: number;
  feed: { id: number; name: string } | undefined;
  articleId: number;
  article: { id: number; name: string } | undefined;
};

/**
 * Calls `use()` on the one promise `/jobs/[id]/page.tsx` hands down; suspends
 * until it settles; renders either the real detail view or the not-found
 * state.
 *
 * `jobDetailPromise` resolves to `null` for a nonexistent id, an id owned by
 * someone else, **and** an ownerless job (`retention`) viewed by a
 * non-admin -- `getJobForCurrentUser()` already collapses all three to the
 * same `null` (see its own doc comment in `src/lib/jobs/queries.ts`), and
 * this component must keep them indistinguishable: no message here may name
 * which of the three it was, or the not-found state becomes an ownership
 * enumeration oracle for someone probing job ids.
 */
function JobDetailResolved({ jobDetailPromise }: { jobDetailPromise: Promise<JobDetail | null> }) {
  const detail = use(jobDetailPromise);
  const t = useTranslations("jobs");

  if (!detail) {
    return <RecordNotFound />;
  }

  const { job, logs, feedId, feed, articleId, article } = detail;

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-end">
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
        <JobLogViewer jobId={job.id} initialLines={logs} />
      </div>
    </div>
  );
}

/**
 * What `/jobs/[id]/page.tsx` renders. There is no page `<h1>` (the
 * breadcrumb already names the route), and every field here -- status,
 * attempts, the log -- needs the job row, so unlike the CRUD detail routes
 * there is no reusable "real chassis, disabled" form to fall back to. Per the
 * instant-render plan's "do not leave a skeleton bar for it" rule, the
 * fallback is simply nothing: the whole detail view appears at once, already
 * filled in, once `JobDetailResolved` resolves -- which for a local SQLite
 * read is not a perceptible wait. This replaces `/jobs/[id]/loading.tsx`,
 * deleted along with this component: the page body that renders this awaits
 * nothing, so that route-level fallback is unreachable now.
 */
export function JobDetailSection({
  jobDetailPromise,
}: {
  jobDetailPromise: Promise<JobDetail | null>;
}) {
  return (
    <Suspense fallback={null}>
      <JobDetailResolved jobDetailPromise={jobDetailPromise} />
    </Suspense>
  );
}
