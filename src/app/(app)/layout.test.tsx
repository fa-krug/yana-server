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
  // The footer reads the *row*, not the cached session -- see the layout's
  // comment. Both stubs answer with the same fixture here; what the difference
  // buys is covered against a real database in src/lib/account/account.test.ts.
  currentUserRow: () => Promise.resolve(signedInUser.current),
}));

function signInAs(role: string): void {
  // The five columns the footer's <UserAvatar> reads, plus the role the nav
  // filter needs. Real values rather than a bare cast: initialsFor() reads the
  // two name columns, which are notNull in the schema, so a partial fixture
  // throws where the app would not.
  signedInUser.current = {
    id: "Nu2fXJ3rQKp1sVdWyBz0aLcMhE7tG4iO",
    email: "someone@example.com",
    firstName: "Ada",
    lastName: "Lovelace",
    image: null,
    role,
  } as User;
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

  it("puts a profile entry in the footer, with the name and an avatar", async () => {
    setPathname("/");
    signInAs("user");

    const { container } = await renderLayout();

    const profile = container.querySelector('a[href="/account"]');
    expect(profile).not.toBe(null);
    expect(profile?.textContent).toContain("Ada Lovelace");
    // The avatar comes along: <UserAvatar> paints the initials fallback, which
    // is the whole of what renders before an image load resolves.
    expect(profile?.querySelector("[data-slot=avatar-fallback]")?.textContent).toBe("AL");
    // And it is *not* a second navigation item -- the footer is the one place
    // it appears, which is why /account is absent from NAV_ITEMS.
    expect(container.querySelectorAll('a[href="/account"]')).toHaveLength(1);
  });

  it("offers a way out, in the footer under the identity it ends", async () => {
    // Phase 4 shipped `signOut` in src/lib/auth/client.ts with no importer and
    // no catalog strings: sessions last 30 days and there was no way to end one
    // from the UI at all. This pins the button's *presence in the chrome* --
    // what it does on click is `sign-out-button.test.tsx`.
    setPathname("/");
    signInAs("user");

    const { container } = await renderLayout();

    const footer = container.querySelector("[data-slot=sidebar-footer]");
    expect(footer?.textContent).toContain("Sign out");
  });

  it("names an unnamed user by their address in the footer", async () => {
    // The bootstrap administrator has "" for both name columns, so a naive
    // `${firstName} ${lastName}` would render a blank row.
    setPathname("/");
    signedInUser.current = {
      ...signedInUser.current,
      firstName: "",
      lastName: "",
    } as User;

    const { container } = await renderLayout();

    expect(container.querySelector('a[href="/account"]')?.textContent).toContain(
      "someone@example.com",
    );
  });

  it("marks the profile entry active on /account and nowhere else", async () => {
    // Base UI writes a valueless `data-active` for a boolean state, so this
    // asserts on the attribute's presence rather than on "true".
    setPathname("/account");
    signInAs("user");
    const active = await renderLayout();
    expect(active.container.querySelector('a[href="/account"]')?.hasAttribute("data-active")).toBe(
      true,
    );
    active.unmount();

    setPathname("/settings");
    const inactive = await renderLayout();
    expect(
      inactive.container.querySelector('a[href="/account"]')?.hasAttribute("data-active"),
    ).toBe(false);
  });

  it("marks only the Dashboard nav entry active on /, never on another route", async () => {
    // `"/"` is a prefix of every path, so a naive `pathname.startsWith(href)`
    // would light up Dashboard everywhere -- this pins the fix in
    // `isNavItemActive()` (src/components/app-sidebar.tsx). The selector is
    // scoped to `[data-slot="sidebar-menu-button"]` because the sidebar header
    // also has a plain `<Link href="/">` (the "Yana" brand mark), which is not
    // a nav item and carries no `data-active`.
    setPathname("/");
    signInAs("user");
    const onRoot = await renderLayout();
    const dashboardLink = onRoot.container.querySelector(
      'a[data-slot="sidebar-menu-button"][href="/"]',
    );
    expect(dashboardLink?.hasAttribute("data-active")).toBe(true);
    onRoot.unmount();

    setPathname("/articles");
    const onArticles = await renderLayout();
    const dashboardLinkElsewhere = onArticles.container.querySelector(
      'a[data-slot="sidebar-menu-button"][href="/"]',
    );
    const articlesLink = onArticles.container.querySelector(
      'a[data-slot="sidebar-menu-button"][href="/articles"]',
    );
    expect(dashboardLinkElsewhere?.hasAttribute("data-active")).toBe(false);
    expect(articlesLink?.hasAttribute("data-active")).toBe(true);
  });
});
