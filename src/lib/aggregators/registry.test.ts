import { describe, expect, it } from "vitest";

import { AGGREGATOR_KEYS } from "@/lib/db/schema";

import { BaseAggregator } from "./base";
import { AggregatorRegistry, getAggregator, IMPLEMENTED_AGGREGATORS } from "./registry";
import { AGGREGATOR_SPECS, schemaFor, stripUnavailable, visibleOptionsFor } from "./specs";
import { RssAggregator } from "./rss";
import { FullWebsiteAggregator } from "./website";

const ALL = { youtube: true, reddit: true, ai: true };
const NONE = { youtube: false, reddit: false, ai: false };

describe("AGGREGATOR_SPECS", () => {
  it("covers every aggregator key and key matches record key", () => {
    for (const key of AGGREGATOR_KEYS) {
      expect(AGGREGATOR_SPECS[key], `no spec for ${key}`).toBeDefined();
      expect(AGGREGATOR_SPECS[key].key).toBe(key);
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

describe("IMPLEMENTED_AGGREGATORS & AggregatorRegistry", () => {
  it("maps implemented keys to class implementations", () => {
    expect(IMPLEMENTED_AGGREGATORS.feed_content).toBe(RssAggregator);
    expect(IMPLEMENTED_AGGREGATORS.full_website).toBe(FullWebsiteAggregator);
  });

  it("AggregatorRegistry.get returns class for known type and throws for unknown", () => {
    expect(AggregatorRegistry.get("feed_content")).toBe(RssAggregator);
    expect(AggregatorRegistry.get("full_website")).toBe(FullWebsiteAggregator);
    expect(() => AggregatorRegistry.get("unknown_type")).toThrow("Unknown aggregator type");
  });

  it("AggregatorRegistry.getAll returns all registered aggregators", () => {
    const all = AggregatorRegistry.getAll();
    expect(all.feed_content).toBe(RssAggregator);
    expect(all.full_website).toBe(FullWebsiteAggregator);
  });

  it("getAggregator instantiates an aggregator from feed object", () => {
    const feed = {
      aggregator: "feed_content",
      identifier: "http://example.com/rss",
      dailyLimit: 20,
    };
    const agg = getAggregator(feed);
    expect(agg).toBeInstanceOf(RssAggregator);
    expect(agg.identifier).toBe("http://example.com/rss");
  });

  it("preserves identifierField and getIdentifierFromRelated behaviour", () => {
    expect(BaseAggregator.identifierField).toBe("identifier");
    expect(BaseAggregator.getIdentifierFromRelated({ id: 123 })).toBe("[object Object]");
    expect(BaseAggregator.getIdentifierFromRelated("my-id")).toBe("my-id");
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
