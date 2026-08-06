"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { writeTransaction } from "@/lib/db/client";
import { userSettings } from "@/lib/db/schema";

import { currentUserId } from "./queries";
// Both types come from `./result`, which also carries the `attempt()` binding
// the two client sections call these actions through. They live there rather
// than here because this module is `"use server"`: every export of it has to be
// an async function Next can expose as an endpoint, so a type cannot be one.
// The import is `import type`, so it is erased -- nothing browser-side reaches
// this module's runtime graph.
import type { SettingsKey, SettingsResult as Result } from "./result";

const general = z.object({
  theme: z.enum(["light", "dark", "system"]),
  language: z.enum(["en", "de"]),
});

const library = z.object({
  articleRetentionDays: z.number().int().min(1).max(3650),
});

// `errorKey`, when present, is a key under the `settings` catalog namespace
// (e.g. "library.retentionRange") -- never zod's own message or a raw driver
// error. Every user-facing string must come from a message catalog (see
// CLAUDE.md), so these actions report *what* failed and leave translating it to
// the caller; returning zod's English message would render it verbatim into
// whatever language the UI happens to be showing.
//
// This table maps a failing field to its catalog key under settings.library. Only the
// range-validated retention field gets a specific key -- anything else
// (including the general section's enums, which safeParse can only fail for
// a value that isn't one of the hard-coded enum members, never a real user
// input) falls through to undefined, and the caller shows the generic
// settings.saveFailed toast instead.
//
// Typed SettingsKey, not string: these values reach t() in the client sections,
// where the type flows in through this action's inferred return type. A key
// neither catalog defines is now a typecheck failure instead of a raw key path
// rendered into a toast.
const FIELD_ERROR_KEYS: Record<string, SettingsKey> = {
  articleRetentionDays: "library.retentionRange",
};

function errorKeyFor(issues: z.core.$ZodIssue[]): SettingsKey | undefined {
  const field = issues[0]?.path[0];
  return typeof field === "string" ? FIELD_ERROR_KEYS[field] : undefined;
}

/**
 * What the UPDATE actually did: how many rows it touched, and the language the
 * row held beforehand. Both are read in one transaction so "did the language
 * change?" cannot be answered from a row some other write has since replaced.
 */
type WriteOutcome = { changes: number; previousLanguage: string | undefined };

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
  let outcome: WriteOutcome;
  try {
    outcome = writeTransaction((tx) => {
      const before = tx
        .select({ language: userSettings.language })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .get();
      const result = tx
        .update(userSettings)
        .set(values)
        .where(eq(userSettings.userId, userId))
        .run();
      return { changes: result.changes, previousLanguage: before?.language };
    });
    if (outcome.changes === 0) {
      // `WHERE user_id = ?` matched nothing, so nothing persisted. Returning
      // { ok: true } here would show "Settings saved" over a change that a
      // reload silently reverts. Reachable whenever the row is absent -- see
      // getSettings()'s throw in queries.ts -- and expected to be *normal* in
      // phase 4 for a user whose settings row was never created. Thrown rather
      // than returned so the catch below is the single place that reports a
      // failed write.
      throw new Error(`write: no user_settings row for user "${userId}"`);
    }
  } catch (error) {
    // Logged here, not returned: a driver error is not a catalog key either,
    // and putting it in the result would reintroduce the untranslated-string
    // problem from the other direction. The caller falls back to
    // settings.saveFailed.
    console.error("Failed to write user settings", error);
    return { ok: false };
  }

  // Only a *language* change needs the layout-wide invalidation. The locale is
  // resolved server-side per request (src/i18n/request.ts) and every rendered
  // layout and page holds already-translated markup, so nothing short of
  // revalidatePath("/", "layout") is correct for it.
  //
  // Everything else here is read only by /settings, and the layout-wide form
  // throws away the entire client router cache -- every visited route has to be
  // re-fetched on the next navigation -- so using it for a retention
  // change is pure waste. A theme change does not need it either: the
  // root layout passes the stored theme to next-themes as a pre-hydration
  // default only, and the settings control has already applied the new value
  // client-side via setTheme() before this action resolves (see
  // components/settings/general-section.tsx).
  if (values.language !== undefined && values.language !== outcome.previousLanguage) {
    revalidatePath("/", "layout");
  } else {
    revalidatePath("/settings");
  }
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
