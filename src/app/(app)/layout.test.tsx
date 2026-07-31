import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import { setPathname } from "@/test/next-navigation";

import AppLayout from "./layout";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

describe("the (app) layout", () => {
  it("renders exactly one <main> landmark", () => {
    setPathname("/");
    const { container } = renderWithProviders(
      <AppLayout>
        <p>content</p>
      </AppLayout>,
    );

    expect(container.querySelectorAll("main")).toHaveLength(1);
  });
});
