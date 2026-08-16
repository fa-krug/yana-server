import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { AboutSection } from "./about-section";

describe("<AboutSection>", () => {
  it("links to the source repository and the issue tracker", () => {
    renderWithProviders(<AboutSection />);

    expect(screen.getByRole("link", { name: "Source code" }).getAttribute("href")).toBe(
      "https://github.com/fa-krug/yana-server",
    );
    expect(screen.getByRole("link", { name: "Report an issue" }).getAttribute("href")).toBe(
      "https://github.com/fa-krug/yana-server/issues",
    );
  });

  it("links to the generated API documentation", () => {
    renderWithProviders(<AboutSection />);

    expect(screen.getByRole("link", { name: "API documentation" }).getAttribute("href")).toBe(
      "/api-docs",
    );
  });
});
