import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { SettingsTitle } from "./settings-title";

describe("<SettingsTitle>", () => {
  it("renders the settings page heading from the real catalog", () => {
    renderWithProviders(<SettingsTitle />);

    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
  });
});
