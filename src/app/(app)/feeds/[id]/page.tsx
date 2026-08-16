import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { SetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { EditFeedForm } from "@/components/feeds/feed-form";
import { requireUser } from "@/lib/auth/session";
import { getFeed, capabilitiesFor } from "@/lib/feeds/actions";
import { listTags } from "@/lib/tags/queries";

export default async function EditFeedPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();

  const id = Number((await params).id);
  /**
   * Read here, awaited -- it decides the 404, and `notFound()` can only
   * produce one while the response status is still open, so this cannot
   * move into a `<Suspense>` boundary (see CLAUDE.md's `connection()`/detail
   * route rule). `capabilitiesFor()`/`listTags()` below are the secondary
   * lookups, and neither decides the status, so both stay unawaited promises
   * instead of lengthening this one indexed read.
   */
  const feed = await getFeed(id);

  if (!feed) {
    notFound();
  }

  const t = await getTranslations("feeds");
  const capabilitiesPromise = capabilitiesFor();
  // Fetch all tags (assume max 1000 is enough for the form)
  const allTagsPromise = listTags({
    q: "",
    page: 1,
    pageSize: 1000,
    sort: "name",
    dir: "asc",
    filters: {},
  }).then((res) => res.rows);

  return (
    <div className="space-y-4">
      <SetBreadcrumbTitle title={feed.name} />
      <h1 className="text-2xl font-semibold">{t("editTitle", { name: feed.name })}</h1>
      <EditFeedForm
        feed={feed}
        capabilitiesPromise={capabilitiesPromise}
        allTagsPromise={allTagsPromise}
      />
    </div>
  );
}
