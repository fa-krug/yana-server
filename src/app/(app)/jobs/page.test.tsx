import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { JobsChrome } from "@/components/jobs/jobs-chrome";
import { JobsListRegion } from "@/components/jobs/jobs-list-region";

/**
 * `connection()` throws synchronously outside a real request scope -- see
 * `../settings/page.test.tsx` for why stubbing it as the request-time no-op it
 * resolves to in production is the faithful thing to do.
 */
vi.mock("next/server", () => ({ connection: () => Promise.resolve(undefined) }));

// `listJobsForCurrentUser()` reaches `requireUserFreshRole()` and then SQLite;
// none of that belongs in a jsdom test. What it decides is covered against a
// real database in `src/lib/jobs/queries.test.ts`; the point here is only that
// the page body never awaits it.
vi.mock("@/lib/jobs/queries", () => ({
  listJobsForCurrentUser: () => new Promise(() => {}),
}));

import JobsPage from "./page";

describe("JobsPage", () => {
  it("returns its element tree synchronously -- no awaited role read, searchParams or translation", () => {
    // The security-relevant half: `await requireUserFreshRole()` used to be
    // this body's first statement, and the owner filter was derived from it
    // here. Both moved into `listJobsForCurrentUser()`.
    const result = JobsPage({ searchParams: Promise.resolve({}) });

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown })?.then).not.toBe("function");
  });

  it("renders <JobsChrome> and <JobsListRegion>, sharing one searchParams promise", () => {
    const searchParams = Promise.resolve({ kind: "aggregate" });

    const result = JobsPage({ searchParams }) as ReactElement;
    const children = (result.props as { children: ReactElement[] }).children;
    const [chrome, listRegion] = children;

    expect(chrome.type).toBe(JobsChrome);
    expect(listRegion.type).toBe(JobsListRegion);

    const { tableBody, pagination, showOwner } = listRegion.props as {
      tableBody: ReactElement;
      pagination: ReactElement;
      showOwner: Promise<boolean>;
    };

    expect((tableBody.props as { searchParams: unknown }).searchParams).toBe(searchParams);
    expect((pagination.props as { searchParams: unknown }).searchParams).toBe(searchParams);
    // A promise, not an awaited boolean -- and one the page derives itself, so
    // what crosses to the Client Component is a `boolean` rather than the
    // `User` row the gate returns.
    expect(typeof showOwner.then).toBe("function");
  });
});
