import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useTagUsage } from "./use-tag-usage";

const { tagUsage } = vi.hoisted(() => ({ tagUsage: vi.fn().mockResolvedValue({ feeds: 0 }) }));
vi.mock("@/lib/tags/actions", () => ({ tagUsage }));

let renderCount = 0;

// Mirrors how <TagForm> calls this hook for a brand-new tag: `tag ? [tag.id] : []`
// builds a fresh array literal on every render, so nothing upstream memoizes it.
function Harness() {
  renderCount++;
  const usage = useTagUsage([]);
  return <div>{usage ? usage.feeds : "null"}</div>;
}

describe("useTagUsage", () => {
  it("does not re-render forever when the caller passes a fresh array literal every render", async () => {
    renderCount = 0;
    render(<Harness />);

    // Let any runaway effect/transition loop run for a bit before asserting.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // A settled hook renders a small, bounded number of times (mount + the
    // one update once usage resolves). A reference-identity bug in the
    // effect's dependency array reruns forever instead, pushing this into
    // the thousands within the same window.
    expect(renderCount).toBeLessThan(10);
  });
});
