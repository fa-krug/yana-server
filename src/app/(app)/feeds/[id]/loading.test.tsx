import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";

import Loading from "./loading";

vi.mock("next/navigation", async () => import("@/test/next-navigation"));
vi.mock("@/lib/feeds/actions", () => ({
  createFeed: vi.fn(),
  updateFeed: vi.fn(),
  updateFeedsBulk: vi.fn(),
}));
vi.mock("@/lib/aggregators/search", () => ({ searchFeedIdentifier: vi.fn() }));

/**
 * The point of this test is the defect Task 7 exists to fix:
 * `/feeds/[id]/loading.tsx` used to be ~14 hand-placed `<Skeleton>` bars, one
 * per field, that had to be kept in visual sync with `<FeedForm>` by hand. It
 * now renders the real `<FeedForm pending />` chassis instead, so a
 * regression back to hand-placed bars fails here.
 */
describe("the /feeds/[id] route's loading fallback", () => {
  it("renders the real form chassis, disabled, instead of hand-placed skeleton bars", () => {
    renderWithProviders(Loading());

    const name = screen.getByLabelText("Name") as HTMLInputElement;
    expect(name.disabled).toBe(true);
    expect(name.value).toBe("");

    // The aggregator picker needs no query (`AGGREGATOR_SPECS` is static), so
    // it is real and disabled from the first frame too.
    const aggregatorTrigger = screen.getByLabelText("Aggregator") as HTMLButtonElement;
    expect(aggregatorTrigger.disabled).toBe(true);

    // The tag multi-select is one of the genuinely data-dependent controls.
    const tagsTrigger = document.querySelector<HTMLButtonElement>("#tags")!;
    expect(tagsTrigger.disabled).toBe(true);

    // Edit mode is unknowable at this point (no feed has been read yet), so
    // the form falls back to its create-mode action label and offers no
    // "Update now" button -- both true of `<FeedForm pending />` with no
    // `feed` prop.
    expect(
      (screen.getByRole("button", { name: "Create feed" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();

    // No skeleton bars anywhere in the form region -- only the deliberate
    // `<h1>` placeholder, since the fetched feed's name is the one genuine
    // unknown here.
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(1);
  });
});
