import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import type { Tag } from "@/lib/db/schema";

import { EditTagSection } from "./edit-tag-section";

vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/tags/actions", () => ({
  createTag: vi.fn(),
  updateTag: vi.fn(),
  deleteTags: vi.fn(),
}));
vi.mock("@/components/tags/use-tag-usage", () => ({ useTagUsage: () => ({ feeds: 0 }) }));

const tag: Tag = {
  id: 7,
  name: "Example tag",
  color: "blue",
  userId: "user-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

/**
 * The happy path: `edit-tag-section.tsx` had only a not-found-shaped
 * verification before this (via `/tags/[id]/page.test.tsx`'s mocked
 * `getTag() => null`) -- a regression that made this component always render
 * `<RecordNotFound>` regardless of what the tag promise resolved to would
 * have shipped green. This pins the resolved path.
 */
describe("EditTagSection", () => {
  it("renders the real form and title once the tag promise resolves", async () => {
    // `use()` suspends on the tag promise on the very first render, then
    // resumes once it settles -- a microtask-scale gap `act()` has to span
    // (see the equivalent comment on
    // `src/components/settings/general-section.test.tsx`'s own `act()` use).
    await act(async () => {
      renderWithProviders(<EditTagSection tagPromise={Promise.resolve(tag)} />);
    });

    expect(screen.getByText("Edit tag")).toBeTruthy();
    expect(screen.getByDisplayValue("Example tag")).toBeTruthy();
    expect(screen.queryByText("Not found")).toBeNull();
  });

  it("renders the not-found state when the tag promise resolves to null", async () => {
    await act(async () => {
      renderWithProviders(<EditTagSection tagPromise={Promise.resolve(null)} />);
    });

    expect(screen.getByText("Not found")).toBeTruthy();
  });
});
