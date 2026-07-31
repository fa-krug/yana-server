import { describe, expect, it } from "vitest";

import { DEFAULT_NEXT_PATH, safeNextPath } from "./next-path";

describe("safeNextPath", () => {
  it("keeps a local path, with its query string", () => {
    // What src/proxy.ts actually writes.
    expect(safeNextPath("/settings")).toBe("/settings");
    expect(safeNextPath("/articles?tag=rust&page=2")).toBe("/articles?tag=rust&page=2");
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["repeated, so Next hands over an array", ["/settings", "/feeds"]],
    ["not a string", 42],
  ])("falls back to / when `next` is %s", (_case, value) => {
    // Absent is the *normal* case, not an error one: requireUser()
    // (src/lib/auth/session.ts) has no pathname to send and redirects to a
    // bare /login.
    expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
  });

  it.each([
    // An open redirect: the link shows this site's own host, the sign-in is
    // real, and the landing page belongs to the attacker.
    "https://evil.tld/",
    "http://evil.tld/",
    // Protocol-relative -- looks like a path, is not one.
    "//evil.tld/",
    "///evil.tld",
    // The URL parser normalizes a backslash to a slash for http(s), so this is
    // another spelling of the line above.
    "/\\evil.tld",
    "/\\\\evil.tld",
    // Browsers strip tabs and newlines out of a URL before resolving it, which
    // turns this into "//evil.tld" after the strip.
    "/\t/evil.tld",
    "/\n/evil.tld",
    // Not a path at all.
    "javascript:alert(1)",
    "evil.tld",
  ])("refuses to leave the site for %j", (value) => {
    expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
  });

  it("refuses an absolute URL even when it names this very site", () => {
    // The proxy never writes one, so accepting it would only widen what has to
    // be reasoned about -- and "same origin" is not a question this function
    // can answer, since it has no request and therefore no origin.
    expect(safeNextPath("http://localhost:3000/settings")).toBe(DEFAULT_NEXT_PATH);
  });

  it.each(["/login", "/login/", "/login?next=%2Flogin"])(
    "refuses %s, which would redirect the login page to itself forever",
    (value) => {
      expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
    },
  );

  it("normalizes the path it returns", () => {
    // Traversal collapses here rather than at the router, so what is checked
    // is what will be requested.
    expect(safeNextPath("/feeds/../settings")).toBe("/settings");
    expect(safeNextPath("/settings/")).toBe("/settings/");
  });
});
