import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { UsersChrome } from "@/components/users/users-chrome";
import { UsersListRegion } from "@/components/users/users-list-region";

/**
 * `connection()` throws synchronously outside a real request scope -- see
 * `../settings/page.test.tsx` for why stubbing it as the request-time no-op it
 * resolves to in production is the faithful thing to do.
 */
vi.mock("next/server", () => ({ connection: () => Promise.resolve(undefined) }));

// `listUsers()` reaches `requireAdmin()` and then SQLite; none of that belongs
// in a jsdom test. The point here is only that the page body never awaits it.
vi.mock("@/lib/users/queries", () => ({ listUsers: () => new Promise(() => {}) }));

import UsersPage from "./page";

/**
 * `UsersPage` renders two async Server Components declared inside `page.tsx`
 * (`UsersBody`, `UsersPagination`), which testing-library cannot mount -- so
 * this checks the returned element tree's shape directly, the same way
 * `../feeds/page.test.tsx` does.
 */
describe("UsersPage", () => {
  it("returns its element tree synchronously -- no awaited requireAdmin, searchParams or translation", () => {
    // The security-relevant half: `await requireAdmin()` used to be this
    // body's first statement. It is gone, and the gate now lives inside
    // `listUsers()`/`getUser()` (covered against a real database in
    // `src/lib/users/users.test.ts`). A page function that awaited anything
    // would return a Promise, which is what this rules out.
    const result = UsersPage({ searchParams: Promise.resolve({}) });

    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof (result as { then?: unknown })?.then).not.toBe("function");
  });

  it("renders <UsersChrome> and <UsersListRegion>, sharing one searchParams promise", () => {
    const searchParams = Promise.resolve({ q: "ada" });

    const result = UsersPage({ searchParams }) as ReactElement;
    const children = (result.props as { children: ReactElement[] }).children;
    const [chrome, listRegion] = children;

    expect(chrome.type).toBe(UsersChrome);
    expect(listRegion.type).toBe(UsersListRegion);

    const { tableBody, pagination } = listRegion.props as {
      tableBody: ReactElement;
      pagination: ReactElement;
    };

    // Both data regions were handed the *same* promise reference, which is
    // what `resolveParams`'s (and downstream `cachedListUsers`'s) `cache()`
    // dedupe keys on -- see `../feeds/page.test.tsx`.
    expect((tableBody.props as { searchParams: unknown }).searchParams).toBe(searchParams);
    expect((pagination.props as { searchParams: unknown }).searchParams).toBe(searchParams);
  });
});
