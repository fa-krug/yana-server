import { describe, expect, it } from "vitest";

import { externalIdsAreTrustworthy, normalizeExternalId } from "./external-id";

describe("normalizeExternalId", () => {
  it("collapses every shape of absent to the empty string", () => {
    expect(normalizeExternalId(undefined)).toBe("");
    expect(normalizeExternalId(null)).toBe("");
    expect(normalizeExternalId("   ")).toBe("");
    expect(normalizeExternalId(42)).toBe("");
  });

  it("trims, because a guid is compared and never displayed", () => {
    expect(normalizeExternalId("  9b55f055  ")).toBe("9b55f055");
  });
});

describe("externalIdsAreTrustworthy", () => {
  it("trusts a feed whose guids each name one link", () => {
    expect(
      externalIdsAreTrustworthy([
        { identifier: "https://x.de/a-100.html", externalId: "guid-a" },
        { identifier: "https://x.de/b-100.html", externalId: "guid-b" },
      ]),
    ).toBe(true);
  });

  it("trusts a feed that lists the same entry twice verbatim", () => {
    // Tagesschau ships 10 such pairs in 79 items: identical guid AND identical
    // link. One link per guid, so nothing here says the guid is meaningless.
    expect(
      externalIdsAreTrustworthy([
        { identifier: "https://x.de/a-100.html", externalId: "guid-a" },
        { identifier: "https://x.de/a-100.html", externalId: "guid-a" },
      ]),
    ).toBe(true);
  });

  it("distrusts a feed that gives one guid to two different links", () => {
    // The shape that would merge distinct articles into one row -- a constant
    // or templated guid. Unlike a duplicate, that loses an article's content
    // with nothing left behind to repair it from.
    expect(
      externalIdsAreTrustworthy([
        { identifier: "https://x.de/a-100.html", externalId: "shared" },
        { identifier: "https://x.de/b-100.html", externalId: "shared" },
      ]),
    ).toBe(false);
  });

  it("ignores entries carrying no guid rather than counting them against the feed", () => {
    // A partly-populated feed still gets guid identity for the entries that
    // have one; the rest fall back to their link on their own.
    expect(
      externalIdsAreTrustworthy([
        { identifier: "https://x.de/a-100.html", externalId: "guid-a" },
        { identifier: "https://x.de/b-100.html" },
        { identifier: "https://x.de/c-100.html", externalId: "" },
      ]),
    ).toBe(true);
  });

  it("does not refuse the very case it exists to allow: one guid, two links, two runs", () => {
    // The Tagesschau duplicate is the same guid under `/ausland/x-124.html` in
    // one run and `/ausland/europa/x-124.html` in the next. No single run can
    // see that, and this check must not invent a way to.
    const first = [{ identifier: "https://x.de/ausland/x-124.html", externalId: "uuid" }];
    const second = [{ identifier: "https://x.de/ausland/europa/x-124.html", externalId: "uuid" }];
    expect(externalIdsAreTrustworthy(first)).toBe(true);
    expect(externalIdsAreTrustworthy(second)).toBe(true);
  });
});
