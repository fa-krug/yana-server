/**
 * The feed item's own identity (`<guid>` / Atom `<id>`), and the one rule that
 * decides whether an aggregation run may be believed when it states one.
 *
 * WHY THIS EXISTS. An article's identity used to be its `link` alone, keyed as
 * `(feedId, identifier)` by `handleAggregateJob()`. That is wrong whenever a
 * publisher serves one document under more than one path: Tagesschau listed an
 * article as `/ausland/italien-meloni-124.html` and, two hours later, as
 * `/ausland/europa/italien-meloni-124.html` -- both answering 200, neither
 * redirecting, *both* declaring the same `<link rel="canonical">` -- and the
 * handler stored it twice, two rows the reader then saw as two identical
 * articles. A guid does not move when the path does; Tagesschau's is a document
 * UUID, unrelated to the URL.
 *
 * Reading the page's canonical URL instead was the other candidate and was
 * rejected: it only works for the aggregators that fetch the article page at
 * all, leaving plain RSS and podcast feeds -- the ones with no page to read --
 * exposed to the very same thing. The guid comes off the feed the aggregator
 * has already parsed, so it costs nothing and covers every RSS-derived
 * aggregator, which is 14 of the 16 registered ones.
 *
 * WHY IT IS NOT TRUSTED UNCONDITIONALLY, which is the whole point of this
 * module. The failure modes of the two identities are not symmetrical. Keying
 * on a link that moved **duplicates** an article: annoying, visible, and
 * repairable. Keying on a guid that is *reused across different articles* --
 * a feed emitting its channel URL as every item's guid, a template bug
 * stamping a constant -- **merges distinct articles into one row**, which
 * overwrites one article's content with another's and is not repairable from
 * anything left behind. So a guid earns its use per run, and the check is the
 * narrowest one that catches that shape: within a single run a guid may name
 * at most one link. Distinct articles always carry distinct links, so a guid
 * covering two of them in one snapshot is a guid that is not identifying
 * anything.
 *
 * Note what that check deliberately does *not* refuse. The duplicate this
 * exists to fix is the same guid under two links in *different* runs, which no
 * single run can see and which this must therefore let through. And a feed that
 * lists one item twice verbatim -- Tagesschau ships 10 such pairs in 79 items,
 * identical guid *and* identical link -- is one link per guid and stays
 * trusted.
 *
 * A run that fails the check falls back to link-only matching, i.e. exactly the
 * behaviour that predates this module, for that run only.
 */

/** An entry's guid as stored: trimmed, with "absent" collapsed to `""`. */
export function normalizeExternalId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Whether this run's guids may be used as article identity.
 *
 * Entries with no guid are ignored rather than counted against the feed: a
 * partially-populated feed still lets the entries that *do* carry one be
 * matched by it, and the rest fall back to their link on their own.
 */
export function externalIdsAreTrustworthy(
  articles: Iterable<{ identifier?: string; externalId?: string }>,
): boolean {
  const linksByExternalId = new Map<string, string>();

  for (const article of articles) {
    const externalId = normalizeExternalId(article.externalId);
    const link = typeof article.identifier === "string" ? article.identifier.trim() : "";
    if (!externalId || !link) continue;

    const seen = linksByExternalId.get(externalId);
    if (seen === undefined) {
      linksByExternalId.set(externalId, link);
    } else if (seen !== link) {
      return false;
    }
  }

  return true;
}
