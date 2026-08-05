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
});
