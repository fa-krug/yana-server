import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DEFAULT_TAG_COLOR, hexForTagColor } from "@/lib/tags/colors";

import { TagBadge } from "./tag-badge";
import { TagColorDot } from "./tag-color-dot";

/**
 * jsdom's CSSOM normalizes any inline color it accepts (including `hsl(...)`)
 * to `rgb(...)` on read. Comparing two elements' `.style.backgroundColor`
 * (both normalized the same way) is what lets this compare *colors* rather
 * than assume a particular string form.
 */
function backgroundColorOf(hsl: string): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = hsl;
  return probe.style.backgroundColor;
}

describe("<TagBadge>", () => {
  it("paints the given color as its background", () => {
    render(<TagBadge name="News" color="blue" />);
    expect(screen.getByText("News").style.backgroundColor).toBe(backgroundColorOf(
      hexForTagColor("blue"),
    ));
  });

  it("falls back to the default palette color for an unrecognized value", () => {
    render(<TagBadge name="News" color="mauve" />);
    expect(screen.getByText("News").style.backgroundColor).toBe(
      backgroundColorOf(hexForTagColor(DEFAULT_TAG_COLOR)),
    );
  });
});

describe("<TagColorDot>", () => {
  it("is hidden from assistive tech -- the adjacent name already carries the meaning", () => {
    const { container } = render(<TagColorDot color="teal" />);
    expect(container.querySelector('span[aria-hidden="true"]')).toBeTruthy();
  });

  it("paints the given color", () => {
    const { container } = render(<TagColorDot color="teal" />);
    const dot = container.querySelector("span");
    expect(dot?.style.backgroundColor).toBe(backgroundColorOf(hexForTagColor("teal")));
  });
});
