/** Every locale this application has a catalog for. */
export const LOCALES = ["en", "de"] as const;

export type AppLocale = (typeof LOCALES)[number];

/** The locale used when nothing else can be determined. */
export const FALLBACK_LOCALE: AppLocale = "en";

function isAppLocale(value: string): value is AppLocale {
  return (LOCALES as readonly string[]).includes(value);
}

/**
 * The best of `LOCALES` for an `Accept-Language` header, or `en`.
 *
 * **Only for requests that have no user.** A signed-in visitor's locale comes
 * from their stored preference and nothing here overrides it -- see
 * `./request.ts`. This exists because /login is the one page rendered without a
 * session, so the stored preference does not exist yet, and always answering
 * `en` meant a German visitor's *first* impression of the application was in
 * the wrong language with no control anywhere on screen to change it.
 *
 * Hand-rolled rather than `Intl.LocaleMatcher` (not in Node 25) or a
 * `negotiator`/`@formatjs/intl-localematcher` dependency: with a two-entry
 * supported list the whole algorithm is "sort by q, take the first primary
 * subtag we recognise", and that is worth less than a dependency to maintain.
 *
 * What it handles, because real headers contain all of it:
 *
 * - **quality values** -- `de;q=0.7, en;q=0.9` prefers English, whatever the
 *   order. An unparseable or out-of-range `q` is treated as 0, so a malformed
 *   entry loses to a well-formed one instead of winning by accident.
 * - **regional tags** -- `de-AT` is German. Matched on the primary subtag,
 *   because there is exactly one German catalog.
 * - **`q=0`**, which explicitly means "not this one", so it is dropped rather
 *   than merely ranked last.
 * - **`*`**, the wildcard: it means "anything", which is what the fallback
 *   already is, so it is ignored rather than treated as a match.
 */
export function negotiateLocale(header: string | null | undefined): AppLocale {
  if (!header) return FALLBACK_LOCALE;

  const ranked = header
    .split(",")
    .map((part) => {
      const [tag, ...parameters] = part.trim().split(";");
      // The *presence* of a `q=` parameter is matched separately from its
      // value: a pattern that only matched digits would read `q=abc` as "no
      // quality given" and score the entry 1, letting a malformed entry beat a
      // well-formed one. Number("abc") is NaN and Number("") is 0, and both
      // land on the same answer below.
      const quality = parameters
        .map((parameter) => /^\s*q\s*=\s*(.*?)\s*$/i.exec(parameter))
        .find((match) => match !== null)?.[1];
      const q = quality === undefined ? 1 : Number(quality);
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0 };
    })
    .filter((entry) => entry.q > 0)
    // Descending, and `toSorted` keeps equal-q entries in header order --
    // which is what "de,en" means: both q=1, German first.
    .toSorted((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const primary = tag.split("-")[0];
    if (primary && isAppLocale(primary)) return primary;
  }
  return FALLBACK_LOCALE;
}
