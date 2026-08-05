import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import type { JobWithOwner } from "@/lib/jobs/queue";

import { JobsTable } from "./jobs-table";

// The shared router stub, never an inline factory -- see the comment at the
// top of src/test/next-navigation.ts. DataTable's useListParams() calls
// usePathname()/useSearchParams() unconditionally, so this is needed even
// though the test never sets a pathname or query string.
vi.mock("next/navigation", () => import("@/test/next-navigation"));

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
        rows={[job({ ownerEmail: "a@example.com", ownerFirstName: "Ada", ownerLastName: "Lovelace" })]}
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
});
