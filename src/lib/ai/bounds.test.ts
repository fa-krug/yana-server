import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AI_ADVANCED_BOUNDS, AI_ADVANCED_FIELDS } from "./bounds";

const ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * `bounds.ts` says it "imports nothing, for `./providers`' reason". That was a
 * comment; this is the tripwire, the same one `src/lib/ai/providers.test.ts`,
 * `src/lib/secrets.test.ts` and `src/lib/auth/roles.test.ts` carry -- and
 * CLAUDE.md's standard for this rule is explicitly "pinned … not just asserted
 * in a comment".
 *
 * The rule is not tidiness, and this module has the strongest claim of the four
 * to being pinned rather than trusted. It is read from **both sides of the
 * wire**: `src/components/ai/advanced-section.tsx` is a `"use client"` component
 * that renders `min`/`max`/`step` out of it, and `src/lib/ai/actions.ts` builds
 * the zod schema that actually refuses a save out of the same object. So one
 * import of a `queries` module here would drag `better-sqlite3` into the browser
 * bundle as an opaque error naming nothing -- and the reason the module exists
 * at all is that these bounds were previously written twice, with nothing
 * keeping the browser's hint and the server's validation equal.
 */
describe("the bounds module's dependency contract", () => {
  it("imports nothing at all", () => {
    const source = fs
      .readFileSync(path.join(ROOT, "src/lib/ai/bounds.ts"), "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const specifiers = [
      ...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);

    expect(specifiers).toEqual([]);
  });
});

describe("AI_ADVANCED_BOUNDS", () => {
  /**
   * `satisfies Record<AiAdvancedField, AiBound>` already makes a missing entry a
   * typecheck failure. This is the other direction and the one the compiler does
   * not see: a bound whose field was dropped from the render order is a value the
   * schema still enforces and the form never shows.
   */
  it("covers exactly the five fields the form renders, and nothing else", () => {
    expect(Object.keys(AI_ADVANCED_BOUNDS).sort()).toEqual([...AI_ADVANCED_FIELDS].sort());
  });

  it("gives every field a usable range", () => {
    for (const field of AI_ADVANCED_FIELDS) {
      const bound = AI_ADVANCED_BOUNDS[field];
      expect(bound.max).toBeGreaterThan(bound.min);
    }
  });

  /**
   * Only `temperature` is fractional, and that is a fact both halves read: the
   * schema adds `.int()` for the other five because the columns are `integer`
   * and SQLite would store `2.5` in one without complaining, and the input gets
   * `step={1}` from the same flag.
   */
  it("marks every column that is an integer, and only those", () => {
    const fractional = AI_ADVANCED_FIELDS.filter((field) => !AI_ADVANCED_BOUNDS[field].integer);
    expect(fractional).toEqual(["temperature"]);
  });
});
