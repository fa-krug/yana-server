import { act, fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountOverview, DeviceSummary } from "@/lib/account/queries";
import { setRouter } from "@/test/next-navigation";
import { renderWithProviders } from "@/test/render";

import { DeviceSection, DeviceSectionForm } from "./device-section";

const { removeDevice } = vi.hoisted(() => ({ removeDevice: vi.fn() }));
vi.mock("@/lib/account/actions", () => ({ removeDevice }));

/**
 * The shared router stub, not an inline factory -- see `passkey-section.test.tsx`
 * for why: `vi.mock` replaces the whole module, so a hand-rolled `{ useRouter }`
 * breaks the moment anything in the tree reaches another export, which is
 * exactly what happened when `attempt()` started calling `unstable_rethrow`.
 */
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => import("@/test/next-navigation"));
setRouter({ refresh });

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: toastError, success: toastSuccess } }));

const PHONE: DeviceSummary = {
  id: "sess1",
  deviceName: "iPhone",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

describe("<DeviceSection>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    removeDevice.mockResolvedValue({ ok: true });
  });

  it("says so when there are none", () => {
    const { container } = renderWithProviders(<DeviceSectionForm devices={[]} />);

    expect(container.textContent).toContain("No devices are paired yet.");
  });

  it("lists each device with a locale-formatted date and a revoke button", () => {
    // Both locales, the same reason passkey-section.test.tsx checks both: the
    // point is that the date goes through next-intl's formatter rather than a
    // hand-rolled template.
    const german = renderWithProviders(<DeviceSectionForm devices={[PHONE]} />, { locale: "de" });
    expect(german.container.textContent).toContain("iPhone");
    expect(german.container.textContent).toContain("Gekoppelt am 01.01.2026");
    german.unmount();

    renderWithProviders(<DeviceSectionForm devices={[PHONE]} />);
    expect(screen.getByText("iPhone")).toBeDefined();
    expect(screen.getByText("Paired Jan 1, 2026")).toBeDefined();
    expect(screen.getByRole("button", { name: /revoke/i })).toBeDefined();
  });

  it("revokes a device and refreshes the list on success", async () => {
    renderWithProviders(<DeviceSectionForm devices={[PHONE]} />);

    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    await vi.waitFor(() => expect(removeDevice).toHaveBeenCalledWith({ id: "sess1" }));
    await vi.waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Device revoked"));
    // The list comes from a server component, so nothing re-renders without it.
    expect(refresh).toHaveBeenCalled();
  });

  it("reports a failure without refreshing", async () => {
    removeDevice.mockResolvedValue({ ok: false });
    renderWithProviders(<DeviceSectionForm devices={[PHONE]} />);

    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

    await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith("Could not revoke that device"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("survives a revoke that rejects instead of returning", async () => {
    removeDevice.mockRejectedValue(new Error("Failed to fetch"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      renderWithProviders(<DeviceSectionForm devices={[PHONE]} />);

      fireEvent.click(screen.getByRole("button", { name: /revoke/i }));

      await vi.waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          "The server did not answer. Check your connection and try again.",
        ),
      );
      // Still mounted -- the rejection did not take the card with it.
      expect(screen.getByText("iPhone")).toBeDefined();
    } finally {
      logged.mockRestore();
    }
  });

  it("renders the real chassis, with a skeleton for the list, while it is still loading", () => {
    // Only the list's row count is genuinely unknowable, unlike a field's
    // value -- see the <Skeleton> assertion below -- so the heading renders
    // for real and the list alone still shows a loading affordance.
    renderWithProviders(<DeviceSectionForm pending />);

    expect(document.querySelector('[data-slot="skeleton"]')).toBeTruthy();
    expect(screen.getByText("Devices")).toBeTruthy();
  });

  it("shows the resolved list once the promise settles", async () => {
    // A deferred promise, resolved under an explicit `act()` -- React 19's
    // `use()` registers its continuation as a bare promise `.then()`, which
    // lands outside any `act()` scope unless the resolution itself is
    // wrapped.
    let resolveOverview!: (value: AccountOverview) => void;
    const promise = new Promise<AccountOverview>((resolve) => {
      resolveOverview = resolve;
    });

    await act(async () => {
      renderWithProviders(<DeviceSection promise={promise} />);
    });

    expect(document.querySelector('[data-slot="skeleton"]')).toBeTruthy();

    await act(async () => {
      resolveOverview({
        user: {} as unknown as AccountOverview["user"],
        passkeys: [],
        devices: [PHONE],
        hasPassword: true,
      });
      await promise;
    });

    expect(screen.getByText("iPhone")).toBeTruthy();
    expect(document.querySelector('[data-slot="skeleton"]')).toBeNull();
  });
});
