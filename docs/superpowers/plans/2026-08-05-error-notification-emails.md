# Error Notification Emails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send email notifications when the job worker crashes, a scheduler
tick throws, or a job terminally fails -- system errors to every admin, job
failures to the job's owning user -- bundled into one email per 2-minute
window per recipient rather than one email per error.

**Architecture:** Two new leaf modules (`src/lib/email/client.ts` for the
SMTP transport, `src/lib/email/digest.ts` for localized rendering) feed a
third, `src/lib/email/error-notifications.ts`, which holds an in-process,
per-channel debounce buffer and exposes `notifyAdmins()` /
`notifyJobFailure()`. Three existing files (`worker.ts`, `scheduler.ts`,
`queue.ts`) each get a one-line call added at their existing failure sites.

**Tech Stack:** Next.js 16 / TypeScript, `nodemailer` (new dependency),
`use-intl/core`'s `createTranslator` (already a transitive dependency of
`next-intl`, promoted to direct), Vitest with real SQLite for `src/lib/**`
tests.

**Spec:** `docs/superpowers/specs/2026-08-05-error-notification-emails-design.md`

## Global Constraints

- Dependencies are pinned to an exact version (no `^`/`~`) in `package.json`,
  and `package-lock.json` is regenerated in the same step -- grep both for
  `^`/`~` on anything you add before calling a task done.
- Every user-facing string is added to both `messages/en.json` and
  `messages/de.json` with identical key sets -- enforced by
  `src/i18n/messages.test.ts`, which every task that touches a catalog must
  run.
- `src/lib/**` tests use a real migrated SQLite database
  (`src/lib/db/test-support.ts`'s `applyMigrationsAt()`), never a mocked
  driver. Mock only genuine external boundaries: the SMTP transport
  (`client.test.ts`) and, in `error-notifications.test.ts`, the two modules
  it calls out to (`./client`, `./digest`) so that test stays about bundling
  logic, not about digest content (already covered by `digest.test.ts`).
- Nothing in this notification path may throw into its caller. `sendMail()`,
  `notifyAdmins()`, `notifyJobFailure()`, and every flush callback catch and
  `console.error`/`console.log` rather than propagate or reject unhandled.
- The `src/instrumentation.ts` fatal-startup-failure path is explicitly out
  of scope (see the spec's "Scope" section) -- no hook is added there.

---

### Task 1: `email` message catalog namespace

**Files:**
- Modify: `messages/en.json`
- Modify: `messages/de.json`

**Interfaces:**
- Produces: an `email` namespace with keys `subject`, `intro`, `workerEntry`,
  `schedulerEntry`, `jobEntry` -- consumed by Task 3's `renderDigest()`.

- [ ] **Step 1: Add the `email` namespace to `messages/en.json`**

Add a new top-level key (alongside the existing `nav`, `jobs`, `auth`, ...
keys):

```json
"email": {
  "subject": "Yana: {count, plural, one {1 error} other {# errors}}",
  "intro": "The following errors occurred:",
  "workerEntry": "[{time}] Worker crashed: {message}",
  "schedulerEntry": "[{time}] Scheduler error: {message}",
  "jobEntry": "[{time}] Job \"{jobKind}\" failed: {message}"
}
```

- [ ] **Step 2: Run the catalog parity test and confirm it fails**

Run: `npm test -- src/i18n/messages.test.ts`
Expected: FAIL -- `de.json` is missing the five new `email.*` keys.

- [ ] **Step 3: Add the matching `email` namespace to `messages/de.json`**

```json
"email": {
  "subject": "Yana: {count, plural, one {1 Fehler} other {# Fehler}}",
  "intro": "Die folgenden Fehler sind aufgetreten:",
  "workerEntry": "[{time}] Worker abgestürzt: {message}",
  "schedulerEntry": "[{time}] Scheduler-Fehler: {message}",
  "jobEntry": "[{time}] Job \"{jobKind}\" fehlgeschlagen: {message}"
}
```

- [ ] **Step 4: Run the catalog parity test and confirm it passes**

Run: `npm test -- src/i18n/messages.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add messages/en.json messages/de.json
git commit -m "feat(email): add the email notification message catalog"
```

---

### Task 2: `src/lib/email/client.ts` -- the SMTP transport

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/lib/email/client.ts`
- Test: `src/lib/email/client.test.ts`

**Interfaces:**
- Produces: `sendMail(to: string, subject: string, text: string): Promise<void>`
  -- never throws. Consumed by Task 4's `flushAdmins()`/`flushUser()`.

- [ ] **Step 1: Add `nodemailer` and `@types/nodemailer` as exact-pinned dependencies**

Check the latest stable versions and pin them exactly (at the time this plan
was written: `nodemailer@9.0.4`, `@types/nodemailer@8.0.1` -- verify against
`npm view nodemailer version` / `npm view @types/nodemailer version` since
these may have moved on):

```bash
npm install nodemailer@9.0.4 --save-exact
npm install --save-dev @types/nodemailer@8.0.1 --save-exact
grep -n '"nodemailer"' package.json
```

Expected: both lines in `package.json` show a bare version string with no
`^`/`~` prefix, and `package-lock.json` has been regenerated (check
`git status` shows it modified).

- [ ] **Step 2: Write the failing test for the unconfigured (no `SMTP_HOST`) case**

Create `src/lib/email/client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sendMailMock = vi.fn();
const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
}));

