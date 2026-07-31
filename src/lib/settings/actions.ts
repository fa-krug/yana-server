"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { writeTransaction } from "@/lib/db/client";
import { userSettings } from "@/lib/db/schema";

import { currentUserId } from "./queries";

const general = z.object({
  theme: z.enum(["light", "dark", "system"]),
  language: z.enum(["en", "de"]),
});

const library = z.object({
  articleRetentionDays: z.number().int().min(1).max(3650),
  updateIntervalMinutes: z.number().int().min(1).max(1440),
});

type Result = { ok: boolean; error?: string };

/**
 * Shared write path for both actions below, inside writeTransaction() per
 * CLAUDE.md's convention (every write goes through it -- never a bare
 * db.update() outside one). `updatedAt` is not set here: the schema's
 * $onUpdate(() => new Date()) already stamps it on every Drizzle write, and
 * setting it again here would just be a second place that can drift out of
 * sync with that.
 */
async function write(values: Partial<typeof userSettings.$inferInsert>): Promise<Result> {
  const userId = await currentUserId();
  writeTransaction((tx) => {
    tx.update(userSettings).set(values).where(eq(userSettings.userId, userId)).run();
  });
  // The locale is read server-side per request, so a language change must
  // invalidate every rendered route, not just this page.
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function updateGeneralSettings(input: unknown): Promise<Result> {
  const parsed = general.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message };
  return write(parsed.data);
}

export async function updateLibrarySettings(input: unknown): Promise<Result> {
  const parsed = library.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message };
  return write(parsed.data);
}
