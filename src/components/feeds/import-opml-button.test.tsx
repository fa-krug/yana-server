import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { importOpmlFeeds, previewOpmlImport } from "@/lib/feeds/actions";
import { setRouter } from "@/test/next-navigation";
import { ImportOpmlButton } from "./import-opml-button";

vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/feeds/actions", () => ({
  previewOpmlImport: vi.fn(),
  importOpmlFeeds: vi.fn(),
}));

function selectFile(content: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([content], "feeds.opml", { type: "text/xml" });
  fireEvent.change(input, { target: { files: [file] } });
}

describe("ImportOpmlButton", () => {
  it("shows an error toast and no dialog when the file doesn't parse", async () => {
    vi.mocked(previewOpmlImport).mockResolvedValue({ ok: false, errorKey: "invalidOpmlFile" });
    renderWithProviders(<ImportOpmlButton />);

    selectFile("not opml");

    await waitFor(() => expect(previewOpmlImport).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /import \d/i })).toBeNull();
  });

  it("opens a preview dialog listing every entry with its status", async () => {
    vi.mocked(previewOpmlImport).mockResolvedValue({
      ok: true,
      entries: [
        {
          name: "Heise",
          identifier: "https://heise.de",
          aggregatorLabel: "Full Website",
          tags: [],
          status: "new",
        },
        {
          name: "Old",
          identifier: "https://old.example",
          aggregatorLabel: "Full Website",
          tags: [],
          status: "duplicate",
        },
        {
          name: "Broken",
          identifier: "https://broken.example",
          aggregatorLabel: "Full Website",
          tags: [],
          status: "invalid",
          reasonKey: "importReasonInvalidOptions",
        },
      ],
    });
    renderWithProviders(<ImportOpmlButton />);

    selectFile("<opml></opml>");

    expect(await screen.findByText("Heise")).toBeTruthy();
    expect(screen.getByText("Old")).toBeTruthy();
    expect(screen.getByText("Broken")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import 1 feed" })).toBeTruthy();
  });

  it("disables the confirm button when nothing is new", async () => {
    vi.mocked(previewOpmlImport).mockResolvedValue({
      ok: true,
      entries: [
        {
          name: "Old",
          identifier: "https://old.example",
          aggregatorLabel: "Full Website",
          tags: [],
          status: "duplicate",
        },
      ],
    });
    renderWithProviders(<ImportOpmlButton />);

    selectFile("<opml></opml>");

    const confirmButton = await screen.findByRole("button", { name: "Import 0 feeds" });
    expect(confirmButton.hasAttribute("disabled")).toBe(true);
  });

  it("imports and closes the dialog on confirm", async () => {
    vi.mocked(previewOpmlImport).mockResolvedValue({
      ok: true,
      entries: [
        {
          name: "Heise",
          identifier: "https://heise.de",
          aggregatorLabel: "Full Website",
          tags: [],
          status: "new",
        },
      ],
    });
    vi.mocked(importOpmlFeeds).mockResolvedValue({ ok: true, imported: 1, skipped: 0 });
    setRouter({ refresh: vi.fn() });
    renderWithProviders(<ImportOpmlButton />);

    selectFile("<opml></opml>");
    fireEvent.click(await screen.findByRole("button", { name: "Import 1 feed" }));

    await waitFor(() => expect(importOpmlFeeds).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("button", { name: /import \d/i })).toBeNull());
  });
});
