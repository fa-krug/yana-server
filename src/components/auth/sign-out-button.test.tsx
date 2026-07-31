import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SidebarMenu, SidebarMenuItem, SidebarProvider } from "@/components/ui/sidebar";
import { renderWithProviders } from "@/test/render";

import { SignOutButton } from "./sign-out-button";

/**
 * The Better Auth browser client, stubbed -- it is a `fetch` wrapper over an
 * endpoint no jsdom test can serve, and what it does is exercised for real by
 * `src/lib/auth/server.test.ts`. What this file is about is what the *button*
 * does with the answer, and above all that it performs a **full document
 * navigation** rather than a soft one.
 */
const { signOut } = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock("@/lib/auth/client", () => ({ signOut }));

const { replaceLocation } = vi.hoisted(() => ({ replaceLocation: vi.fn() }));
vi.mock("@/lib/browser-location", () => ({ replaceLocation }));

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * `SidebarMenuButton` reads `useSidebar()`, so the provider is part of the
 * component's real context rather than test scaffolding -- the button ships
 * inside the sidebar footer and nowhere else.
 */
function renderInSidebar(options?: { locale?: "en" | "de" }) {
  return renderWithProviders(
    <SidebarProvider>
      <SidebarMenu>
        <SidebarMenuItem>
          <SignOutButton />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarProvider>,
    options,
  );
}

describe("<SignOutButton>", () => {
  it("renders a labelled control in the active locale", () => {
    // Asserted against de.json: "Sign out" is close enough to the key that
    // English would not prove the string comes from a catalog at all.
    const { container } = renderInSidebar({ locale: "de" });

    expect(container.textContent).toContain("Abmelden");
  });

  it("signs out and then leaves by a full document navigation", async () => {
    signOut.mockResolvedValue({ error: null });
    renderInSidebar();

    fireEvent.click(screen.getByText("Sign out"));

    await vi.waitFor(() => expect(replaceLocation).toHaveBeenCalledWith("/login"));
    expect(signOut).toHaveBeenCalled();
    // The property that matters, and the reason `replaceLocation` exists: the
    // root layout owns <html lang>, the intl provider and the theme, and a
    // `router.replace()` never re-renders it -- so the sign-in page would be
    // wrapped in chrome built for the person who just left. Phase 4 already
    // fixed exactly this on the way *in*.
    expect(toastError).not.toHaveBeenCalled();
  });

  it("stays put and says so when the endpoint refuses", async () => {
    signOut.mockResolvedValue({ error: { status: 500 } });
    renderInSidebar({ locale: "de" });

    fireEvent.click(screen.getByText("Abmelden"));

    await vi.waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "Abmeldung fehlgeschlagen. Bitte versuche es erneut.",
      ),
    );
    expect(replaceLocation).not.toHaveBeenCalled();
    // Re-enabled: a dead button is the one failure mode that leaves a user with
    // no way out at all. Same deadlock phase 4 fixed on the login form.
    expect(screen.getByText("Abmelden").closest("button")?.disabled).toBe(false);
  });

  it("survives a call that rejects instead of returning", async () => {
    // `@better-fetch/fetch` converts HTTP failures into `{ data, error }` but
    // leaves its own `await fetch(...)` unwrapped, so a restarting container
    // *rejects*. Unhandled, that leaves the button disabled forever.
    signOut.mockRejectedValue(new TypeError("fetch failed"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      renderInSidebar();

      fireEvent.click(screen.getByText("Sign out"));

      await vi.waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("Could not sign out. Please try again."),
      );
      expect(replaceLocation).not.toHaveBeenCalled();
      expect(screen.getByText("Sign out").closest("button")?.disabled).toBe(false);
    } finally {
      logged.mockRestore();
    }
  });
});
