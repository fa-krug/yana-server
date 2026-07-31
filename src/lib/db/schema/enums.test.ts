import { describe, expect, it } from "vitest";

import { BLOCK_KINDS, EMBED_PROVIDERS, JOB_STATUSES, STYLE_NAMES } from "./enums";

describe("enums", () => {
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
