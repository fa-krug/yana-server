import { eq } from "drizzle-orm";

import { isAdminRole } from "../auth/roles";
import { getDb } from "../db/client";
import { users, userSettings } from "../db/schema";
import type { AppLocale } from "../../i18n/locale";
import { sendMail } from "./client";
import { renderDigest, type ErrorEntry } from "./digest";

export type { ErrorEntry } from "./digest";

const DEBOUNCE_MS = Number(process.env.ERROR_EMAIL_DEBOUNCE_MS) || 120_000;
const ADMIN_KEY = "__admin__";

interface Bucket {
  entries: ErrorEntry[];
  timer: ReturnType<typeof setTimeout>;
}

const buckets = new Map<string, Bucket>();

/**
 * Queues `entry` under `key`, starting a `DEBOUNCE_MS` timer only when `key`
 * has no pending batch yet -- a batch already in flight just grows. `flush`
 * is never allowed to reject unhandled: it runs inside a bare `setTimeout`
 * callback, so a caught-and-logged failure here is the only way a broken
 * recipient lookup or a broken send does not surface as a Node warning.
 */
function schedule(
  key: string,
  entry: ErrorEntry,
  flush: (entries: ErrorEntry[]) => Promise<void>,
): void {
  const existing = buckets.get(key);
  if (existing) {
    existing.entries.push(entry);
    return;
  }
  const bucket: Bucket = {
    entries: [entry],
    timer: setTimeout(() => {
      buckets.delete(key);
      flush(bucket.entries).catch((err) => {
        console.error(`[email] failed to flush notifications for "${key}":`, err);
      });
    }, DEBOUNCE_MS),
  };
  // A pending notification timer must never hold the Node event loop open --
  // relevant to graceful shutdown, and to a test runner's teardown closing a
  // database connection out from under a callback that would otherwise still
  // be scheduled to fire.
  bucket.timer.unref?.();
  buckets.set(key, bucket);
}

/** System-level error (worker crash, scheduler tick, an ownerless job's terminal failure). */
export function notifyAdmins(entry: ErrorEntry): void {
  schedule(ADMIN_KEY, entry, flushAdmins);
}

/** A job's terminal failure. `userId === null` (no resolvable owner) routes to the admin channel. */
export function notifyJobFailure(userId: string | null, entry: ErrorEntry): void {
  if (!userId) {
    notifyAdmins(entry);
    return;
  }
  schedule(userId, entry, (entries) => flushUser(userId, entries));
}

function recipientLocale(language: string | null | undefined): AppLocale {
  return language === "de" ? "de" : "en";
}

async function flushAdmins(entries: ErrorEntry[]): Promise<void> {
  const admins = getDb()
    .select({ email: users.email, role: users.role, language: userSettings.language })
    .from(users)
    .leftJoin(userSettings, eq(users.id, userSettings.userId))
    .all()
    .filter((row) => isAdminRole(row.role));

  if (admins.length === 0) {
    console.error(
      `[email] no admin recipient found; dropping ${entries.length} system-error entr${entries.length === 1 ? "y" : "ies"}.`,
    );
    return;
  }

  for (const admin of admins) {
    const { subject, body } = await renderDigest(recipientLocale(admin.language), entries);
    await sendMail(admin.email, subject, body);
  }
}

async function flushUser(userId: string, entries: ErrorEntry[]): Promise<void> {
  const row = getDb()
    .select({ email: users.email, language: userSettings.language })
    .from(users)
    .leftJoin(userSettings, eq(users.id, userSettings.userId))
    .where(eq(users.id, userId))
    .get();

  if (!row) {
    console.error(
      `[email] job-failure recipient ${userId} no longer exists; dropping ${entries.length} entr${entries.length === 1 ? "y" : "ies"}.`,
    );
    return;
  }

  const { subject, body } = await renderDigest(recipientLocale(row.language), entries);
  await sendMail(row.email, subject, body);
}
