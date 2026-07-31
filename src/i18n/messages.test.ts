// src/i18n/messages.test.ts
import en from "../../messages/en.json";
import de from "../../messages/de.json";
import { describe, expect, it } from "vitest";

function keys(object: unknown, prefix = ""): string[] {
  if (typeof object !== "object" || object === null) return [prefix];
  return Object.entries(object).flatMap(([key, value]) =>
    keys(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe("message catalogs", () => {
  it("define exactly the same keys", () => {
    // A missing key renders the raw key path to the user, which no visual review
    // reliably catches -- so it is asserted instead.
    expect(keys(de).sort()).toEqual(keys(en).sort());
  });

  it("leave no value empty", () => {
    for (const [name, catalog] of [
      ["en", en],
      ["de", de],
    ] as const) {
      for (const path of keys(catalog)) {
        const value = path
          .split(".")
          .reduce<unknown>((node, part) => (node as never)[part], catalog);
        expect(value, `${name}:${path}`).not.toBe("");
      }
    }
  });
});
