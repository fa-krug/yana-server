import { describe, expect, it } from "vitest";

import { toFtsQuery } from "./search-query";

describe("toFtsQuery", () => {
  it("quotes each token and ANDs them with a trailing prefix match", () => {
    expect(toFtsQuery("hello world")).toBe('"hello" "world"*');
  });

  it("returns null for a term with no usable tokens", () => {
    expect(toFtsQuery("")).toBeNull();
    expect(toFtsQuery("   ")).toBeNull();
  });

  it("neutralises FTS5 operators rather than letting them reach the parser", () => {
    // Unquoted, every one of these is FTS5 syntax: a bare `NOT`, a column
    // filter, a bareword operator. Quoting turns them all back into text, so
    // a user's search string can never be a query-syntax error -- or a way to
    // steer the query.
    expect(toFtsQuery("NOT foo")).toBe('"NOT" "foo"*');
    expect(toFtsQuery("name:foo")).toBe('"name:foo"*');
    expect(toFtsQuery("foo OR bar")).toBe('"foo" "OR" "bar"*');
  });

  it("strips control characters, which FTS5 cannot parse even inside quotes", () => {
    // A NUL reaches here from `?q=%00`: quoting does not save it, because the
    // FTS5 expression parser stops at the NUL and reports "unterminated
    // string" -- a 500 from a search box. Stripping is the only fix; there is
    // no escape for it.
    const nul = String.fromCharCode(0);
    expect(toFtsQuery(`a${nul}b`)).toBe('"ab"*');
    expect(toFtsQuery(nul)).toBeNull();
  });

  it("escapes an embedded double quote by doubling it", () => {
    expect(toFtsQuery('say "hi"')).toBe('"say" """hi"""*');
  });
});
