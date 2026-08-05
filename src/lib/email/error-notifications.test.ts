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
      db.insert(schema.users)
        .values({ id, email: `${id}@example.com`, role })
        .run();
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
    notifications.notifyAdmins({
      category: "scheduler",
      message: "second",
      occurredAt: new Date(),
    });

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

    notifications.notifyAdmins({
      category: "worker",
      message: "admin issue",
      occurredAt: new Date(),
    });
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
});
