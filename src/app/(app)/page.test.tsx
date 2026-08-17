import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

/**
 * Never-resolving promises, the same shape `StatCards`/`RecentArticles`'
 * own suspense tests use: the point of this test is only that the page body
 * itself never awaits any of these.
 */
vi.mock("@/lib/dashboard/queries", () => ({
  getDashboardStats: () => new Promise(() => {}),
  getRecentUnreadArticles: () => new Promise(() => {}),
}));

vi.mock("@/lib/auth/session", () => ({
  requireUserFreshRole: () => new Promise(() => {}),
}));

/**
 * `connection()` throws synchronously outside a real request scope -- see
 * `src/app/(app)/settings/page.test.ts` for why stubbing it as the
 * request-time no-op it resolves to in production is faithful rather than
 * avoidant.
 */
vi.mock("next/server", () => ({ connection: () => Promise.resolve(undefined) }));

import DashboardPage from "./page";

describe("DashboardPage", () => {
  it("returns its element tree synchronously -- no awaited translation, role or query", () => {
    // A page function that awaits anything returns a Promise, which
    // testing-library cannot render at all (see CLAUDE.md: "async server
    // components cannot be rendered by testing-library"). Calling it and
    // getting a plain element back, not a thenable, is what proves the body
    // has no remaining await.
    const result = DashboardPage();

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown })?.then).not.toBe("function");
  });

  it("renders the <DashboardTitle> heading with no fallback frame", () => {
    const result = DashboardPage();

    const { getByText } = renderWithProviders(result as ReactElement);

    expect(getByText("Dashboard")).toBeTruthy();
  });

  it("renders the non-admin section cards immediately, never the admin-only ones", () => {
    const result = DashboardPage();

    const { getByText, queryByText } = renderWithProviders(result as ReactElement);

    expect(getByText("Manage")).toBeTruthy();
    expect(queryByText("Manage user accounts on this instance.")).toBeNull();
  });
});
