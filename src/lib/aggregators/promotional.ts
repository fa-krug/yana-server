/**
 * Does a feed entry *declare itself* as advertising?
 *
 * German press law requires paid content to be labelled ("Anzeige",
 * "Advertorial", "Sponsored Post", ...), and a WordPress-style CMS carries that
 * label in the entry's own categories -- Mein-MMO's affiliate deal articles are
 * `<category>Anzeige</category><category>Deals</category>` in
 * `https://mein-mmo.de/feed/`, WinFuture's are `<category>Advertorial</category>`.
 * So the label is available before anything is fetched, which is what makes this
 * check cheap enough to sit in `filterArticles()`.
 *
 * **This reads declarations only.** It does not look at monetization markers in
 * the article body (`rel="sponsored"` links, an affiliate-commission
 * disclosure, an affiliate network's host), which are a different and much
 * noisier question -- measured on real pages, an ordinary editorial post can
 * carry ten of them because the CMS dropped a product widget into the body,
 * and the *page* around any article carries them in its chrome. A declared
 * label has no such ambiguity: nobody labels an article "Anzeige" by accident.
 *
 * Three rules make the matching honest, and each of the three has a
 * counter-example behind it that a looser version gets wrong:
 *
 * - **Whole strings, never substrings.** WinFuture publishes a
 *   `<category>werbefrei</category>` -- "ad-free" -- which a `/werbe/` prefix
 *   match reads as advertising, the exact inversion of its meaning. Measured on
 *   419 real feed entries, that was the only false positive of the first draft.
 * - **Topic is not a label.** `Deals`, `Angebote`, `Schnäppchen`,
 *   `Sonderangebote` and `Blitzangebote` all appear as ordinary categories on
 *   articles nobody was paid for; a deal round-up written by a journalist is
 *   editorial content about prices. Only the labels a publisher is legally
 *   obliged to use count, so this list stays a vocabulary of *labels*.
 * - **A title matches only where the label is delimited** -- bracketed
 *   (`(Anzeige)`), or a segment of its own before/after `:` `|` `–` ` - `.
 *   Caschy's Blog labels in the title rather than in a category, so the channel
 *   is needed; but "Anzeige" is also the German word for a criminal complaint,
 *   and every label doubles as ordinary prose. A bare-word search flags
 *   "Anzeige gegen Publisher erstattet: Was jetzt gilt" and "Sponsored Content
 *   bei Instagram: Was Creator wissen müssen" -- two news stories, neither
 *   paid for. Both are in `promotional.test.ts` for that reason.
 *
 * **Deliberately not covered: prose disclosures** -- "In Kooperation mit
 * Samsung:", "Präsentiert von ...", "powered by ...". They are sentences with a
 * brand in them rather than a fixed label, so they cannot be a vocabulary
 * entry, and the brand is what makes each one different. A feed that only ever
 * discloses that way needs its own rule in its own site aggregator, the way
 * `heise.ts` skips "heise-Angebot" by title.
 */

/**
 * The labels themselves, normalized (see `normalizeLabel`). German and English,
 * because a self-hosted reader's feed list is not one language.
 *
 * Additions belong here and nowhere else, and the bar is "a publisher uses this
 * to mark paid content", not "this word suggests commerce" -- see the topic
 * rule above.
 */
const PROMOTIONAL_LABELS = new Set([
  // German
  "anzeige",
  "werbeanzeige",
  "werbeartikel",
  "werbebeitrag",
  "gesponsert",
  "gesponserter beitrag",
  "gesponserter inhalt",
  "partnerinhalt",
  "partnerbeitrag",
  // German/English both
  "advertorial",
  // English
  "advertisement",
  "advertising feature",
  "paid content",
  "paid post",
  "paid partnership",
  "partner content",
  "promoted",
  "promoted content",
  "sponsored",
  "sponsored article",
  "sponsored content",
  "sponsored post",
  "sponsored posts",
  "sponsored story",
  // Hashtag labels, the social-media convention. Spelled out rather than
  // stripped to their bare word, because a bare "ad" or "ads" is far more
  // often a *topic* -- a category holding articles about ad platforms -- than a
  // label, which is the topic rule again.
  "#ad",
  "#anzeige",
  "#sponsored",
  "#werbung",
]);

