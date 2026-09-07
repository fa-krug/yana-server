import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { SectionCards, SectionCardsGate } from "./section-cards";

describe("SectionCards", () => {
  it("renders no Users card for a non-admin", () => {
    const { queryByRole } = renderWithProviders(<SectionCards isAdmin={false} />);

    expect(queryByRole("link", { name: /users/i })).toBeNull();
  });

  it("renders a Users card for an admin", () => {
    const { getByRole } = renderWithProviders(<SectionCards isAdmin={true} />);

    expect(getByRole("link", { name: /users/i })).not.toBeNull();
  });

  it("never renders a card linking to /", () => {
    const { container } = renderWithProviders(<SectionCards isAdmin={true} />);

    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).not.toContain("/");
  });

  it("translates labels and descriptions", () => {
    // German, because "Feeds" is spelled identically in both catalogs and
    // would prove nothing -- the section heading and a description are not.
    const { getByText } = renderWithProviders(<SectionCards isAdmin={false} />, {
      locale: "de",
    });

    expect(getByText("Verwalten")).not.toBeNull();
    expect(getByText("Abonnierte Feeds hinzufügen und bearbeiten.")).not.toBeNull();
  });
});

describe("SectionCardsGate", () => {
  it("renders the non-admin cards immediately, before the role promise resolves", async () => {
    let resolveIsAdmin!: (value: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolveIsAdmin = resolve;
    });

    // A deferred promise, resolved under an explicit `act()` -- same reason
    // `StatCards`' own test does this: React 19's `use()` registers its
    // continuation as a bare `.then()`, which lands outside any `act()` scope
    // unless the resolution itself is wrapped.
    let result!: ReturnType<typeof renderWithProviders>;
    await act(async () => {
      result = renderWithProviders(<SectionCardsGate promise={promise} />);
    });

    // Pending: the non-admin grid, never the admin-only /users card.
    expect(result.queryByRole("link", { name: /feeds/i })).not.toBeNull();
    expect(result.queryByRole("link", { name: /users/i })).toBeNull();

    await act(async () => {
      resolveIsAdmin(true);
      await promise;
    });

    // Resolved true: the admin-only card appears.
    expect(result.queryByRole("link", { name: /users/i })).not.toBeNull();
  });

  it("never shows the admin-only card when the role resolves to false", async () => {
    const promise = Promise.resolve(false);

    let result!: ReturnType<typeof renderWithProviders>;
    await act(async () => {
      result = renderWithProviders(<SectionCardsGate promise={promise} />);
      await promise;
    });

    expect(result.queryByRole("link", { name: /users/i })).toBeNull();
  });
});
