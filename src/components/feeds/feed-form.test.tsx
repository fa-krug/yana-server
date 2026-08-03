import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { FeedForm } from "./feed-form";

vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/feeds/actions", () => ({ createFeed: vi.fn(), updateFeed: vi.fn() }));
vi.mock("@/lib/aggregators/search", () => ({ searchFeedIdentifier: vi.fn() }));

const ALL: import("@/lib/aggregators/specs").Capabilities = {
  youtube: true,
  reddit: true,
  ai: true,
};
const NONE: import("@/lib/aggregators/specs").Capabilities = {
  youtube: false,
  reddit: false,
  ai: false,
};

function selectAggregator(label: string) {
  fireEvent.click(screen.getByLabelText("Aggregator"));
  const option = screen.getByRole("option", { name: label });
  fireEvent.pointerDown(option);
  fireEvent.click(option);
}

describe("FeedForm identifier field", () => {
  it("renders nothing for a none-mode aggregator", () => {
    renderWithProviders(<FeedForm capabilities={ALL} allTags={[]} />);
    selectAggregator("Explosm");
    expect(screen.queryByLabelText("Feed")).toBeNull();
  });

  it("renders a plain text input for a url-mode aggregator", () => {
    renderWithProviders(<FeedForm capabilities={ALL} allTags={[]} />);
    selectAggregator("Full Website");
    expect(screen.getByLabelText("URL (Optional)")).toBeTruthy();
  });

  it("renders a dropdown for a choice-mode aggregator", () => {
    renderWithProviders(<FeedForm capabilities={ALL} allTags={[]} />);
    selectAggregator("Heise");
    expect(screen.getByRole("combobox", { name: "Feed (Optional)" })).toBeTruthy();
  });

  it("renders the autocomplete for a search-mode aggregator", () => {
    renderWithProviders(<FeedForm capabilities={ALL} allTags={[]} />);
    selectAggregator("YouTube");
    expect(screen.getByPlaceholderText("Type to search")).toBeTruthy();
  });

  it("resets the identifier to the new aggregator's default when switching", () => {
    renderWithProviders(<FeedForm capabilities={ALL} allTags={[]} />);
    selectAggregator("Heise");
    const heiseSelect = screen.getByRole("combobox", { name: "Feed (Optional)" });
    expect(heiseSelect.querySelector('[data-slot="select-value"]')?.textContent).toBe("Main Feed");

    selectAggregator("Merkur");
    const merkurSelect = screen.getByRole("combobox", { name: "Feed (Optional)" });
    expect(merkurSelect.querySelector('[data-slot="select-value"]')?.textContent).toBe("Main Feed");
  });

  it("hides youtube and reddit from the picker when neither integration is configured", () => {
    renderWithProviders(<FeedForm capabilities={NONE} allTags={[]} />);
    fireEvent.click(screen.getByLabelText("Aggregator"));
    expect(screen.queryByRole("option", { name: "YouTube" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Reddit" })).toBeNull();
  });

  it("keeps an existing feed's own aggregator in the picker, and disables the identifier field with a banner", () => {
    const feed = {
      id: 1,
      userId: "u1",
      name: "My Channel",
      aggregator: "youtube",
      identifier: "UC999",
      options: {},
      enabled: true,
      dailyLimit: 20,
      createdAt: new Date(),
      updatedAt: new Date(),
      tags: [],
    } as unknown as import("@/lib/db/schema").Feed & { tags: import("@/lib/db/schema").Tag[] };

    renderWithProviders(<FeedForm feed={feed} capabilities={NONE} allTags={[]} />);

    expect(screen.getByText(/integration is not configured/i)).toBeTruthy();
    expect((screen.getByPlaceholderText("Type to search") as HTMLInputElement).disabled).toBe(true);
  });
});