describe("src/lib/email/client", () => {
  let client: typeof import("./client");

  beforeEach(async () => {
    vi.resetModules();
    createTransportMock.mockClear();
    sendMailMock.mockClear();
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_SECURE;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASSWORD;
    delete process.env.EMAIL_FROM;
    client = await import("./client");
  });

  it("logs and does not construct a transport when SMTP_HOST is unset", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await client.sendMail("a@example.com", "subject", "body");

    expect(createTransportMock).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("a@example.com"));
    logSpy.mockRestore();
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npm test -- src/lib/email/client.test.ts`
Expected: FAIL -- `Cannot find module './client'` (the file does not exist yet).

- [ ] **Step 4: Create `src/lib/email/client.ts` with the minimal no-op path**

```ts
import nodemailer from "nodemailer";

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
let configured = false;

function getTransport(): ReturnType<typeof nodemailer.createTransport> | null {
  if (configured) return transport;
  configured = true;

  const host = process.env.SMTP_HOST;
  if (!host) return null;

  transport = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });
  return transport;
}

/**
 * Sends one email, or -- when no SMTP host is configured -- logs what would
 * have been sent instead. Never throws: a notification failure must never be
 * allowed to break whatever background job, worker loop, or scheduler tick
 * triggered it.
 */
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const t = getTransport();
  if (!t) {
    console.log(`[email] SMTP not configured; would have sent to ${to}: ${subject}`);
    return;
  }
  try {
    await t.sendMail({ from: process.env.EMAIL_FROM || "yana@localhost", to, subject, text });
  } catch (err) {
    console.error(`[email] failed to send to ${to}:`, err);
  }
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npm test -- src/lib/email/client.test.ts`
Expected: PASS

- [ ] **Step 6: Add the configured-transport test and verify it fails first, then passes**

Add to `src/lib/email/client.test.ts`, inside the `describe` block:

```ts
  it("sends through the configured transport when SMTP_HOST is set", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    process.env.SMTP_PORT = "465";
    process.env.SMTP_SECURE = "true";
    process.env.SMTP_USER = "user";
    process.env.SMTP_PASSWORD = "pass";
    process.env.EMAIL_FROM = "yana@example.com";

    await client.sendMail("a@example.com", "subject", "body");

    expect(createTransportMock).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      auth: { user: "user", pass: "pass" },
    });
    expect(sendMailMock).toHaveBeenCalledWith({
      from: "yana@example.com",
      to: "a@example.com",
      subject: "subject",
      text: "body",
    });
  });
