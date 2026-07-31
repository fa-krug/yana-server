import { describe, expect, it } from "vitest";

import { DEFAULT_NEXT_PATH, safeNextPath } from "./next-path";

/**
 * One `describe` per rejection in `safeNextPath()`, because the first version of
 * this file had eighteen tests that all exercised the same two lines: every
 * hostile input was caught by a raw-prefix check, none of them reached the URL
 * parse, and deleting the origin comparison failed nothing. That is how a live
 * open redirect shipped with a green suite -- normalization *creates*
 * protocol-relative paths, and nothing here was looking at the output.
 *
 * So the rule for adding a case: know which check is supposed to catch it,
 * delete that check, and confirm this file goes red. Every group below has been
 * through that.
 */
describe("safeNextPath", () => {
  it("keeps a local path, with its query string", () => {
    // What src/proxy.ts actually writes.
    expect(safeNextPath("/settings")).toBe("/settings");
    expect(safeNextPath("/articles?tag=rust&page=2")).toBe("/articles?tag=rust&page=2");
  });

  describe("rejects what is not a string", () => {
    it.each([
      ["absent", undefined],
      ["repeated, so Next hands over an array", ["/settings", "/feeds"]],
      ["not a string", 42],
    ])("falls back to / when `next` is %s", (_case, value) => {
      // Absent is the *normal* case, not an error one: requireUser()
      // (src/lib/auth/session.ts) has no pathname to send and redirects to a
      // bare /login.
      expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
    });
  });

  describe("rejects what is not a path", () => {
    it("does not turn a bare hostname into a local page", () => {
      // Resolved against the base this becomes "/evil.tld" -- not an open
      // redirect, but a silent rewrite to a page nobody asked for. Asserted as
      // the fallback rather than as "stays on this site", which it already
      // would.
      expect(safeNextPath("evil.tld")).toBe(DEFAULT_NEXT_PATH);
    });

    it.each(["https://evil.tld/", "http://evil.tld/", "javascript:alert(1)"])(
      "refuses the absolute URL %j",
      (value) => {
        expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
      },
    );

    it("refuses an absolute URL even when it names this very site", () => {
      // The proxy never writes one, so accepting it would only widen what has
      // to be reasoned about -- and "same origin" is not a question this
      // function can answer, since it has no request and therefore no origin.
      expect(safeNextPath("http://localhost:3000/settings")).toBe(DEFAULT_NEXT_PATH);
    });
  });

  describe("rejects what the URL parser will not parse", () => {
    it.each(["//", "///"])("survives %j, which throws inside new URL()", (value) => {
      // A host with no host in it. Reachable, so the try/catch is not
      // defensive decoration: without it this function throws, and it is
      // called during the render of the one page a signed-out visitor can
      // reach.
      expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
    });
  });

  describe("rejects anything that resolves to another origin", () => {
    it.each([
      // Protocol-relative: looks like a path, is not one. Note the *path* of
      // this one is the innocent "/x?y=1" -- checking the path alone would
      // have sent the user to the wrong local page and called it safe.
      ["//evil.tld/x?y=1", "protocol-relative"],
      ["//evil.tld", "protocol-relative, no path"],
      // URL normalizes a backslash to a slash for http(s).
      ["/\\evil.tld", "backslash"],
      ["/\\\\evil.tld", "two backslashes"],
      // The parser strips tabs and newlines *before* resolving, so these
      // become "//evil.tld" and change origin. This is what a separate
      // control-character guard used to be for; it was dead, and the parse is
      // what actually catches them.
      ["/\t/evil.tld", "tab"],
      ["/\n/evil.tld", "newline"],
      ["/\r//evil.tld", "carriage return"],
    ])("refuses %j (%s)", (value) => {
      expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
    });

    it("percent-encodes the control characters it does not strip", () => {
      // The other half of why no control-character guard is needed: what the
      // parser keeps, it escapes -- so nothing raw can reach a Location header.
      expect(safeNextPath("/\u0001/x")).toBe("/%01/x");
    });
  });

  describe("rejects a path that normalization turns protocol-relative", () => {
    it.each([
      // The defect this whole group exists for. Every one of these passes any
      // conceivable test of the *input* -- single leading slash, no backslash,
      // no control characters -- and comes out of new URL() as "//evil.tld",
      // which a browser follows off-site. Dot-segment collapsing is what does
      // it.
      "/.//evil.tld",
      "/./\\evil.tld",
      "/a/..//evil.tld",
      "/..//evil.tld",
      "/.//\\evil.tld",
    ])("refuses %j", (value) => {
      const result = safeNextPath(value);

      expect(result).toBe(DEFAULT_NEXT_PATH);
      // Said twice on purpose: the fallback is the fix, but "does not start
      // with //" is the property that matters, and it is what any future guard
      // has to keep true.
      expect(result.startsWith("//")).toBe(false);
    });
  });

  describe("rejects the login page itself", () => {
    it.each(["/login", "/login/", "/login//", "/LOGIN", "/login?next=%2Flogin"])(
      "refuses %j",
      (value) => {
        // Not a loop -- redirect(LOGIN_PATH) carries no query, so the next hop
        // reads no `next` and stops. It is one pointless hop, and a sign-in
        // page that offers to return you to the sign-in page.
        expect(safeNextPath(value)).toBe(DEFAULT_NEXT_PATH);
      },
    );

    it("still allows a route that merely lives under /login", () => {
      // A different page, with no hop back here.
      expect(safeNextPath("/login/help")).toBe("/login/help");
    });
  });

  it("normalizes the path it returns", () => {
    // Traversal collapses here rather than at the router, so what is checked
    // is what will be requested -- which is the whole basis of the two output
    // checks above.
    expect(safeNextPath("/feeds/../settings")).toBe("/settings");
    expect(safeNextPath("/settings/")).toBe("/settings/");
  });
});
