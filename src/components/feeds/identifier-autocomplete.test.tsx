import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";

import { renderWithProviders } from "@/test/render";
import { IdentifierAutocomplete } from "./identifier-autocomplete";

vi.mock("@/lib/aggregators/search", () => ({
  searchFeedIdentifier: vi.fn(),
}));

import { searchFeedIdentifier } from "@/lib/aggregators/search";

afterEach(() => {
  // `searchFeedIdentifier` is a plain `vi.fn()` from the module mock factory
  // above, not a `vi.spyOn()` spy -- `vi.restoreAllMocks()` only restores
  // spies and leaves a plain mock's call history (and any queued
  // `mockResolvedValue`) untouched, which let the next test see the previous
  // test's calls. `vi.clearAllMocks()` is what this codebase's other
  // `vi.mock()`-based component tests use for exactly that reason (see
  // `search-filter-bar.test.tsx`, `passkey-section.test.tsx`).
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("IdentifierAutocomplete", () => {
  it("shows the stored identifier as plain text on load", () => {
    renderWithProviders(
      <IdentifierAutocomplete aggregator="youtube" value="UC123" onValueChange={vi.fn()} />,
    );
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("UC123");
  });

  it("searches after 2 characters and lets the user pick a result", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(searchFeedIdentifier).mockResolvedValue({
      ok: true,
      results: [{ value: "UC123", label: "Linus Tech Tips (@ltt)" }],
    });

    const onValueChange = vi.fn();
    renderWithProviders(
      <IdentifierAutocomplete aggregator="youtube" value="" onValueChange={onValueChange} />,
    );

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "linus" } });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    await waitFor(() => expect(searchFeedIdentifier).toHaveBeenCalledWith("youtube", "linus"));

    const item = await screen.findByText("Linus Tech Tips (@ltt)");
    fireEvent.pointerDown(item);
    fireEvent.click(item);

    expect(onValueChange).toHaveBeenCalledWith("UC123");
  });

  it("does not search below 2 characters", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderWithProviders(
      <IdentifierAutocomplete aggregator="reddit" value="" onValueChange={vi.fn()} />,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "a" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(searchFeedIdentifier).not.toHaveBeenCalled();
  });

  it("disables the input when disabled is passed", () => {
    renderWithProviders(
      <IdentifierAutocomplete aggregator="reddit" value="" onValueChange={vi.fn()} disabled />,
    );
    expect((screen.getByRole("combobox") as HTMLInputElement).disabled).toBe(true);
  });

  it("invalidates a stale in-flight request when the query drops below the threshold", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Controls exactly when the first ("linus") search resolves, so the test
    // can force it to resolve *after* the query has already been cleared
    // back below the 2-character threshold.
    let resolveFirstSearch!: (value: {
      ok: true;
      results: { value: string; label: string }[];
    }) => void;
    const firstSearch = new Promise<{ ok: true; results: { value: string; label: string }[] }>(
      (resolve) => {
        resolveFirstSearch = resolve;
      },
    );
    vi.mocked(searchFeedIdentifier)
      .mockReturnValueOnce(firstSearch)
      // Any later ("li") search is left permanently pending: this test's
      // point is that the *first* request's stale result must not reappear,
      // not that a second request ever completes.
      .mockReturnValue(new Promise(() => {}));

    renderWithProviders(
      <IdentifierAutocomplete aggregator="youtube" value="" onValueChange={vi.fn()} />,
    );

    const input = screen.getByRole("combobox");

    // Type a real query -- schedules the debounced search.
    fireEvent.change(input, { target: { value: "linus" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(searchFeedIdentifier).toHaveBeenCalledWith("youtube", "linus"));

    // Delete back below the threshold *before* that request resolves.
    fireEvent.change(input, { target: { value: "l" } });

    // Now let the stale "linus" request resolve.
    await act(async () => {
      resolveFirstSearch({
        ok: true,
        results: [{ value: "UC123", label: "Linus Tech Tips (@ltt)" }],
      });
      await firstSearch;
    });

    // Reopen by typing a fresh searchable query; its own request never
    // resolves in this test, so anything rendered now can only have come
    // from state the (invalidated) first request left behind.
    fireEvent.change(input, { target: { value: "li" } });

    expect(screen.queryByText("Linus Tech Tips (@ltt)")).toBeNull();
  });
});
