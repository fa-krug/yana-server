import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { TagForm } from "@/components/tags/tag-form";
import { requireUser } from "@/lib/auth/session";
import { getTag } from "@/lib/tags/queries";

export default async function EditTagPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser();

  const id = parseInt((await params).id, 10);
  if (Number.isNaN(id)) notFound();

  const tag = await getTag(id);
  if (!tag) notFound();

  const t = await getTranslations("tags");

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("editTitle")}</h1>
      <TagForm tag={tag} />
    </div>
  );
}
