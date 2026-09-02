import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import { JobDetailSection, type JobDetail } from "./job-detail-section";

vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/jobs/actions", () => ({ cancelJobs: vi.fn(), deleteJobs: vi.fn() }));
vi.mock("@/lib/jobs/wait-for-jobs-terminal", () => ({ waitForJobsTerminal: vi.fn() }));

/**
 * jsdom does not implement `EventSource`, which `<JobLogViewer>` (rendered by
 * the resolved detail view) opens on mount -- see the equivalent stub and
 * comment in `job-log-viewer.test.tsx`. This test never asserts on the log
 * stream itself, so a bare no-op stand-in is enough.
 */
class FakeEventSource {
  addEventListener(): void {}
  close(): void {}
}
vi.stubGlobal("EventSource", FakeEventSource);

const detail: JobDetail = {
  job: {
    id: 42,
    kind: "aggregate",
    status: "completed",
    attempts: 1,
    maxAttempts: 3,
    progress: 100,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  },
  logs: [],
  feedId: 0,
  feed: undefined,
  articleId: 0,
  article: undefined,
};

/**
 * The happy path: `job-detail-section.tsx` had only a not-found-shaped
 * verification before this (via `/jobs/[id]/page.test.tsx`'s mocked
 * `getJobForCurrentUser() => null`) -- a regression that made this component
 * always render `<RecordNotFound>` regardless of what the job-detail promise
 * resolved to would have shipped green. This pins the resolved path.
 */
describe("JobDetailSection", () => {
  it("renders the real detail view once the job-detail promise resolves", async () => {
    // `use()` suspends on the job-detail promise on the very first render,
    // then resumes once it settles -- a microtask-scale gap `act()` has to
    // span (see the equivalent comment on
    // `src/components/settings/general-section.test.tsx`'s own `act()` use).
    await act(async () => {
      renderWithProviders(<JobDetailSection jobDetailPromise={Promise.resolve(detail)} />);
    });

    // No page <h1>: the breadcrumb already names the route. The kind and
    // status fields are what prove the resolved job reached the view.
    expect(screen.queryByText("Job #42")).toBeNull();
    expect(screen.getByText("aggregate")).toBeTruthy();
    expect(screen.queryByText("Not found")).toBeNull();
  });

  it("renders the not-found state when the job-detail promise resolves to null", async () => {
    await act(async () => {
      renderWithProviders(<JobDetailSection jobDetailPromise={Promise.resolve(null)} />);
    });

    expect(screen.getByText("Not found")).toBeTruthy();
  });
});
