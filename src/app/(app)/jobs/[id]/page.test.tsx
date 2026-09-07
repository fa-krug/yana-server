import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

/**
 * `/jobs/[id]` had no `page.test.ts` before the instant-render-no-fallback
 * migration -- added here because this route carries the one requirement
 * the migration's plan calls out by name: `getJobForCurrentUser()` already
 * collapses "no such job", "someone else's job" and "an ownerless job seen
 * by a non-admin" to the same `null` (see its own doc comment in
 * `src/lib/jobs/queries.ts`), and this page must not reintroduce a
 * distinction on top of that by rendering anything that lets the three be
 * told apart.
 */
vi.mock("@/lib/jobs/queries", () => ({ getJobForCurrentUser: vi.fn(async () => null) }));
vi.mock("@/lib/jobs/queue", () => ({ listJobLogs: vi.fn(() => []) }));
vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("next/server", () => ({ connection: () => Promise.resolve(undefined) }));
vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/jobs/actions", () => ({ cancelJobs: vi.fn(), deleteJobs: vi.fn() }));
vi.mock("@/lib/jobs/wait-for-jobs-terminal", () => ({ waitForJobsTerminal: vi.fn() }));

import JobDetailPage from "./page";

describe("/jobs/[id] page", () => {
  it("returns its element tree synchronously -- no awaited row read", () => {
    const result = JobDetailPage({ params: Promise.resolve({ id: "999999" }) });

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown })?.then).not.toBe("function");
  });

  it("renders the not-found state for an id with no visible job, instead of throwing", async () => {
    // `use()` suspends on the job-detail promise on the very first render,
    // then resumes once it settles -- a microtask-scale gap `act()` has to
    // span, or the resumed render commits outside any act scope and this
    // assertion races it (see the equivalent comment on
    // `src/components/settings/general-section.test.tsx`'s own `act()` use).
    await act(async () => {
      renderWithProviders(JobDetailPage({ params: Promise.resolve({ id: "999999" }) }));
    });

    expect(screen.getByText("Not found")).toBeTruthy();
    expect(
      screen.getByText("This item doesn't exist, or you don't have access to it."),
    ).toBeTruthy();
  });

  it("renders the same not-found state for a non-numeric id", async () => {
    await act(async () => {
      renderWithProviders(JobDetailPage({ params: Promise.resolve({ id: "not-a-number" }) }));
    });

    expect(screen.getByText("Not found")).toBeTruthy();
  });
});