```

This should already pass against the Step 4 implementation (no new
production code needed) -- run it to confirm:

Run: `npm test -- src/lib/email/client.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Add the send-failure test and verify it passes**

```ts
  it("catches and logs a rejected send instead of throwing", async () => {
    process.env.SMTP_HOST = "smtp.example.com";
    sendMailMock.mockRejectedValueOnce(new Error("connection refused"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(client.sendMail("a@example.com", "s", "b")).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to send to a@example.com"),
      expect.any(Error),
    );
    errorSpy.mockRestore();
  });
```

Run: `npm test -- src/lib/email/client.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/lib/email/client.ts src/lib/email/client.test.ts
git commit -m "feat(email): add the SMTP transport wrapper"
```

---

### Task 3: `src/lib/email/digest.ts` -- localized digest rendering

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `src/lib/email/digest.ts`
- Test: `src/lib/email/digest.test.ts`

**Interfaces:**
- Consumes: the `email` catalog namespace from Task 1.
- Produces:
  - `export interface ErrorEntry { category: "worker" | "scheduler" | "job"; message: string; occurredAt: Date; jobKind?: string }`
  - `export type Locale = "en" | "de"`
  - `export async function renderDigest(locale: Locale, entries: ErrorEntry[]): Promise<{ subject: string; body: string }>`

  Both consumed by Task 4.

- [ ] **Step 1: Add `use-intl` as an exact-pinned dependency**

