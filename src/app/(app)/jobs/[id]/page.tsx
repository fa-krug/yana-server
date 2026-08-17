import { eq } from "drizzle-orm";
import { connection } from "next/server";

import { JobDetailSection, type JobDetail } from "@/components/jobs/job-detail-section";
import { getDb } from "@/lib/db/client";
import { articles, feeds } from "@/lib/db/schema";
import { getJobForCurrentUser } from "@/lib/jobs/queries";
import { listJobLogs } from "@/lib/jobs/queue";

/**
 * The instant-render-no-fallback migration (see
 * `src/app/(app)/settings/page.tsx`): this page body awaits nothing, so it
 * cannot suspend and `loading.tsx` -- deleted along with this rewrite -- is
 * unreachable.
 *
 * `requireUserFreshRole()` was already gone from this page body before this
 * rewrite -- `getJobForCurrentUser()` carries it, together with the
 * ownership rule (`!admin && job.userId !== user.id`). What this rewrite
 * removes is the **await**: the whole read (job, its logs, the feed/article
 * it references) is now built as one promise and handed to
 * `<JobDetailSection>`, consumed with `use()` there.
 *
 * **This route therefore no longer answers 404.** A nonexistent id, someone
 * else's job, and (for a non-admin) an ownerless job all render the same
 * not-found state once the promise resolves to `null` -- exactly the
 * indistinguishability `getJobForCurrentUser()` already guarantees at the
 * data layer, preserved rather than reintroduced here (see its own doc
 * comment and `RecordNotFound`'s). This was a deliberate,
 * explicitly-approved trade-off, not an oversight.
 */
export default function JobDetailPage({
  params,
}: {
  // Structural, not the generated `PageProps<"/jobs/[id]">` -- see
  // src/app/(app)/users/[id]/page.tsx for why.
  params: Promise<{ id: string }>;
}) {
  /**
   * Opt this route out of prerendering -- **called, not awaited**, exactly as
   * `SettingsPage`/`AccountPage` do: `getJobForCurrentUser()` below is never
   * awaited by this page body, so there is no other awaited Dynamic API left
   * here to do this job. (Previously `requireUserFreshRole()`'s own
   * `headers()` read did this instead -- it moved into `getJobForCurrentUser()`
   * itself, one layer further from this page body.)
   */
  connection();

  // Not awaited: chained onto the `params` promise instead, so this page
  // body still awaits nothing. Everything the detail view needs -- the job,
  // its logs, and the feed/article it references -- is resolved as one
  // promise so `<JobDetailSection>` only has one thing to `use()`.
  const jobDetailPromise: Promise<JobDetail | null> = params.then(async ({ id }) => {
    const jobId = Number.isInteger(Number(id)) ? Number(id) : null;
    const job = jobId !== null ? await getJobForCurrentUser(jobId) : null;
    if (!job) return null;

    const logs = listJobLogs(job.id).map((line) => ({
      id: line.id,
      stream: line.stream as "stdout" | "stderr",
      line: line.line,
      createdAt: line.createdAt.toISOString(),
    }));

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

    return { job, logs, feedId, feed, articleId, article };
  });

  return <JobDetailSection jobDetailPromise={jobDetailPromise} />;
}
