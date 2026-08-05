import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setRouter } from "@/test/next-navigation";

import { JobActions } from "./job-actions";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const { cancelJobs, deleteJobs, getJobsStatus } = vi.hoisted(() => ({
  cancelJobs: vi.fn(),
  deleteJobs: vi.fn(),
  getJobsStatus: vi.fn(),
}));
vi.mock("@/lib/jobs/actions", () => ({ cancelJobs, deleteJobs, getJobsStatus }));

const { refresh, push } = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
setRouter({ refresh, push });

const { toastError, toastInfo, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: toastError, info: toastInfo, success: toastSuccess },
}));

function dialog(): HTMLElement {
  const popup = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
  if (!popup) throw new Error("no confirmation dialog is open");
  return popup;
}

beforeEach(() => {
  vi.clearAllMocks();
  cancelJobs.mockResolvedValue({ ok: true, affected: 1 });
  deleteJobs.mockResolvedValue({ ok: true, deleted: 1, stopping: [] });
});

describe("<JobActions>", () => {
  it("shows Cancel for a still-active job", () => {
    renderWithProviders(<JobActions job={{ id: 1, status: "running" }} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("hides Cancel once the job is terminal", () => {
    renderWithProviders(<JobActions job={{ id: 1, status: "completed" }} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBe(null);
  });

  it("cancels the job and refreshes", async () => {
    renderWithProviders(<JobActions job={{ id: 5, status: "pending" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(cancelJobs).toHaveBeenCalledWith([5]));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Cancellation requested for 1 job"),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("deletes the job and navigates back to the list", async () => {
    renderWithProviders(<JobActions job={{ id: 5, status: "completed" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteJobs).toHaveBeenCalledWith([5]));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("1 job deleted"));
    expect(push).toHaveBeenCalledWith("/jobs");
  });

  it("waits for a running job to stop before deleting and navigating away", async () => {
    deleteJobs
      .mockResolvedValueOnce({ ok: true, deleted: 0, stopping: [5] })
      .mockResolvedValueOnce({ ok: true, deleted: 1, stopping: [] });
    getJobsStatus.mockResolvedValue([{ id: 5, status: "cancelled" }]);

    renderWithProviders(<JobActions job={{ id: 5, status: "running" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(getJobsStatus).toHaveBeenCalledWith([5]));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/jobs"));
  });
});