`next-intl@4.13.4` already resolves `use-intl@4.13.4` transitively (confirm
with `grep -A2 '"use-intl"' package-lock.json`) -- pin that same version
directly, the same way `sharp` is pinned at the version Next already
resolves transitively (see `CLAUDE.md`'s note on that pin):

```bash
npm install use-intl@4.13.4 --save-exact
grep -n '"use-intl"' package.json
```

Expected: `package.json`'s `dependencies` now has a bare `"use-intl": "4.13.4"`
entry with no `^`/`~`.

- [ ] **Step 2: Write the failing test for a single-entry English digest**

Create `src/lib/email/digest.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { renderDigest, type ErrorEntry } from "./digest";

describe("src/lib/email/digest", () => {
  const workerEntry: ErrorEntry = {
    category: "worker",
    message: "connection refused",
    occurredAt: new Date("2026-08-05T12:00:00.000Z"),
  };

  it("renders a single-entry English digest", async () => {
    const { subject, body } = await renderDigest("en", [workerEntry]);

    expect(subject).toBe("Yana: 1 error");
    expect(body).toContain("The following errors occurred:");
    expect(body).toContain("Worker crashed: connection refused");
    expect(body).toContain("2026-08-05T12:00:00.000Z");
  });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `npm test -- src/lib/email/digest.test.ts`
Expected: FAIL -- `Cannot find module './digest'`.

- [ ] **Step 4: Create `src/lib/email/digest.ts`**

```ts
import { createTranslator } from "use-intl/core";

export interface ErrorEntry {
  category: "worker" | "scheduler" | "job";
  message: string;
  occurredAt: Date;
  jobKind?: string;
}

export type Locale = "en" | "de";

/**
 * Renders one recipient's digest of everything bundled into a single
 * notification window. There is no request here to call next-intl's
 * `getTranslations()` from -- this runs from a worker loop, a scheduler tick,
 * or a job's terminal failure -- so the catalog is loaded the same way
 * `src/i18n/request.ts` loads it for the root layout, and `createTranslator`
 * (`use-intl/core`) renders against it directly.
 */
export async function renderDigest(
  locale: Locale,
  entries: ErrorEntry[],
): Promise<{ subject: string; body: string }> {
  const messages = (await import(`../../../messages/${locale}.json`)).default;
  const t = createTranslator({ locale, messages, namespace: "email" });

  const lines = entries.map((entry) => {
    const time = entry.occurredAt.toISOString();
    if (entry.category === "worker") {
      return t("workerEntry", { time, message: entry.message });
    }
    if (entry.category === "scheduler") {
      return t("schedulerEntry", { time, message: entry.message });
    }
    return t("jobEntry", { time, message: entry.message, jobKind: entry.jobKind ?? "" });
  });

  return {
    subject: t("subject", { count: entries.length }),
    body: `${t("intro")}\n\n${lines.join("\n")}`,
  };
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npm test -- src/lib/email/digest.test.ts`
Expected: PASS

- [ ] **Step 6: Add the remaining category, pluralization, and locale tests**

Add to the same `describe` block:

```ts
  it("renders a scheduler entry", async () => {
    const { body } = await renderDigest("en", [
      { category: "scheduler", message: "tick failed", occurredAt: new Date("2026-08-05T00:00:00.000Z") },
    ]);
    expect(body).toContain("Scheduler error: tick failed");
  });

  it("renders a job entry with its job kind", async () => {
    const { body } = await renderDigest("en", [
      {
        category: "job",
        message: "feed unreachable",
        occurredAt: new Date("2026-08-05T00:00:00.000Z"),
        jobKind: "aggregate",
      },
    ]);
    expect(body).toContain('Job "aggregate" failed: feed unreachable');
  });

  it("pluralizes the subject for more than one entry", async () => {
    const { subject } = await renderDigest("en", [workerEntry, workerEntry]);
    expect(subject).toBe("Yana: 2 errors");
  });

  it("renders in German when the recipient's locale is de", async () => {
    const { subject, body } = await renderDigest("de", [workerEntry]);
    expect(subject).toBe("Yana: 1 Fehler");
    expect(body).toContain("Die folgenden Fehler sind aufgetreten:");
    expect(body).toContain("Worker abgestürzt: connection refused");
  });
```

- [ ] **Step 7: Run the tests and verify they all pass**

Run: `npm test -- src/lib/email/digest.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/lib/email/digest.ts src/lib/email/digest.test.ts
git commit -m "feat(email): add localized error digest rendering"
```

---

### Task 4: `src/lib/email/error-notifications.ts` -- the bundling engine

**Files:**
- Create: `src/lib/email/error-notifications.ts`
- Test: `src/lib/email/error-notifications.test.ts`

**Interfaces:**
- Consumes: `sendMail()` (Task 2), `renderDigest()` + `ErrorEntry` + `Locale`
  (Task 3), `isAdminRole()` from `src/lib/auth/roles.ts`, the `users` /
  `userSettings` schema tables, `getDb()` from `src/lib/db/client.ts`.
- Produces:
  - `export function notifyAdmins(entry: ErrorEntry): void`
  - `export function notifyJobFailure(userId: string | null, entry: ErrorEntry): void`
  - `export type { ErrorEntry } from "./digest"` (re-exported so callers in
    Tasks 5-7 need only one import path)

  Both functions consumed by Tasks 5, 6, and 7.

- [ ] **Step 1: Write the failing test for a single admin, single-entry flush**

Create `src/lib/email/error-notifications.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "../db/test-support";

const sendMailMock = vi.fn();
const renderDigestMock = vi.fn(async (locale: string, entries: unknown[]) => ({
  subject: `subject-${locale}-${entries.length}`,
  body: `body-${locale}-${entries.length}`,
}));

vi.mock("./client", () => ({ sendMail: sendMailMock }));
vi.mock("./digest", () => ({ renderDigest: renderDigestMock }));

describe("src/lib/email/error-notifications", () => {
  let dbPath: string;
  let client: typeof import("../db/client");
  let schema: typeof import("../db/schema");
  let notifications: typeof import("./error-notifications");

  function seedUser(role: string, language: string | null): string {
    const id = `user-${Math.random().toString(36).slice(2)}`;
    client.writeTransaction((db) => {
      db.insert(schema.users).values({ id, email: `${id}@example.com`, role }).run();
      if (language !== null) {
        db.insert(schema.userSettings).values({ userId: id, language }).run();
      }
    });
    return id;
  }

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    sendMailMock.mockClear();
    renderDigestMock.mockClear();
    process.env.ERROR_EMAIL_DEBOUNCE_MS = "1000";

    dbPath = path.join(
      os.tmpdir(),
      `yana-email-notify-${process.pid}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.DATABASE_PATH = dbPath;
    applyMigrationsAt(dbPath);

    client = await import("../db/client");
    schema = await import("../db/schema");
    notifications = await import("./error-notifications");
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.ERROR_EMAIL_DEBOUNCE_MS;
    delete process.env.DATABASE_PATH;
    const connection = (client.getDb() as unknown as { $client: Database.Database }).$client;
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
  });

  it("emails the one admin after the debounce window elapses", async () => {
    seedUser("admin", "en");

    notifications.notifyAdmins({
      category: "worker",
      message: "boom",
      occurredAt: new Date("2026-08-05T00:00:00.000Z"),
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(renderDigestMock).toHaveBeenCalledTimes(1);
    expect(renderDigestMock).toHaveBeenCalledWith(
      "en",
      expect.arrayContaining([expect.objectContaining({ message: "boom" })]),
    );
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- src/lib/email/error-notifications.test.ts`
Expected: FAIL -- `Cannot find module './error-notifications'`.

- [ ] **Step 3: Create `src/lib/email/error-notifications.ts`**

```ts
import { eq } from "drizzle-orm";

import { isAdminRole } from "../auth/roles";
import { getDb } from "../db/client";
import { users, userSettings } from "../db/schema";
import { sendMail } from "./client";
import { renderDigest, type ErrorEntry, type Locale } from "./digest";

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

function recipientLocale(language: string | null | undefined): Locale {
  return language === "de" ? "de" : "en";
}

async function flushAdmins(entries: ErrorEntry[]): Promise<void> {
  const admins = getDb()
    .select({ email: users.email, role: users.role, language: userSettings.language })
    .from(users)
    .leftJoin(userSettings, eq(users.id, userSettings.userId))
    .all()
    .filter((row) => isAdminRole(row.role));

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
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm test -- src/lib/email/error-notifications.test.ts`
Expected: PASS

- [ ] **Step 5: Add the bundling, timing, ownerless-routing, per-locale, and missing-recipient tests**

Add to the same `describe` block:

```ts
  it("does not flush before the debounce window elapses", async () => {
    seedUser("admin", "en");
    notifications.notifyAdmins({ category: "worker", message: "boom", occurredAt: new Date() });

    await vi.advanceTimersByTimeAsync(999);
    expect(sendMailMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("bundles a second error arriving inside the window into the same flush", async () => {
    seedUser("admin", "en");
    notifications.notifyAdmins({ category: "worker", message: "first", occurredAt: new Date() });
    await vi.advanceTimersByTimeAsync(500);
    notifications.notifyAdmins({ category: "scheduler", message: "second", occurredAt: new Date() });

    await vi.advanceTimersByTimeAsync(500);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(renderDigestMock).toHaveBeenCalledWith(
      "en",
      expect.arrayContaining([
        expect.objectContaining({ message: "first" }),
        expect.objectContaining({ message: "second" }),
      ]),
    );
  });

  it("routes an ownerless job failure to the admin channel", async () => {
    seedUser("admin", "en");
    notifications.notifyJobFailure(null, {
      category: "job",
      message: "retention failed",
      occurredAt: new Date(),
      jobKind: "retention",
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(renderDigestMock).toHaveBeenCalledWith(
      "en",
      expect.arrayContaining([expect.objectContaining({ message: "retention failed" })]),
    );
  });

  it("sends a job failure to its owning user, independently of the admin channel", async () => {
    seedUser("admin", "en");
    const ownerId = seedUser("user", "en");

    notifications.notifyAdmins({ category: "worker", message: "admin issue", occurredAt: new Date() });
    notifications.notifyJobFailure(ownerId, {
      category: "job",
      message: "your feed failed",
      occurredAt: new Date(),
      jobKind: "aggregate",
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });

  it("renders one email per admin, each in that admin's own language", async () => {
    seedUser("admin", "en");
    seedUser("admin", "de");

    notifications.notifyAdmins({ category: "worker", message: "boom", occurredAt: new Date() });
    await vi.advanceTimersByTimeAsync(1000);

    expect(renderDigestMock).toHaveBeenCalledWith("en", expect.any(Array));
    expect(renderDigestMock).toHaveBeenCalledWith("de", expect.any(Array));
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });

  it("drops entries and logs, without throwing, when a job's owner no longer exists", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    notifications.notifyJobFailure("nonexistent-user-id", {
      category: "job",
      message: "orphaned",
      occurredAt: new Date(),
    });

    await vi.advanceTimersByTimeAsync(1000);

    expect(sendMailMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("nonexistent-user-id"));
    errorSpy.mockRestore();
  });
```

- [ ] **Step 6: Run the tests and verify they all pass**

Run: `npm test -- src/lib/email/error-notifications.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 7: Commit**

```bash
git add src/lib/email/error-notifications.ts src/lib/email/error-notifications.test.ts
git commit -m "feat(email): add the per-channel debounce/bundle engine"
```

---

### Task 5: Hook the worker-loop crash into `notifyAdmins()`

**Files:**
- Modify: `src/lib/jobs/worker.ts`
- Modify: `src/lib/jobs/worker.test.ts`

**Interfaces:**
- Consumes: `notifyAdmins(entry: ErrorEntry): void` from Task 4
  (`../email/error-notifications`).

- [ ] **Step 1: Write the failing test**

Add to the top of `src/lib/jobs/worker.test.ts`, above the `describe` block
(hoisted mocks must be declared before any import that could trigger the
mocked module):

```ts
const notifyAdminsMock = vi.fn();
vi.mock("../email/error-notifications", () => ({
  notifyAdmins: notifyAdminsMock,
  notifyJobFailure: vi.fn(),
}));
```

Add inside the `describe` block's `beforeEach`, right after the existing
`handlers.clearHandlers();` line:

```ts
    notifyAdminsMock.mockClear();
```

Add a new `it` block, after the "guards against starting multiple worker
loops" test:

```ts
  it("notifies admins when the worker loop crashes fatally", async () => {
    vi.spyOn(queue, "claim").mockImplementation(() => {
      throw new Error("claim exploded");
    });

    worker.startWorker();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(notifyAdminsMock).toHaveBeenCalledWith(
      expect.objectContaining({ category: "worker" }),
    );
    expect(worker.isWorkerRunning()).toBe(false);
  });
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- src/lib/jobs/worker.test.ts`
Expected: FAIL -- `notifyAdminsMock` was never called (the hook doesn't exist
yet).

- [ ] **Step 3: Add the hook to `src/lib/jobs/worker.ts`**

Add the import alongside the existing ones at the top:

```ts
import { notifyAdmins } from "../email/error-notifications";
```

Modify the `.catch()` inside `startWorker()`:

```ts
  runWorkerLoop(options).catch((err) => {
    console.error("[Worker] Fatal error in worker loop:", err);
    notifyAdmins({
      category: "worker",
      message: err instanceof Error ? (err.stack ?? err.message) : String(err),
      occurredAt: new Date(),
    });
    g[WORKER_STARTED] = false;
    isLoopActive = false;
  });
```

- [ ] **Step 4: Run the full worker test file and verify everything passes**

Run: `npm test -- src/lib/jobs/worker.test.ts`
Expected: PASS (all tests, including the new one)

- [ ] **Step 5: Commit**

```bash
git add src/lib/jobs/worker.ts src/lib/jobs/worker.test.ts
git commit -m "feat(email): notify admins when the job worker crashes fatally"
```

---

### Task 6: Hook scheduler-tick errors into `notifyAdmins()`

**Files:**
- Modify: `src/lib/jobs/scheduler.ts`
- Modify: `src/lib/jobs/scheduler.test.ts`

**Interfaces:**
- Consumes: `notifyAdmins(entry: ErrorEntry): void` from Task 4.

- [ ] **Step 1: Write the failing test**

Add above the `describe` block in `src/lib/jobs/scheduler.test.ts`:

```ts
const notifyAdminsMock = vi.fn();
vi.mock("../email/error-notifications", () => ({
  notifyAdmins: notifyAdminsMock,
  notifyJobFailure: vi.fn(),
}));
```

Add to `beforeEach`, after `scheduler = await import("./scheduler");`:

```ts
    notifyAdminsMock.mockClear();
```

Add a new `it` block, after "guards against duplicate scheduler loops":

```ts
  it("notifies admins when a scheduler tick throws", async () => {
    vi.spyOn(queue, "enqueue").mockImplementation(() => {
      throw new Error("enqueue exploded");
    });

    scheduler.startScheduler({ tickIntervalMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(notifyAdminsMock).toHaveBeenCalledWith(
      expect.objectContaining({ category: "scheduler" }),
    );
  });
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test -- src/lib/jobs/scheduler.test.ts`
Expected: FAIL -- `notifyAdminsMock` was never called.

- [ ] **Step 3: Add the hook to `src/lib/jobs/scheduler.ts`**

Add the import:

```ts
import { notifyAdmins } from "../email/error-notifications";
```

Modify both catch blocks inside `startScheduler()` (the immediate call and
the interval callback) to the same shape:

```ts
  tick().catch((err) => {
    console.error("[Scheduler] Error in scheduler tick:", err);
    notifyAdmins({
      category: "scheduler",
      message: err instanceof Error ? (err.stack ?? err.message) : String(err),
      occurredAt: new Date(),
    });
  });

  schedulerTimer = setInterval(() => {
    tick().catch((err) => {
      console.error("[Scheduler] Error in scheduler tick:", err);
      notifyAdmins({
        category: "scheduler",
        message: err instanceof Error ? (err.stack ?? err.message) : String(err),
        occurredAt: new Date(),
      });
    });
  }, intervalMs);
```

- [ ] **Step 4: Run the full scheduler test file and verify everything passes**

Run: `npm test -- src/lib/jobs/scheduler.test.ts`
Expected: PASS (all tests, including the new one)

- [ ] **Step 5: Commit**

```bash
git add src/lib/jobs/scheduler.ts src/lib/jobs/scheduler.test.ts
git commit -m "feat(email): notify admins when a scheduler tick throws"
```

---

### Task 7: Hook a job's terminal failure into `notifyJobFailure()`

**Files:**
- Modify: `src/lib/jobs/queue.ts`
- Modify: `src/lib/jobs/queue.test.ts`

**Interfaces:**
- Consumes: `notifyJobFailure(userId: string | null, entry: ErrorEntry): void`
  from Task 4; `resolveJobUserId(job: Job): string | null`, already private
  to `queue.ts`.

- [ ] **Step 1: Write the failing test for an owned job's terminal failure**

Add above the `describe` block in `src/lib/jobs/queue.test.ts`:

```ts
const notifyJobFailureMock = vi.fn();
vi.mock("../email/error-notifications", () => ({
  notifyAdmins: vi.fn(),
  notifyJobFailure: notifyJobFailureMock,
}));
```

Add to `beforeEach`, after `queue = await import("./queue");`:

```ts
    notifyJobFailureMock.mockClear();
```

Add a new test inside the existing `describe("fail", ...)` block, after
"marks failed at maxAttempts and keeps the error":

```ts
    it("notifies the run's owner on terminal failure", () => {
      const userId = seedUserAndReturnId();
      const runId = queue.enqueueRun(userId, "aggregate", [{ feedId: 1 }]);
      const job = client
        .getDb()
        .select()
        .from(jobs)
        .where(eq(jobs.runId, runId))
        .get()!;
      queue.claim();

      queue.fail(job.id, "feed unreachable");

      expect(notifyJobFailureMock).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          category: "job",
          message: "feed unreachable",
          jobKind: "aggregate",
        }),
      );
    });

    it("notifies admins instead of a user for an ownerless job's terminal failure", () => {
      const id = queue.enqueue("retention", {}, { maxAttempts: 1 });
      queue.claim();

      queue.fail(id, "cleanup failed");

      expect(notifyJobFailureMock).toHaveBeenCalledWith(
        null,
        expect.objectContaining({ category: "job", message: "cleanup failed", jobKind: "retention" }),
      );
    });

    it("does not notify on a retry, only on terminal failure", () => {
      const id = queue.enqueue("noop", {}, { maxAttempts: 3 });
      queue.claim();

      queue.fail(id, "temporary error");

      expect(notifyJobFailureMock).not.toHaveBeenCalled();
    });
```

`enqueueRun`'s jobs always get the schema default `maxAttempts: 3` (it has no
option for overriding that -- see `enqueueRun()`'s signature in `queue.ts`),
so the first test needs `job.attempts` bumped to the limit before calling
`fail()`, the same way the existing "clears a stale error..." test forces a
retry to be claimable early. Adjust that first new test to force the
terminal branch:

```ts
      client.getDb().update(jobs).set({ attempts: 3 }).where(eq(jobs.id, job.id)).run();

      queue.fail(job.id, "feed unreachable");
```

(insert this `update` call between `queue.claim();` and `queue.fail(job.id, ...)`).

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npm test -- src/lib/jobs/queue.test.ts`
Expected: FAIL -- `notifyJobFailureMock` was never called (the hook doesn't
exist yet), for the first two new tests. The third ("does not notify on a
retry") already passes trivially since nothing calls the mock yet -- that's
expected; it will keep passing once the hook exists precisely because the
hook only fires on the terminal branch.

- [ ] **Step 3: Add the hook to `src/lib/jobs/queue.ts`**

Add the import alongside the existing ones at the top:

```ts
import { notifyJobFailure } from "../email/error-notifications";
```

Modify the terminal branch at the end of `fail()`:

```ts
  if (outcome?.outcome === "failed") {
    publishJobOutcome({ ...outcome.job, status: "failed" }, "failed");
    publishJobTerminal(id, "failed");
    notifyJobFailure(resolveJobUserId(outcome.job), {
      category: "job",
      message: errMsg,
      occurredAt: now,
      jobKind: outcome.job.kind,
    });
  }
```

- [ ] **Step 4: Run the full queue test file and verify everything passes**

Run: `npm test -- src/lib/jobs/queue.test.ts`
Expected: PASS (all tests, including the three new ones)

- [ ] **Step 5: Commit**

```bash
git add src/lib/jobs/queue.ts src/lib/jobs/queue.test.ts
git commit -m "feat(email): notify a job's owner (or admins) on terminal failure"
```

---

### Task 8: Document the new environment variables

**Files:**
- Modify: `CLAUDE.md` (root)

**Interfaces:** None -- documentation only.

- [ ] **Step 1: Add a bullet documenting the feature to `CLAUDE.md`**

Add a new bullet to the "Conventions" section (following the file's existing
style of dense, reasoned bullets rather than a bare list), covering: the two
channels and who each notifies, the 2-minute debounce/bundle behavior, the
`SMTP_HOST`-unset-disables-the-feature default, and the full env var list
(`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`,
`EMAIL_FROM`, `ERROR_EMAIL_DEBOUNCE_MS`) with their defaults. Cross-reference
`src/lib/email/error-notifications.ts` and the design spec at
`docs/superpowers/specs/2026-08-05-error-notification-emails-design.md`.

- [ ] **Step 2: Run the full test suite one last time**

Run: `npm run lint && npm run format:check && npm run typecheck && npm test`
Expected: PASS -- every check green, confirming the whole feature (Tasks
1-7) is internally consistent end to end.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the error notification email environment variables"
```
