import { getTranslations } from "next-intl/server";

import { NewFeedForm } from "@/components/feeds/feed-form";
import { requireUser } from "@/lib/auth/session";
import { capabilitiesFor } from "@/lib/feeds/actions";
import { listTags } from "@/lib/tags/queries";

export default async function NewFeedPage() {
  /**
   * The gate, first -- and there is no `<Suspense>` here for it to be inside
   * of. It also opts the route out of prerendering: `requireUser()` awaits
   * `headers()` before anything can reach SQLite, so no `connection()` call is
   * needed (see the `connection()` bullet in CLAUDE.md).
   */
  await requireUser();

  const t = await getTranslations("feeds");

  // Not awaited: handed to `<NewFeedForm>`, whose real form chassis renders
  // immediately (disabled, per its own `pending` fallback) and fills in the
  // capability-derived filtering and the tag list once these resolve.
  // Awaiting either here is what used to make the whole page suspend behind
  // a 1000-row `listTags()` call.
  const capabilities = capabilitiesFor();
  const allTags = listTags({
    q: "",
    page: 1,
    pageSize: 1000,
    sort: "name",
    dir: "asc",
    filters: {},
  }).then((result) => result.rows);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("newTitle")}</h1>
      <NewFeedForm capabilitiesPromise={capabilities} allTagsPromise={allTags} />
    </div>
  );
}
