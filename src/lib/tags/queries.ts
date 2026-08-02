import { and, asc, like, desc, eq, count } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { tags, type Tag } from "@/lib/db/schema";
import type { ListParams } from "@/lib/crud/params";

export type TagListRow = Tag;

import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

const SORTABLE: Record<string, AnySQLiteColumn> = {
  name: tags.name,
  createdAt: tags.createdAt,
};

export async function listTags(params: ListParams): Promise<{
  rows: TagListRow[];
  total: number;
}> {
  const session = await requireUser();

  const term = params.q.trim();
  const search = term ? like(tags.name, `%${term}%`) : undefined;
  const where = and(eq(tags.userId, session.id), search);

  const column = SORTABLE[params.sort] ?? tags.createdAt;
  const direction = params.dir === "desc" ? desc : asc;

  const total = getDb().select({ value: count() }).from(tags).where(where).get()?.value ?? 0;

  const results = getDb()
    .select()
    .from(tags)
    .where(where)
    .orderBy(direction(column), desc(tags.id))
    .limit(params.pageSize)
    .offset((params.page - 1) * params.pageSize)
    .all();

  return {
    rows: results,
    total,
  };
}

export async function getTag(id: number): Promise<Tag | null> {
  const session = await requireUser();
  return (
    getDb()
      .select()
      .from(tags)
      .where(and(eq(tags.id, id), eq(tags.userId, session.id)))
      .get() ?? null
  );
}
