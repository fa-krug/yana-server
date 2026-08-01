import { getTranslations } from "next-intl/server";

import { TagForm } from "@/components/tags/tag-form";
import { requireUser } from "@/lib/auth/session";

export default async function NewTagPage() {
  await requireUser();

  const t = await getTranslations("tags");

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">{t("newTitle")}</h1>
      <TagForm />
    </div>
  );
}
