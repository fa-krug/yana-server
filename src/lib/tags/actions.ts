"use server";

import { and, eq, inArray, sql, ne, count } from "drizzle-orm";

import { currentUserId, requireUser } from "@/lib/auth/session";
import { getDb, writeTransaction } from "@/lib/db/client";
import { feedTags, tags } from "@/lib/db/schema";
import { revalidatePath } from "next/cache";
import { DEFAULT_TAG_COLOR } from "./colors";
import { tagSchema } from "./fields";
import type { CreateTagResult, DeleteTagsResult, TagsResult } from "./result";

export async function createTag(input: unknown): Promise<CreateTagResult> {
  const parsed = tagSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errorKey: "saveFailed" };
  }

  const { name, color } = parsed.data;
  const userId = await currentUserId();

  return writeTransaction((tx) => {
    const clash = tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.userId, userId), sql`lower(${tags.name}) = lower(${name})`))
      .get();

    if (clash) {
      return { ok: false, errorKey: "nameTaken" };
    }

    const { id } = tx
      .insert(tags)
      .values({ name, userId, color: color ?? DEFAULT_TAG_COLOR })
      .returning({ id: tags.id })
      .get();

    revalidatePath("/tags");
    return { ok: true, id };
  });
}

export async function updateTag(id: number, input: unknown): Promise<TagsResult> {
  const parsed = tagSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errorKey: "saveFailed" };
  }

  const { name, color } = parsed.data;
  const userId = await currentUserId();

  return writeTransaction((tx) => {
    const clash = tx
      .select({ id: tags.id })
      .from(tags)
      .where(
        and(eq(tags.userId, userId), sql`lower(${tags.name}) = lower(${name})`, ne(tags.id, id)),
      )
      .get();

    if (clash) {
      return { ok: false, errorKey: "nameTaken" };
    }

    const result = tx
      .update(tags)
      .set({ name, ...(color ? { color } : {}) })
      .where(and(eq(tags.id, id), eq(tags.userId, userId)))
      .run();

    if (result.changes === 0) {
      return { ok: false, errorKey: "notFound" };
    }

    revalidatePath("/tags");
    return { ok: true };
  });
}

export async function deleteTags(ids: number[]): Promise<DeleteTagsResult> {
  if (ids.length === 0) return { ok: true, deleted: 0 };

  const userId = await currentUserId();

  return writeTransaction((tx) => {
    const result = tx
      .delete(tags)
      .where(and(inArray(tags.id, ids), eq(tags.userId, userId)))
      .run();

    revalidatePath("/tags");
    return { ok: true, deleted: result.changes };
  });
}

export async function tagUsage(ids: number[]): Promise<{ feeds: number }> {
  if (ids.length === 0) return { feeds: 0 };

  const session = await requireUser();
  const feedCount =
    getDb()
      .select({ value: count() })
      .from(feedTags)
      .innerJoin(tags, eq(feedTags.tagId, tags.id))
      .where(and(inArray(tags.id, ids), eq(tags.userId, session.id)))
      .get()?.value ?? 0;

  return { feeds: feedCount };
}
