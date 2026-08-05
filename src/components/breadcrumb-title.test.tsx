import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { setPathname } from "@/test/next-navigation";

import {
  BreadcrumbTitleProvider,
  SetBreadcrumbTitle,
  useBreadcrumbTitles,
} from "./breadcrumb-title";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

function Reader() {
  const titles = useBreadcrumbTitles();
  return <div data-testid="titles">{JSON.stringify(titles)}</div>;
}

function readTitles(testId: HTMLElement) {
  return JSON.parse(testId.textContent ?? "{}");
}

describe("BreadcrumbTitleProvider / SetBreadcrumbTitle / useBreadcrumbTitles", () => {
  it("registers a title for the current pathname", () => {
    setPathname("/articles/42");
    const { getByTestId } = render(
      <BreadcrumbTitleProvider>
        <SetBreadcrumbTitle title="My Article" />
        <Reader />
      </BreadcrumbTitleProvider>,
    );

    expect(readTitles(getByTestId("titles"))).toEqual({ "/articles/42": "My Article" });
  });

  it("clears the title when the registering component unmounts", () => {
    setPathname("/articles/42");
    function Wrapper({ show }: { show: boolean }) {
      return (
        <BreadcrumbTitleProvider>
          {show && <SetBreadcrumbTitle title="My Article" />}
          <Reader />
        </BreadcrumbTitleProvider>
      );
    }
    const { getByTestId, rerender } = render(<Wrapper show={true} />);
    expect(readTitles(getByTestId("titles"))).toEqual({ "/articles/42": "My Article" });

    rerender(<Wrapper show={false} />);
    expect(readTitles(getByTestId("titles"))).toEqual({});
  });

  it("last write wins when two components register the same href", () => {
    setPathname("/articles/42");
    const { getByTestId } = render(
      <BreadcrumbTitleProvider>
        <SetBreadcrumbTitle title="First" />
        <SetBreadcrumbTitle title="Second" />
        <Reader />
      </BreadcrumbTitleProvider>,
    );

    expect(readTitles(getByTestId("titles"))).toEqual({ "/articles/42": "Second" });
  });

  it("returns no titles when nothing is registered and no provider is mounted", () => {
    const { getByTestId } = render(<Reader />);
    expect(readTitles(getByTestId("titles"))).toEqual({});
  });
});
