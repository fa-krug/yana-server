import { describe, expect, it } from "vitest";

import { AGGREGATOR_KEYS } from "@/lib/db/schema";

import { AGGREGATOR_SPECS, schemaFor, stripUnavailable, visibleOptionsFor } from "./registry";

const ALL = { youtube: true, reddit: true, ai: true };
const NONE = { youtube: false, reddit: false, ai: false };

describe("AGGREGATOR_SPECS", () => {
  it("covers every aggregator key", () => {
    for (const key of AGGREGATOR_KEYS) {
      expect(AGGREGATOR_SPECS[key], `no spec for ${key}`).toBeDefined();
    }
  });

  it("requires an identifier for reddit and youtube only", () => {
    expect(AGGREGATOR_SPECS.reddit.identifierRequired).toBe(true);
    expect(AGGREGATOR_SPECS.youtube.identifierRequired).toBe(true);
    expect(AGGREGATOR_SPECS.heise.identifierRequired).toBe(false);
  });

  it("gives every option a unique key within its aggregator", () => {
    for (const key of AGGREGATOR_KEYS) {
      const keys = AGGREGATOR_SPECS[key].options.map((option) => option.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe("visibleOptionsFor", () => {
  it("hides AI options when no provider is configured", () => {
    const visible = visibleOptionsFor("heise", NONE).map((option) => option.key);
    expect(visible).not.toContain("ai_summarize");
  });

  it("shows them once a provider is configured", () => {
    expect(visibleOptionsFor("heise", ALL).map((o) => o.key)).toContain("ai_summarize");
  });
});

describe("stripUnavailable", () => {
  it("removes a guarded option a crafted request tried to set", () => {
    // Hiding a field in the UI does not stop anyone from submitting it.
    const cleaned = stripUnavailable("caschys_blog", { ai_summarize: true, skip_ads: true }, NONE);
    expect(cleaned).not.toHaveProperty("ai_summarize");
    expect(cleaned).toHaveProperty("skip_ads");
  });

  it("drops keys the aggregator does not declare at all", () => {
    expect(stripUnavailable("caschys_blog", { nonsense: 1 }, ALL)).not.toHaveProperty("nonsense");
  });
});

describe("schemaFor", () => {
  it("applies declared defaults for absent values", () => {
    const parsed = schemaFor("podcast").parse({});
    expect(parsed).toHaveProperty("include_download_link");
  });

  it("rejects a boolean option given a string", () => {
    expect(() => schemaFor("caschys_blog").parse({ skip_ads: "yes" })).toThrow();
  });
});
