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

/**
 * `errorKey`, when present, is a key under the `settings` catalog namespace
 * (e.g. "library.retentionRange") -- never zod's own message or a raw driver
 * error. Every user-facing string must come from a message catalog (see
 * CLAUDE.md), so this action reports *what* failed and leaves translating it
 * to the caller; returning zod's English message would render it verbatim
 * into whatever language the UI happens to be showing.
 */
type Result = { ok: boolean; errorKey?: string };

// Maps a failing field to its catalog key under settings.library. Only the
// two range-validated library fields get a specific key -- anything else
// (including the general section's enums, which safeParse can only fail for
// a value that isn't one of the hard-coded enum members, never a real user
// input) falls through to undefined, and the caller shows the generic
// settings.saveFailed toast instead.
const FIELD_ERROR_KEYS: Record<string, string> = {
  articleRetentionDays: "library.retentionRange",
  updateIntervalMinutes: "library.intervalRange",
};

function errorKeyFor(issues: z.core.$ZodIssue[]): string | undefined {
  const field = issues[0]?.path[0];
  return typeof field === "string" ? FIELD_ERROR_KEYS[field] : undefined;
}

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
  try {
    writeTransaction((tx) => {
      tx.update(userSettings).set(values).where(eq(userSettings.userId, userId)).run();
    });
  } catch (error) {
    // Logged here, not returned: a driver error is not a catalog key either,
    // and putting it in the result would reintroduce the untranslated-string
    // problem from the other direction. The caller falls back to
    // settings.saveFailed.
    console.error("Failed to write user settings", error);
    return { ok: false };
  }
  // The locale is read server-side per request, so a language change must
  // invalidate every rendered route, not just this page.
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function updateGeneralSettings(input: unknown): Promise<Result> {
  const parsed = general.safeParse(input);
  if (!parsed.success) return { ok: false, errorKey: errorKeyFor(parsed.error.issues) };
  return write(parsed.data);
}

export async function updateLibrarySettings(input: unknown): Promise<Result> {
  const parsed = library.safeParse(input);
  if (!parsed.success) return { ok: false, errorKey: errorKeyFor(parsed.error.issues) };
  return write(parsed.data);
}
