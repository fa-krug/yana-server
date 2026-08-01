import { getTranslations } from "next-intl/server";

import { FeedForm } from "@/components/feeds/feed-form";
import { requireUser } from "@/lib/auth/session";
import { capabilitiesFor } from "@/lib/feeds/actions";
import { listTags } from "@/lib/tags/queries";

export default async function NewFeedPage() {
  await requireUser();

  const t = await getTranslations("feeds");
  const capabilities = await capabilitiesFor();
  const allTags = await listTags({ q: "", page: 1, pageSize: 1000, sort: "name", dir: "asc", filters: {} });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("newTitle")}</h1>
      <FeedForm capabilities={capabilities} allTags={allTags.rows} />
    </div>
  );
}
