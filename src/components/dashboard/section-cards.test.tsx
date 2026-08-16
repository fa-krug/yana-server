import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { SectionCards } from "./section-cards";

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
