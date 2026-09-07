import { describe, expect, it } from "vitest";

import { isPromotionalLabel, normalizeLabel, promotionalLabelOf } from "./promotional";

/**
 * Category lists captured verbatim from live feeds on 2026-08-31, because the
 * whole point of this module is agreeing with what publishers actually emit.
 * The Mein-MMO pair is the same article in both of that site's feeds
 * (`/feed/` and `/artikel/anzeige/feed/`); the WinFuture ones are that site's
 * `Advertorial` label beside the topical categories it ships next to it.
 */
const LIVE = {
  meinMmoDeal: ["Anzeige", "Deals"],
  meinMmoEditorial: ["Community", "Gaming", "MMORPG", "News"],
  winfutureAdvertorial: ["Schnäppchen", "Rabattaktion", "Media Markt", "Angebote", "Advertorial"],
  winfutureDealRoundup: ["Schnäppchen", "Deals", "Angebote", "Angebot"],
  winfutureAdFree: ["Apple", "werbefrei", "Streaming"],
};

describe("normalizeLabel", () => {
  it("reduces both channels' spellings to one form", () => {
    expect(normalizeLabel("Anzeige")).toBe("anzeige");
    expect(normalizeLabel("(Anzeige)")).toBe("anzeige");
    expect(normalizeLabel("[ANZEIGE]")).toBe("anzeige");
    expect(normalizeLabel("Anzeige:")).toBe("anzeige");
    expect(normalizeLabel("  Sponsored   Post  ")).toBe("sponsored post");
    // A non-breaking space is what a CMS emits where an editor typed one.
    expect(normalizeLabel("Sponsored Post")).toBe("sponsored post");
  });
});

describe("isPromotionalLabel", () => {
  it("accepts the labels publishers mark paid content with", () => {
    for (const label of [
      "Anzeige",
      "Advertorial",
      "Sponsored Post",
      "sponsored content",
      "Gesponserter Beitrag",
      "Paid Content",
      "Partnerinhalt",
      "Werbebeitrag",
      "#ad",
    ]) {
      expect(isPromotionalLabel(label), label).toBe(true);
    }
  });

  /**
   * The three rules from this module's doc comment, each as the case that
   * would break if the rule were relaxed.
   */
  it("refuses a topic that merely concerns commerce", () => {
    for (const label of [
      "Deals",
      "Angebote",
      "Angebot",
      "Schnäppchen",
      "Sonderangebote",
      "Blitzangebote",
      "Top Deals",
      "Rabattaktion",
      "Tech",
    ]) {
      expect(isPromotionalLabel(label), label).toBe(false);
    }
  });

  it("refuses a substring match, including the one that inverts the meaning", () => {
    // WinFuture's real category. A /werbe/ prefix match reads "ad-free" as an
    // ad -- the only false positive this check had against 419 live entries.
    expect(isPromotionalLabel("werbefrei")).toBe(false);
    expect(isPromotionalLabel("Werbeblocker")).toBe(false);
    expect(isPromotionalLabel("Online-Werbung")).toBe(false);
    expect(isPromotionalLabel("Anzeigenmarkt")).toBe(false);
  });

  it("refuses the words that are a label in one language and something else in another", () => {
    // A doctorate in German, so a science or careers feed would lose exactly
    // the articles it exists for.
    expect(isPromotionalLabel("Promotion")).toBe(false);
    // Far more often a section about ad platforms than a label on one.
    expect(isPromotionalLabel("Ads")).toBe(false);
    expect(isPromotionalLabel("Ad")).toBe(false);
    // ... while the hashtag form is only ever a disclosure.
    expect(isPromotionalLabel("#Werbung")).toBe(true);
  });
});

describe("promotionalLabelOf", () => {
  it("finds the label in a live deal article's categories, and none in an editorial one", () => {
    expect(promotionalLabelOf({ categories: LIVE.meinMmoDeal })).toBe("Anzeige");
    expect(promotionalLabelOf({ categories: LIVE.winfutureAdvertorial })).toBe("Advertorial");
    expect(promotionalLabelOf({ categories: LIVE.meinMmoEditorial })).toBeNull();
    expect(promotionalLabelOf({ categories: LIVE.winfutureDealRoundup })).toBeNull();
    expect(promotionalLabelOf({ categories: LIVE.winfutureAdFree })).toBeNull();
  });

  it("reports the label as the source spelled it, for the job log", () => {
    expect(promotionalLabelOf({ categories: ["ADVERTORIAL "] })).toBe("ADVERTORIAL");
  });

  it("reads a title label where it is delimited", () => {
    // Caschy's Blog labels here rather than in a category.
    expect(promotionalLabelOf({ name: "Neues Netzteil im Test (Anzeige)" })).toBe("Anzeige");
    expect(promotionalLabelOf({ name: "[Anzeige] Neues Netzteil im Test" })).toBe("Anzeige");
    expect(promotionalLabelOf({ name: "Anzeige: Neues Netzteil im Test" })).toBe("Anzeige");
    expect(promotionalLabelOf({ name: "Neues Netzteil im Test | Advertorial" })).toBe(
      "Advertorial",
    );
    expect(promotionalLabelOf({ name: "Neues Netzteil im Test - Sponsored Post" })).toBe(
      "Sponsored Post",
    );
  });

  /**
   * The reason the title channel needs the delimiter: every label is also an
   * ordinary word, so a bare-word search flags news stories *about*
   * advertising. Both of these are plausible headlines and neither is paid for.
   */
  it("ignores a label that is just part of the headline's prose", () => {
    expect(
      promotionalLabelOf({ name: "Anzeige gegen Publisher erstattet: Was jetzt gilt" }),
    ).toBeNull();
    expect(
      promotionalLabelOf({ name: "Sponsored Content bei Instagram: Was Creator wissen müssen" }),
    ).toBeNull();
    expect(promotionalLabelOf({ name: "YouTube testet mehr Werbung in Shorts" })).toBeNull();
    // A hyphen inside a word is not a delimiter -- "heise-Angebot" is one word,
    // and that feed's own aggregator is what skips it.
    expect(promotionalLabelOf({ name: "heise-Angebot: iX-Workshop zu Defender XDR" })).toBeNull();
  });

  it("prefers a category over a title, and treats a missing field as no label", () => {
    expect(promotionalLabelOf({ name: "(Advertorial) Etwas", categories: ["Anzeige"] })).toBe(
      "Anzeige",
    );
    expect(promotionalLabelOf({})).toBeNull();
    expect(promotionalLabelOf({ name: "", categories: [] })).toBeNull();
    expect(promotionalLabelOf({ name: "Etwas", categories: null })).toBeNull();
  });
});
