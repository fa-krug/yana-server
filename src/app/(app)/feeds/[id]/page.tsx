import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";

import { FeedForm } from "@/components/feeds/feed-form";
import { requireUser } from "@/lib/auth/session";
import { getFeed, capabilitiesFor } from "@/lib/feeds/actions";
import { listTags } from "@/lib/tags/queries";

export default async function EditFeedPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();

  const id = Number((await params).id);
  const feed = await getFeed(id);

  if (!feed) {
    notFound();
  }

  const t = await getTranslations("feeds");
  const capabilities = await capabilitiesFor();
  // Fetch all tags (assume max 1000 is enough for the form)
  const allTags = await listTags({ q: "", page: 1, pageSize: 1000, sort: "name", dir: "asc", filters: {} });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("editTitle", { name: feed.name })}</h1>
      <FeedForm feed={feed} capabilities={capabilities} allTags={allTags.rows} />
    </div>
  );
}
