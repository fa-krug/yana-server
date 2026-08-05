import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastSuccess, toastWarning, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, warning: toastWarning, error: toastError },
}));

import { reportRunOutcome } from "./report-run-outcome";
import type { RunOutcome } from "./wait-for-run";

const copy = {
  completed: (n: number) => `${n} done`,
  partial: (ok: number, failed: number) => `${ok} done, ${failed} failed`,
  fallback: "Something went wrong",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reportRunOutcome", () => {
  it("toasts success when every job in the run completed", () => {
    const outcome: RunOutcome = {
      ok: true,
      status: { status: "completed", totalJobs: 3, completedJobs: 3, failedJobs: 0 },
    };
    reportRunOutcome(outcome, copy);
    expect(toastSuccess).toHaveBeenCalledWith("3 done");
    expect(toastWarning).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("toasts a warning when some jobs in the run failed", () => {
    const outcome: RunOutcome = {
      ok: true,
      status: { status: "failed", totalJobs: 3, completedJobs: 2, failedJobs: 1 },
    };
    reportRunOutcome(outcome, copy);
    expect(toastWarning).toHaveBeenCalledWith("2 done, 1 failed");
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("toasts the fallback error on a request failure or a run that vanished", () => {
    reportRunOutcome({ ok: false, reason: "request-failed" }, copy);
    reportRunOutcome({ ok: false, reason: "not-found" }, copy);
    expect(toastError).toHaveBeenCalledTimes(2);
    expect(toastError).toHaveBeenCalledWith("Something went wrong");
  });
});
