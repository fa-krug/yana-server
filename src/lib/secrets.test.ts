import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { KEEP_EXISTING, mask, resolveSecret } from "./secrets";

const ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * `secrets.ts` says it imports nothing "and must stay that way". That was a
 * comment; it is now a tripwire, the same one `src/lib/auth/roles.test.ts`
 * carries for `roles.ts` -- and CLAUDE.md's standard for this rule is explicitly
 * "pinned … not just asserted in a comment".
 *
 * The rule is not tidiness. `KEEP_EXISTING` and `mask()` are read from
 * `"use client"` components (`src/components/section-kit.tsx`, which every
 * credential card is built from -- two today, five once phase 7 adds the AI
 * providers), so anything reachable from here is in the browser
 * bundle. One import of `./db/client` or of a feature's `queries` module would
 * drag `better-sqlite3` in behind it, and the failure is an opaque bundler error
 * rather than anything that names this file.
 */
describe("the secrets module's dependency contract", () => {
  it("imports nothing at all", () => {
    const source = fs
      .readFileSync(path.join(ROOT, "src/lib/secrets.ts"), "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const specifiers = [
      ...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);

    expect(specifiers).toEqual([]);
  });
});

describe("mask", () => {
  it("returns empty for an unset secret", () => {
    expect(mask("")).toBe("");
  });

  it("reveals only the last four characters", () => {
    expect(mask("AIzaSyMASSIVEKEY1234")).toBe("••••••••1234");
  });

  it("does not leak a short secret in full", () => {
    // A 3-char secret must not become recoverable from its own mask.
    expect(mask("abc")).not.toContain("abc");
  });

  /**
   * The boundary itself, from both sides.
   *
   * `length <= 8` reveals nothing; mutated to `length < 8` the suite stayed
   * green while an 8-character secret gave up half of itself. Reddit client ids
   * are short enough for that to be a real value, not a hypothetical one.
   */
  it("reveals nothing at all for a secret of exactly eight characters", () => {
    expect(mask("12345678")).toBe("••••••••");
  });

  it("starts revealing the tail at nine", () => {
    expect(mask("123456789")).toBe("••••••••6789");
  });
});

describe("resolveSecret", () => {
  it("keeps the existing value for the sentinel", () => {
    expect(resolveSecret(KEEP_EXISTING, "real-key")).toBe("real-key");
  });

  it("keeps the existing value for an empty submission", () => {
    expect(resolveSecret("", "real-key")).toBe("real-key");
  });

  it("takes a genuinely new value", () => {
    expect(resolveSecret("new-key", "real-key")).toBe("new-key");
  });

  /**
   * **The sentinel survives being trimmed, and that is why the actions may trim.**
   *
   * Every submitted secret goes through `z.string().trim()` before
   * `resolveSecret()` sees it, because a key pasted out of a console carries a
   * trailing newline and an untrimmed one is destroyed by the write-on-rejection
   * rule. That is only safe because NUL is not JS whitespace -- so it is asserted
   * here rather than argued in a comment. A sentinel changed to something
   * whitespace-delimited (" keep", as one draft of the plan had it) would make
   * every untouched field wipe the stored credential instead of keeping it.
   */
  it("survives the trim every action applies before resolving", () => {
    expect(KEEP_EXISTING.trim()).toBe(KEEP_EXISTING);
    expect(resolveSecret(KEEP_EXISTING.trim(), "real-key")).toBe("real-key");
  });
});
