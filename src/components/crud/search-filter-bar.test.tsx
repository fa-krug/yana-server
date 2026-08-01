import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setPathname, setRouter, setSearchParams } from "@/test/next-navigation";

import { SearchFilterBar } from "./search-filter-bar";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const { replace, push } = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));

const ROLES = {
  key: "role",
  label: "Rolle",
  // An empty value is how a filter is cleared: buildListHref omits it, so the
  // URL loses `role` entirely rather than gaining `role=all`.
  options: [
    { value: "", label: "Alle Rollen" },
    { value: "admin", label: "Administrator" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  setPathname("/users");
  setSearchParams("");
  setRouter({ replace, push });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("<SearchFilterBar>", () => {
  it("debounces typing into a single replace", () => {
    // `replace`, not `push`: one navigation per keystroke would bury the page
    // the operator came from under a word's worth of history entries.
    renderWithProviders(<SearchFilterBar placeholder="Search users" />);

    const input = screen.getByRole("searchbox", { name: "Search users" });
    fireEvent.change(input, { target: { value: "a" } });
    fireEvent.change(input, { target: { value: "ad" } });
    fireEvent.change(input, { target: { value: "ada" } });

    // Nothing yet: the pause has not elapsed.
    expect(replace).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(300));

    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/users?q=ada");
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps the sort and the other filters when the search changes", () => {
    // A search must narrow the list, not silently reset how it is ordered.
    setSearchParams("sort=name&dir=desc&role=admin&page=4");
    renderWithProviders(<SearchFilterBar placeholder="Search users" filters={[ROLES]} />);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ada" } });
    act(() => void vi.advanceTimersByTime(300));

    // `page` is gone on purpose: a new query invalidates the page number.
    expect(replace).toHaveBeenCalledWith("/users?q=ada&sort=name&dir=desc&role=admin");
  });

  it("shows the filter's translated label on the collapsed trigger", () => {
    // Base UI resolves the trigger's text from the root's `items` alone. Without
    // it this would read "admin", and the popup being right would prove nothing
    // -- which is why `<Select>` now requires the prop.
    setSearchParams("role=admin");
    const { container } = renderWithProviders(
      <SearchFilterBar placeholder="Benutzer suchen" filters={[ROLES]} />,
      { locale: "de" },
    );

    expect(container.querySelector('[data-slot="select-value"]')?.textContent).toBe(
      "Administrator",
    );
  });

  it("shows the clearing option's label when the filter is absent from the URL", () => {
    // An unset filter is the empty string, and the option that clears it is an
    // ordinary option with `value: ""`. If Base UI treated that as "nothing
    // selected" the trigger would fall back to a placeholder and the bar would
    // look broken on the first visit to every list page.
    const { container } = renderWithProviders(
      <SearchFilterBar placeholder="Benutzer suchen" filters={[ROLES]} />,
      { locale: "de" },
    );

    expect(container.querySelector('[data-slot="select-value"]')?.textContent).toBe("Alle Rollen");
  });

  it("does not navigate after it has been unmounted", () => {
    // The operator may have left the list during the pause.
    const { unmount } = renderWithProviders(<SearchFilterBar placeholder="Search users" />);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "ada" } });
    unmount();
    act(() => void vi.advanceTimersByTime(300));

    expect(replace).not.toHaveBeenCalled();
  });
});
