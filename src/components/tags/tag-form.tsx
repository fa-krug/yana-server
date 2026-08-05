"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { createTag, deleteTags, updateTag } from "@/lib/tags/actions";
import { DEFAULT_TAG_COLOR, TAG_COLOR_KEYS, hexForTagColor } from "@/lib/tags/colors";
import { attempt, type TagsKey } from "@/lib/tags/result";
import { cn } from "@/lib/utils";
import type { Tag } from "@/lib/db/schema";
import { useTagUsage } from "./use-tag-usage";

export function TagForm({ tag }: { tag?: Tag }) {
  const t = useTranslations("tags");
  const c = useTranslations("common");
  const router = useRouter();

  const [name, setName] = useState(tag?.name ?? "");
  const [color, setColor] = useState<string>(tag?.color ?? DEFAULT_TAG_COLOR);
  const [pending, start] = useTransition();
  const usage = useTagUsage(tag ? [tag.id] : []);

  function failed(errorKey: TagsKey | undefined): void {
    toast.error(errorKey ? t(errorKey) : t("saveFailed"));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    start(async () => {
      if (tag) {
        const result = await attempt(() => updateTag(tag.id, { name, color }));
        if (!result.ok) return failed(result.errorKey);
        toast.success(t("form.saved"));
        router.refresh();
        return;
      }

      const result = await attempt(() => createTag({ name, color }));
      if (!result.ok) return failed(result.errorKey);
      toast.success(t("form.created"));
      router.replace("/tags");
    });
  }

  const onDelete = () => {
    if (!tag) return;

    start(async () => {
      const result = await attempt(() => deleteTags([tag.id]));

      if (!result.ok) {
        return failed(result.errorKey);
      }

      if (result.deleted === 0) {
        toast.info(t("deletedNone"));
      } else {
        toast.success(t("deleted", { count: result.deleted }));
      }

      router.replace("/tags");
      router.refresh();
    });
  };

  const isDeletePending = pending;

  return (
    <div className="space-y-8">
      <form onSubmit={submit} className="max-w-2xl space-y-6">
        <div className="grid gap-2">
          <Label htmlFor="tag-name">{t("form.name")}</Label>
          <Input
            id="tag-name"
            required
            autoComplete="off"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={pending}
            className="max-w-md"
          />
        </div>

        <div className="grid gap-2">
          <Label>{t("form.color")}</Label>
          <div role="radiogroup" aria-label={t("form.color")} className="flex flex-wrap gap-2">
            {TAG_COLOR_KEYS.map((key) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={color === key}
                aria-label={t(`colors.${key}`)}
                disabled={pending}
                onClick={() => setColor(key)}
                className={cn(
                  "size-7 rounded-full border-2 transition-colors",
                  color === key ? "border-foreground" : "border-transparent",
                )}
                style={{ backgroundColor: hexForTagColor(key) }}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button type="submit" disabled={pending} className="w-full sm:w-auto">
            {tag ? t("form.save") : t("form.create")}
          </Button>
          <Link
            href="/tags"
            className={cn(buttonVariants({ variant: "outline" }), "w-full sm:w-auto")}
          >
            {c("cancel")}
          </Link>
        </div>
      </form>

      {tag && (
        <div className="pt-8 border-t space-y-4 max-w-md">
          <h2 className="text-lg font-medium text-red-600">{t("deleteAction")}</h2>
          <p className="text-sm text-muted-foreground">
            {isDeletePending
              ? usage?.feeds && usage.feeds > 0
                ? t("deleteDescriptionPending", { name: tag.name })
                : t("deleteDescriptionZero", { name: tag.name })
              : usage?.feeds && usage.feeds > 0
                ? t("deleteDescription", { name: tag.name, feeds: usage.feeds })
                : t("deleteDescriptionZero", { name: tag.name })}
          </p>
          <Button type="button" variant="destructive" disabled={pending} onClick={onDelete}>
            {t("deleteConfirm")}
          </Button>
        </div>
      )}
    </div>
  );
}
