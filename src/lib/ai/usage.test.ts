import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { freshDrizzle } from "@/lib/db/test-support";
import { aiRequests, users } from "@/lib/db/schema";

import { checkAndRecordAiUsage } from "./usage";

describe("checkAndRecordAiUsage", () => {
  let db: ReturnType<typeof freshDrizzle>["db"];

  beforeEach(() => {
    ({ db } = freshDrizzle());
    db.insert(users).values({ id: "u1", email: "u1@example.com" }).run();
  });

  function requestCount(): number {
    return db.select().from(aiRequests).where(eq(aiRequests.userId, "u1")).all().length;
  }

  it("allows a call under both limits and records it", () => {
    const result = checkAndRecordAiUsage(db, "u1", 5, 50);
    expect(result).toBe("ok");
    expect(requestCount()).toBe(1);
  });

  it("refuses once the daily limit is reached, without recording a new row", () => {
    for (let i = 0; i < 3; i++) checkAndRecordAiUsage(db, "u1", 3, 50);
    const result = checkAndRecordAiUsage(db, "u1", 3, 50);
    expect(result).toBe("dailyLimitExceeded");
    expect(requestCount()).toBe(3);
  });

  it("refuses once the monthly limit is reached even under the daily limit", () => {
    for (let i = 0; i < 5; i++) checkAndRecordAiUsage(db, "u1", 100, 5);
    const result = checkAndRecordAiUsage(db, "u1", 100, 5);
    expect(result).toBe("monthlyLimitExceeded");
    expect(requestCount()).toBe(5);
  });

  it("reports monthlyLimitExceeded, not dailyLimitExceeded, when both are exhausted at once", () => {
    // Monthly is checked first specifically so that when both limits are
    // already exhausted simultaneously, the caller is told the true binding
    // constraint ("try again next month") rather than the narrower one
    // ("try again tomorrow") that would be technically true of the daily
    // window alone but wrong advice given the wider monthly cap.
    for (let i = 0; i < 2; i++) checkAndRecordAiUsage(db, "u1", 2, 2);
    const result = checkAndRecordAiUsage(db, "u1", 2, 2);
    expect(result).toBe("monthlyLimitExceeded");
    expect(requestCount()).toBe(2);
  });

  it("does not count another user's requests", () => {
    db.insert(users).values({ id: "u2", email: "u2@example.com" }).run();
    for (let i = 0; i < 3; i++) checkAndRecordAiUsage(db, "u2", 3, 50);
    const result = checkAndRecordAiUsage(db, "u1", 3, 50);
    expect(result).toBe("ok");
  });

  it("resets the daily count on a new UTC day, but keeps the monthly count", () => {
    const day1 = new Date(Date.UTC(2026, 0, 15, 10, 0, 0));
    const day2 = new Date(Date.UTC(2026, 0, 16, 0, 30, 0));
    checkAndRecordAiUsage(db, "u1", 1, 50, day1);
    // Same day, over the daily limit of 1.
    expect(checkAndRecordAiUsage(db, "u1", 1, 50, day1)).toBe("dailyLimitExceeded");
    // Next UTC day: daily count is back to zero, monthly count still includes day1's row.
    expect(checkAndRecordAiUsage(db, "u1", 1, 50, day2)).toBe("ok");
    expect(requestCount()).toBe(2);
  });

  it("prunes rows older than the start of the current UTC month", () => {
    const lastMonth = new Date(Date.UTC(2026, 0, 15));
    const thisMonth = new Date(Date.UTC(2026, 1, 1, 0, 30, 0));
    checkAndRecordAiUsage(db, "u1", 50, 50, lastMonth);
    expect(requestCount()).toBe(1);
    checkAndRecordAiUsage(db, "u1", 50, 50, thisMonth);
    // The January row is pruned before the new one is inserted.
    expect(requestCount()).toBe(1);
  });
});
