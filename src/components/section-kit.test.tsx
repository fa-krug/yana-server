import { screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { StatusBadge, useReportOutcome } from "@/components/integrations/section-parts";
import type { SaveResult } from "@/lib/integrations/result";
import { renderWithProviders } from "@/test/render";

import type { Outcome } from "./section-kit";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn(), warning: vi.fn() },
}));

/**
 * The two things the factories in `./section-kit` assemble at a binding site,
 * and that nothing else has a test for.
 *
 * `youtube-section.test.tsx` and `reddit-section.test.tsx` already cover the
 * three arms of the reporter -- success, an explicit `errorKey`, and the
 * warning a `noticeKey` earns -- so re-asserting those here would be noise.
 * What they never exercise is what this refactor turned from a literal into an
 * argument:
 *
 * - **which failure message a result with no `errorKey` gets**, which used to be
 *   a `Record` written beside the only namespace that had one and is now six
 *   keys passed in by name. Transpose `saveFailed` and `testFailed` at the
 *   binding site and every card silently tells an operator who pressed **Test**
 *   that a save failed -- the exact defect the per-action fallback was added to
 *   fix.
 * - **which label the badge shows**, for the same reason: `active` and
 *   `inactive` are now arguments, and swapping them compiles.
 *
 * Asserted against `de.json`, because "Active" is too close to the raw key
 * `active` to prove a translation happened at all.
 */
describe("the integrations binding of the section kit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A card, reduced to the one line of it this is about. */
  function Reporter({ outcome }: { outcome: Outcome }) {
    const report = useReportOutcome();
    // A failure that named no key of its own -- reachable from every action
    // (a malformed body, a missing settings row, a write that touched no row).
    const result: SaveResult = { ok: false };
    return (
      <button type="button" onClick={() => report(result, outcome)}>
        go
      </button>
    );
  }

  it.each([
    ["saved", "Diese Zugangsdaten konnten nicht gespeichert werden."],
    ["tested", "Diese Zugangsdaten konnten nicht getestet werden."],
    ["removed", "Die Zugangsdaten konnten nicht entfernt werden."],
  ] as const)("falls back to the %s action's own failure message", (outcome, message) => {
    renderWithProviders(<Reporter outcome={outcome} />, { locale: "de" });
    screen.getByRole("button").click();
    expect(toastError).toHaveBeenCalledExactlyOnceWith(message);
  });

  it.each([
    [true, "Aktiv"],
    [false, "Inaktiv"],
  ])("labels the badge for enabled=%s", (enabled, label) => {
    renderWithProviders(<StatusBadge enabled={enabled} />, { locale: "de" });
    expect(screen.getByText(label)).toBeTruthy();
  });
});
