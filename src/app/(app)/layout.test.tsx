import { describe, expect, it, vi } from "vitest";

import type { User } from "@/lib/db/schema";
import { renderWithProviders } from "@/test/render";
import { setPathname } from "@/test/next-navigation";

import AppLayout from "./layout";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

/**
 * The session read, stubbed -- and only the session read.
 *
 * `@/lib/auth/session` is request-scoped plumbing (`next/headers`) over a
 * native SQLite driver, neither of which belongs in a jsdom test; what this
 * file is about is what the *chrome* does with the answer. The derivation
 * itself is not stubbed: the layout calls the real `isAdminRole()` from
 * `@/lib/auth/roles`, which is a dependency-free module for exactly this
 * reason, so a test asserting on role `"user"` is asserting against the same
 * array the `admin()` plugin is configured with. `requireUser()`'s own
 * behaviour -- who it returns, when it redirects, what it refuses -- is covered
 * for real against a database in `src/lib/auth/session.test.ts`.
 */
const { signedInUser } = vi.hoisted(() => ({ signedInUser: { current: {} as User } }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: () => Promise.resolve(signedInUser.current),
}));

function signInAs(role: string): void {
  signedInUser.current = { id: "u1", email: "someone@example.com", role } as User;
}

/**
 * `AppLayout` is an async server component, which testing-library cannot
 * render. Calling it and rendering what it resolves to is the one case where
 * that works: everything it returns is synchronous, so there is no reshaping of
 * production code involved -- see CLAUDE.md on why the data regions stay
 * untested instead.
 */
async function renderLayout() {
  return renderWithProviders(await AppLayout({ children: <p>content</p> }));
}

describe("the (app) layout", () => {
  it("renders exactly one <main> landmark", async () => {
    setPathname("/");
    signInAs("admin");

    const { container } = await renderLayout();

    expect(container.querySelectorAll("main")).toHaveLength(1);
  });

  it("shows admin-only navigation to an administrator", async () => {
    setPathname("/");
    signInAs("admin");

    const { container } = await renderLayout();

    expect(container.querySelector('a[href="/users"]')).not.toBe(null);
  });

  it("hides admin-only navigation from an ordinary user", async () => {
    // Phase 3 hard-coded `isAdmin`, so every user saw /users in the sidebar.
    // Cosmetic on its own -- the route itself is guarded by requireAdmin() --
    // but a nav item that 404s is a bug report waiting to happen.
    setPathname("/");
    signInAs("user");

    const { container } = await renderLayout();

    expect(container.querySelector('a[href="/users"]')).toBe(null);
    // Control: the rest of the navigation is still there, so the assertion
    // above cannot pass because nothing rendered at all.
    expect(container.querySelector('a[href="/settings"]')).not.toBe(null);
  });
});
