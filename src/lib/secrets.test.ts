import { describe, expect, it } from "vitest";

import { KEEP_EXISTING, mask, resolveSecret } from "./secrets";

describe("mask", () => {
  it("returns empty for an unset secret", () => {
    expect(mask("")).toBe("");
  });

  it("reveals only the last four characters", () => {
    expect(mask("AIzaSyMASSIVEKEY1234")).toBe("••••••••1234");
  });

  it("does not leak a short secret in full", () => {
    // A 3-char secret must not become recoverable from its own mask.
    expect(mask("abc")).not.toContain("abc");
  });
});

describe("resolveSecret", () => {
  it("keeps the existing value for the sentinel", () => {
    expect(resolveSecret(KEEP_EXISTING, "real-key")).toBe("real-key");
  });

  it("keeps the existing value for an empty submission", () => {
    expect(resolveSecret("", "real-key")).toBe("real-key");
  });

  it("takes a genuinely new value", () => {
    expect(resolveSecret("new-key", "real-key")).toBe("new-key");
  });
});
