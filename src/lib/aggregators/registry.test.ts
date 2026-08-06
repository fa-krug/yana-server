import { describe, expect, it } from "vitest";

import { AGGREGATOR_KEYS } from "@/lib/db/schema";

import { BaseAggregator } from "./base";
import { AggregatorRegistry, getAggregator, IMPLEMENTED_AGGREGATORS } from "./registry";
import {
  AGGREGATOR_SPECS,
  defaultIdentifierFor,
  identifierModeFor,
  schemaFor,
  stripUnavailable,
  visibleOptionsFor,
} from "./specs";
import { RssAggregator } from "./rss";
import { FullWebsiteAggregator } from "./website";
import { ArsTechnicaAggregator } from "./sites/ars_technica";
import { CaschysBlogAggregator } from "./sites/caschys_blog";
import { DarkLegacyAggregator } from "./sites/dark_legacy";
import { ExplosmAggregator } from "./sites/explosm";
import { HeiseAggregator } from "./sites/heise";
import { MactechnewsAggregator } from "./sites/mactechnews/aggregator";
import { MeinMmoAggregator } from "./sites/mein_mmo/aggregator";
import { MerkurAggregator } from "./sites/merkur";
import { OglafAggregator } from "./sites/oglaf";
import { TagesschauAggregator } from "./sites/tagesschau/aggregator";
import { TheVergeAggregator } from "./sites/the_verge";

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

  it("gives every aggregator a recommended interval and concurrency", () => {
    for (const spec of Object.values(AGGREGATOR_SPECS)) {
      expect(spec.recommendedIntervalMinutes).toBeGreaterThan(0);
      expect(spec.recommendedConcurrency).toBeGreaterThanOrEqual(1);
    }
  });

  it("recommends a gentler interval and lower concurrency for rate-sensitive sources", () => {
    for (const key of ["caschys_blog", "youtube", "reddit"] as const) {
      expect(AGGREGATOR_SPECS[key].recommendedIntervalMinutes).toBe(60);
      expect(AGGREGATOR_SPECS[key].recommendedConcurrency).toBe(2);
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

describe("identifierModeFor", () => {
  it("derives the four modes from the data on each spec", () => {
    const expected: Record<string, string> = {
      full_website: "url",
      feed_content: "url",
      podcast: "url",
      heise: "choice",
      merkur: "choice",
      tagesschau: "choice",
      ars_technica: "choice",
      mactechnews: "choice",
      explosm: "none",
      dark_legacy: "none",
      caschys_blog: "none",
      oglaf: "none",
      mein_mmo: "none",
      the_verge: "none",
      youtube: "search",
      reddit: "search",
    };

    for (const key of AGGREGATOR_KEYS) {
      expect(identifierModeFor(AGGREGATOR_SPECS[key]), key).toBe(expected[key]);
    }
  });

  it("gives none/choice modes a non-empty default identifier", () => {
    for (const key of AGGREGATOR_KEYS) {
      const spec = AGGREGATOR_SPECS[key];
      const mode = identifierModeFor(spec);
      if (mode === "none" || mode === "choice") {
        expect(defaultIdentifierFor(spec), key).not.toBe("");
      } else {
        expect(defaultIdentifierFor(spec), key).toBe("");
      }
    }
  });
});

describe("identifierChoices parity with the ported aggregator classes", () => {
  const classesWithChoices: [string, typeof BaseAggregator][] = [
    ["heise", HeiseAggregator],
    ["merkur", MerkurAggregator],
    ["tagesschau", TagesschauAggregator],
    ["ars_technica", ArsTechnicaAggregator],
    ["mactechnews", MactechnewsAggregator],
    ["explosm", ExplosmAggregator],
    ["dark_legacy", DarkLegacyAggregator],
    ["caschys_blog", CaschysBlogAggregator],
    ["oglaf", OglafAggregator],
    ["mein_mmo", MeinMmoAggregator],
    ["the_verge", TheVergeAggregator],
  ];

  it("matches each site class's getIdentifierChoices() byte-for-byte", () => {
    for (const [key, cls] of classesWithChoices) {
      const fromClass = cls.getIdentifierChoices().map(([value, label]) => ({ value, label }));
      expect(AGGREGATOR_SPECS[key as keyof typeof AGGREGATOR_SPECS].identifierChoices, key).toEqual(
        fromClass,
      );
    }
  });
});
