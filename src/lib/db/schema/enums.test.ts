import { describe, expect, it } from "vitest";

import { AGGREGATOR_KEYS, BLOCK_KINDS, EMBED_PROVIDERS, JOB_STATUSES, STYLE_NAMES } from "./enums";

describe("enums", () => {
  it("keeps the 16 aggregator keys Django declared, and no invented `rss`", () => {
    // Pins the exact wrong value the phase plan itself proposed: Django's
    // AGGREGATOR_CHOICES has `feed_content`, never `rss`. A wrong key is a
    // runtime failure that only surfaces when someone creates that feed type,
    // and `old/core/choices.py` will eventually be gone.
    expect(AGGREGATOR_KEYS).toHaveLength(16);
    expect(AGGREGATOR_KEYS).not.toContain("rss");
    expect(AGGREGATOR_KEYS).toContain("feed_content");
  });

  it("keeps list_item as a storage-only block kind", () => {
    // list_item encodes a list's [[Block]] shape as rows. It never appears on
    // the wire -- see core/blocks/types.py.
    expect(BLOCK_KINDS).toContain("list_item");
  });

  it("orders styles as the wire's styles array does", () => {
    expect(STYLE_NAMES).toEqual(["bold", "italic", "code", "strikethrough"]);
  });

  it("ends embed providers with the generic fallback", () => {
    expect(EMBED_PROVIDERS.at(-1)).toBe("generic");
  });

  it("defines the job lifecycle", () => {
    expect(JOB_STATUSES).toEqual(["pending", "running", "succeeded", "failed"]);
  });
});
