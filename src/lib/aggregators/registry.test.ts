import { describe, expect, it } from "vitest";

import { AGGREGATOR_KEYS } from "@/lib/db/schema";
import type { Feed } from "@/lib/db/schema";

import { createAggregator } from "./factory";
import { IMPLEMENTED_AGGREGATORS } from "./registry";
import {
  AGGREGATOR_SPECS,
  defaultIdentifierFor,
  identifierModeFor,
  MAX_CUSTOM_PROMPT_LENGTH,
  schemaFor,
  stripUnavailable,
  visibleOptionsFor,
} from "./specs";
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

describe("IMPLEMENTED_AGGREGATORS & createAggregator", () => {
  it("maps implemented keys to class implementations", () => {
    expect(IMPLEMENTED_AGGREGATORS.feed_content).toBe(RssAggregator);
    expect(IMPLEMENTED_AGGREGATORS.full_website).toBe(FullWebsiteAggregator);
  });

  it("createAggregator instantiates an aggregator from feed object", () => {
    const feed = {
      aggregator: "feed_content",
      identifier: "http://example.com/rss",
      dailyLimit: 20,
    } as unknown as Feed;
    const agg = createAggregator(feed);
    expect(agg).toBeInstanceOf(RssAggregator);
    expect(agg.identifier).toBe("http://example.com/rss");
  });

  // `createAggregator()` is the sole surviving entry point (see the module
  // comment at the top of ./registry): an unknown `aggregator` value falls
  // back to `FullWebsiteAggregator` rather than throwing. That is a real
  // semantics choice, not an accident of the deletion -- the registry's own
  // `AggregatorRegistry.get()` used to throw on the same input, and every
  // production caller (aggregate.ts, reload.ts, logo.ts) already depends on
  // the fallback, not the throw.
  it("falls back to FullWebsiteAggregator for an unrecognised aggregator key", () => {
    const feed = {
      aggregator: "not_a_real_aggregator",
      identifier: "https://example.com/",
      dailyLimit: 20,
    } as unknown as Feed;
    const agg = createAggregator(feed);
    expect(agg).toBeInstanceOf(FullWebsiteAggregator);
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

  it("defaults the custom prompt to an unchecked box and empty text", () => {
    const parsed = schemaFor("heise").parse({}) as Record<string, unknown>;
    expect(parsed.ai_custom_prompt).toBe(false);
    expect(parsed.ai_custom_prompt_text).toBe("");
  });

  it("accepts a custom prompt within the length cap", () => {
    const parsed = schemaFor("heise").parse({
      ai_custom_prompt: true,
      ai_custom_prompt_text: "x".repeat(MAX_CUSTOM_PROMPT_LENGTH),
    }) as Record<string, unknown>;
    expect(parsed.ai_custom_prompt_text).toHaveLength(MAX_CUSTOM_PROMPT_LENGTH);
  });

  it("rejects a custom prompt past the length cap", () => {
    // The row stores this in `feeds.options` JSON and every article's provider
    // call carries it, so an unbounded blob is refused rather than truncated.
    expect(() =>
      schemaFor("heise").parse({ ai_custom_prompt_text: "x".repeat(MAX_CUSTOM_PROMPT_LENGTH + 1) }),
    ).toThrow();
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

describe("AGGREGATOR_SPECS identifier and option data", () => {
  // Until the 2026-09-03 pipeline-review-4 cleanup (Task 2), `specs.ts` and
  // each site class's `getConfigurationFields()`/`getIdentifierChoices()`
  // were hand-kept duplicates of each other, and this describe block's job
  // was to byte-compare the two copies -- which enforced the duplication
  // rather than catching drift in what actually matters. Those class-level
  // methods are gone now (`BaseAggregator.saveOptions()`, their sole reader,
  // had no caller anywhere), so `specs.ts` is the single source of truth for
  // both identifier choices and option defaults. These assertions pin the
  // real values directly instead of comparing one copy against another.

  // mein_mmo's include_videos is the one option whose default is off: a spec
  // that drifted to `true` would put the CMS's auto-inserted videos back into
  // every newly created feed while extractContent() still reads them as off.
  it("defaults mein_mmo's include_videos option to off", () => {
    const option = AGGREGATOR_SPECS.mein_mmo.options.find((o) => o.key === "include_videos");
    expect(option?.default).toBe(false);
  });

  // A test used to sit here asserting "every choice-mode aggregator has at
  // least two identifier choices" -- but `identifierModeFor()` *returns*
  // "choice" precisely when `identifierChoices.length >= 2` (see its own doc
  // comment above), so filtering on that mode and then asserting the same
  // threshold is true by construction: it cannot fail unless
  // `identifierModeFor()` itself changes, which the "derives the four modes
  // from the data on each spec" test in the `identifierModeFor` describe
  // block above already covers -- it hardcodes the expected mode per
  // aggregator key against real `AGGREGATOR_SPECS` data, so a spec whose
  // `identifierChoices` shrank enough to flip its mode fails that test
  // instead.

  it("gives every identifier choice a non-empty value and label", () => {
    for (const key of AGGREGATOR_KEYS) {
      for (const choice of AGGREGATOR_SPECS[key].identifierChoices) {
        expect(choice.value, key).not.toBe("");
        expect(choice.label, key).not.toBe("");
      }
    }
  });
});
