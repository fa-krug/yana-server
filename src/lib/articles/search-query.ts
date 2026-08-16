/**
 * Turn a user's raw search box input into an FTS5 `MATCH` expression.
 *
 * Every token is wrapped in double quotes (with any embedded quote doubled,
 * FTS5's own escape) so nothing the user types can reach the query parser as
 * syntax: `NOT`, `OR`, `name:`, `*` and `^` are all just text after this. An
 * unquoted term is not merely a possible syntax error -- it is a way to steer
 * the query, which a search box must never be.
 *
 * Tokens are space-separated, which FTS5 reads as implicit AND. Only the last
 * token carries a `*`, so a term still matches while the user is mid-word
 * without every earlier word being treated as a prefix.
 *
 * Control characters are stripped rather than quoted, because quoting does not
 * save them: FTS5's expression parser reads the expression as a C string, so a
 * NUL inside quotes ends it early and raises "unterminated string" -- a 500
 * from `?q=%00`. There is no escape for it, and no search term legitimately
 * contains one.
 *
 * Returns null when there is nothing to search for, which the caller treats as
 * "no search filter" rather than "match nothing".
 */
export function toFtsQuery(term: string): string | null {
  const tokens = term
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[\u0000-\u001F\u007F]/g, ""))
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replaceAll('"', '""')}"`);

  if (tokens.length === 0) return null;

  return tokens.map((token, i) => (i === tokens.length - 1 ? `${token}*` : token)).join(" ");
}
