import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setPathname, setRouter, setSearchParams } from "@/test/next-navigation";
import type { JobWithOwner } from "@/lib/jobs/queue";

import { JobsTable } from "./jobs-table";

// The shared router stub, never an inline factory -- see the comment at the
// top of src/test/next-navigation.ts. jobs-table.tsx calls useRouter() for
// router.refresh(), and DataTable's useListParams() calls
// usePathname()/useSearchParams() unconditionally, so a hand-rolled
// `{ useRouter }` mock would break the moment either reaches an export it
// didn't declare.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

const { cancelJobs, deleteJobs } = vi.hoisted(() => ({
  cancelJobs: vi.fn(),
  deleteJobs: vi.fn(),
}));
vi.mock("@/lib/jobs/actions", () => ({ cancelJobs, deleteJobs }));

// `waitForJobsTerminal()` now opens a real `EventSource` (`/api/jobs/status-stream`);
// this file is testing `<JobsTable>`'s own orchestration around it (wait, then
// delete again, then toast), not that transport -- which has its own tests
// (`src/lib/jobs/wait-for-jobs-terminal.test.tsx` and the route's own test).
const { waitForJobsTerminal } = vi.hoisted(() => ({ waitForJobsTerminal: vi.fn() }));
vi.mock("@/lib/jobs/wait-for-jobs-terminal", () => ({ waitForJobsTerminal }));

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
setRouter({ refresh });

const { toastError, toastInfo, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { error: toastError, info: toastInfo, success: toastSuccess },
}));

function job(overrides: Partial<JobWithOwner> = {}): JobWithOwner {
  return {
    id: 1,
    runId: null,
    userId: null,
    kind: "aggregate",
    payload: {},
    status: "completed",
    attempts: 1,
    maxAttempts: 3,
    runAt: new Date("2026-08-01T00:00:00Z"),
    startedAt: new Date("2026-08-01T00:00:01Z"),
    finishedAt: new Date("2026-08-01T00:00:02Z"),
    progress: 100,
    error: "",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ownerEmail: null,
    ownerFirstName: null,
    ownerLastName: null,
    ...overrides,
  };
}

function selectFirstRow() {
  fireEvent.click(screen.getAllByRole("checkbox", { name: "Select this row" })[0]!);
}

function dialog(): HTMLElement {
  const popup = document.querySelector<HTMLElement>('[data-slot="alert-dialog-content"]');
  if (!popup) throw new Error("no confirmation dialog is open");
  return popup;
}

beforeEach(() => {
  vi.clearAllMocks();
  setPathname("/jobs");
  setSearchParams("");
  cancelJobs.mockResolvedValue({ ok: true, affected: 1 });
  deleteJobs.mockResolvedValue({ ok: true, deleted: 1, stopping: [] });
  waitForJobsTerminal.mockResolvedValue(true);
});

describe("JobsTable", () => {
  it("links each row's kind to its detail page", () => {
    renderWithProviders(
      <JobsTable rows={[job({ id: 42, kind: "aggregate" })]} page={1} pageSize={50} total={1} />,
    );

    expect(screen.getByRole("link", { name: "aggregate" }).getAttribute("href")).toBe("/jobs/42");
  });

  it("hides the owner column when showOwner is false", () => {
    renderWithProviders(
      <JobsTable
        rows={[
          job({ ownerEmail: "a@example.com", ownerFirstName: "Ada", ownerLastName: "Lovelace" }),
        ]}
        page={1}
        pageSize={50}
        total={1}
      />,
    );

    expect(screen.queryByText("Ada Lovelace")).toBeNull();
  });

  it("shows the owner's name when showOwner is true, and a system fallback for ownerless jobs", () => {
    renderWithProviders(
      <JobsTable
        rows={[
          job({
            id: 1,
            ownerEmail: "a@example.com",
            ownerFirstName: "Ada",
            ownerLastName: "Lovelace",
          }),
          job({ id: 2, kind: "retention", ownerEmail: null }),
        ]}
        page={1}
        pageSize={50}
        total={2}
        showOwner
      />,
    );

    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("System")).toBeTruthy();
  });

  it("cancels the selection and reports how many were affected", async () => {
    renderWithProviders(
      <JobsTable rows={[job({ id: 7, status: "pending" })]} page={1} pageSize={50} total={1} />,
    );
    selectFirstRow();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(cancelJobs).toHaveBeenCalledWith([7]));
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Cancellation requested for 1 job"),
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("reports nothing to cancel when none of the selection was affected", async () => {
    cancelJobs.mockResolvedValue({ ok: true, affected: 0 });
    renderWithProviders(
      <JobsTable rows={[job({ id: 7, status: "completed" })]} page={1} pageSize={50} total={1} />,
    );
    selectFirstRow();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(toastInfo).toHaveBeenCalledWith("Nothing to cancel — those jobs already finished."),
    );
  });

  it("deletes the selection immediately when nothing needs to stop first", async () => {
    renderWithProviders(
      <JobsTable rows={[job({ id: 9, status: "completed" })]} page={1} pageSize={50} total={1} />,
    );
    selectFirstRow();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteJobs).toHaveBeenCalledWith([9]));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("1 job deleted"));
    expect(waitForJobsTerminal).not.toHaveBeenCalled();
  });

  it("closes the confirmation immediately for a running job, finishing the deletion in the background", async () => {
    deleteJobs
      .mockResolvedValueOnce({ ok: true, deleted: 0, stopping: [9] })
      .mockResolvedValueOnce({ ok: true, deleted: 1, stopping: [] });
    let resolveWait: (stopped: boolean) => void = () => {};
    waitForJobsTerminal.mockReturnValue(
      new Promise((resolve) => {
        resolveWait = resolve;
      }),
    );

    renderWithProviders(
      <JobsTable rows={[job({ id: 9, status: "running" })]} page={1} pageSize={50} total={1} />,
    );
    selectFirstRow();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(dialog()).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(waitForJobsTerminal).toHaveBeenCalledWith([9]));
    // The dialog closes right away -- it does not stay open for however long
    // the running job actually takes to stop.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="alert-dialog-content"]')).toBeNull(),
    );
    expect(deleteJobs).toHaveBeenCalledTimes(1);
    expect(toastSuccess).not.toHaveBeenCalled();

    resolveWait(true);
    await waitFor(() => expect(deleteJobs).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("1 job deleted"));
  });
});
