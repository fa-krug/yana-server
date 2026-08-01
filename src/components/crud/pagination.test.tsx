import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setPathname, setSearchParams } from "@/test/next-navigation";

import { Pagination } from "./pagination";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

beforeEach(() => {
  setPathname("/users");
  setSearchParams("");
});

describe("<Pagination>", () => {
  it("reports the range it is showing", () => {
    setSearchParams("page=2");
    renderWithProviders(<Pagination page={2} pageSize={25} total={63} />, { locale: "de" });

    expect(screen.getByText("26–50 von 63")).toBeTruthy();
  });

  it("carries the search and the sort into the next page", () => {
    // A pagination link that dropped the query would page through a different
    // list than the one on screen.
    setSearchParams("q=ada&sort=name&dir=desc&page=2");
    renderWithProviders(<Pagination page={2} pageSize={25} total={63} />);

    expect(screen.getByRole("link", { name: "Next page" }).getAttribute("href")).toBe(
      "/users?q=ada&page=3&sort=name&dir=desc",
    );
  });

  it("offers no way past either end", () => {
    // A disabled <button>, not a styled <a>: an anchor has no disabled state,
    // and on page one it would happily navigate to ?page=0.
    renderWithProviders(<Pagination page={1} pageSize={25} total={10} />);

    expect(screen.queryByRole("link", { name: "Previous page" })).toBe(null);
    expect(screen.queryByRole("link", { name: "Next page" })).toBe(null);
    expect(screen.getByRole("button", { name: "Previous page" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("renders nothing for an empty result set", () => {
    // The table already says the list is empty.
    const { container } = renderWithProviders(<Pagination page={1} pageSize={25} total={0} />);

    expect(container.textContent).toBe("");
  });
});