/**
 * Three words that look like they belong in the list above and are deliberately
 * absent, because each is ambiguous in a way that would cost an article:
 *
 * - **`werbung`** on its own. It *is* used as a label, but it is also a topic --
 *   the ad-industry trade press and the tech sites that cover it file articles
 *   *about* advertising under it. `werbeanzeige`/`werbebeitrag`/`#werbung` carry
 *   the label meaning without the topic meaning.
 * - **`promotion`**. In German that is a doctorate, so a science or careers feed
 *   would lose exactly the articles it exists for. `promoted`/`promoted content`
 *   say the same thing in the only language that uses it as a label.
 * - **`ad`/`ads`**. A two- and three-letter word, and far more often a section
 *   holding articles about ad platforms than a label on one. `#ad` is kept
 *   because the hashtag form is only ever a disclosure.
 *
 * The asymmetry behind all three: a false positive *discards* an article the
 * reader wanted and leaves only a job-log line behind, while a false negative
 * leaves one labelled ad in the list, where the reader can see it and say so.
 * So an ambiguous word stays out.
 */

/**
 * A candidate label reduced to the form `PROMOTIONAL_LABELS` is written in:
 * lower-cased, surrounding brackets and quotes gone, trailing punctuation gone,
 * inner whitespace collapsed to single spaces. `trim()` and `\s` both count a
 * non-breaking space as whitespace, which is what a CMS emits where an editor
 * typed one, so no separate pass for it.
 *
 * The bracket and colon stripping is what lets one vocabulary serve both
 * channels -- `(Anzeige)` from a title and `Anzeige` from a category normalize
 * to the same string.
 */
export function normalizeLabel(value: string): string {
  return value
    .trim()
    .replace(/^[([{"'«»]+/, "")
    .replace(/[)\]}"'«»]+$/, "")
    .replace(/[:!.]+$/, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Whether `value` *is* an advertising label, as a whole string. */
export function isPromotionalLabel(value: string): boolean {
  return PROMOTIONAL_LABELS.has(normalizeLabel(value));
}

/**
 * The segments of `title` that could be a label on their own: anything
 * bracketed, plus a leading or trailing segment delimited by `:`, `|`, an
 * en/em dash, or a spaced hyphen.
 *
 * The delimiter requirement is the whole point -- see the third rule in this
 * module's doc comment. A spaced hyphen is required rather than any hyphen
 * because "heise-Angebot" and "Preis-Leistung" are single words.
 */
function labelCandidates(title: string): string[] {
  const candidates: string[] = [];

  for (const match of title.matchAll(/[([{]([^)\]}]{1,40})[)\]}]/g)) {
    candidates.push(match[1]);
  }

  const delimiter = /\s*(?::|\||–|—|\s-\s)\s*/;
  const parts = title.split(delimiter).filter((part) => part.trim().length > 0);
  if (parts.length > 1) {
    candidates.push(parts[0], parts[parts.length - 1]);
  }

  return candidates;
}

/**
 * The advertising label this entry declares, or `null`.
 *
 * Returns the label as the source spelled it (not normalized), because the only
 * caller writes it into a job log where an operator reads it back against the
 * feed -- "declared as Advertorial" is checkable, "declared as promotional" is
 * not.
 *
 * Categories are checked before the title: a category is the publisher's own
 * structured field, where a title is prose that happens to carry a marker.
 */
export function promotionalLabelOf(entry: {
  name?: string;
  categories?: string[] | null;
}): string | null {
  for (const category of entry.categories ?? []) {
    if (isPromotionalLabel(category)) {
      return category.trim();
    }
  }

  for (const candidate of labelCandidates(entry.name ?? "")) {
    if (isPromotionalLabel(candidate)) {
      return candidate.trim();
    }
  }

  return null;
}
