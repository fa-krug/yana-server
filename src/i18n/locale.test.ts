import { describe, expect, it } from "vitest";

import de from "../../messages/de.json";
import en from "../../messages/en.json";

import { FALLBACK_LOCALE, LOCALES, negotiateLocale } from "./locale";

describe("negotiateLocale", () => {
  it.each([
    ["de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7", "de", "Chrome on a German system"],
    ["en-GB,en;q=0.9,de;q=0.8", "en", "Chrome on a British one"],
    ["de", "de", "the shortest header there is"],
    ["de-AT", "de", "a regional tag with no plain `de` beside it"],
    ["DE-ch", "de", "case does not matter"],
  ])("reads %j as %s (%s)", (header, expected) => {
    expect(negotiateLocale(header)).toBe(expected);
  });

  it("honours quality values over header order", () => {
    // The one thing a naive "first tag wins" implementation gets wrong, and
    // the reason this is not a one-liner.
    expect(negotiateLocale("de;q=0.7,en;q=0.9")).toBe("en");
    expect(negotiateLocale("en;q=0.2,de;q=0.8")).toBe("de");
  });

  it("keeps header order when the qualities tie", () => {
    expect(negotiateLocale("de,en")).toBe("de");
    expect(negotiateLocale("en,de")).toBe("en");
  });

  it("skips a language it has no catalog for", () => {
    // Falling through to a language that *is* supported, rather than giving up
    // at the first unknown tag.
    expect(negotiateLocale("fr-FR,fr;q=0.9,de;q=0.5")).toBe("de");
    expect(negotiateLocale("fr,es,it")).toBe(FALLBACK_LOCALE);
  });

  it("treats q=0 as a refusal, not as a weak preference", () => {
    // `de;q=0` means "not German". Ranking it last instead of dropping it
    // would still select it when nothing else matches.
    expect(negotiateLocale("de;q=0")).toBe(FALLBACK_LOCALE);
    expect(negotiateLocale("de;q=0,en;q=0.1")).toBe("en");
  });

  it("ignores the wildcard", () => {
    // `*` means "anything", which is what the fallback already is.
    expect(negotiateLocale("*")).toBe(FALLBACK_LOCALE);
    expect(negotiateLocale("*;q=1,de;q=0.5")).toBe("de");
  });

  it.each([
    ["no header at all", null],
    ["an undefined header", undefined],
    ["an empty header", ""],
    ["punctuation", ",,;;"],
    ["a malformed quality value", "de;q=abc,en"],
    ["a quality value out of range", "de;q=9,en"],
  ])("falls back to en for %s", (_case, header) => {
    // Nothing here may throw: this runs in the root layout, where an exception
    // is a 500 on every route in the application.
    expect(negotiateLocale(header)).toBe(FALLBACK_LOCALE);
  });
});

describe("LOCALES", () => {
  it("names exactly the catalogs that exist", () => {
    // The negotiator can only ever return a member of this list, so a locale
    // added here without a catalog would resolve to a missing import at
    // runtime -- in the root layout, on every route.
    expect([...LOCALES].toSorted()).toEqual(["de", "en"]);
    expect(Object.keys(en).length).toBeGreaterThan(0);
    expect(Object.keys(de).length).toBeGreaterThan(0);
  });
});
