/**
 * A per-site aggregator is a *declaration*, never a copy of the same six
 * lines of scaffolding -- the shape `defineIntegration()` in
 * `@/lib/integrations/define` already established for credential providers,
 * applied to the thing every `sites/*.ts` module repeated verbatim.
 *
 * What each of the eleven site classes used to write out by hand:
 *
 * ```ts
 * static contentSelectors  = [...];  protected contentSelectors  = [...X.contentSelectors];
 * static selectorsToRemove = [...];  protected selectorsToRemove = [...X.selectorsToRemove];
 * usesFirstContentMatch = true;
 * constructor(feed) { super(feed); if (!this.identifier) this.identifier = "…/feed"; }
 * override getSourceUrl() { return "https://x"; }
 * ```
 *
 * Three of those were the same value written twice. The `static`/`protected`
 * pairs had **no reader for the static half** -- nothing outside the class
 * that declared it ever read `X.contentSelectors`/`X.selectorsToRemove`
 * (`registry.ts`'s `AggregatorClass` declared them optionally and never
 * dereferenced them), so the static was a second copy that could silently
 * drift from the instance field actually used by `getContentSelectors()` /
 * `getIgnoreSelectors()`. And the constructor's identifier literal was a
 * hand-kept duplicate of the feed URL `specs.ts` already declares as that
 * aggregator's first `identifierChoices` entry.
 *
 * So there is no `defaultFeed` option here: the default identifier is read
 * from `specs.ts` through `key`, which is the one join between an aggregator
 * class and its spec. `specs.ts` stays the single source of truth for that
 * URL -- adding a second one here is exactly the drift this function exists
 * to remove. (`defaultIdentifierFor()` answers `""` for an aggregator with no
 * fixed choices, which is the same "no default" the base class already
 * means.)
 *
 * It deliberately offers **no option nothing uses**: every field below is
 * exercised by at least one site, and `firstMatchOnly` is required rather
 * than defaulted, for the reason `quotaMeansVerified` is required on an AI
 * provider's keys -- a new site has to state the answer instead of inheriting
 * whichever one a neighbour happened to have.
 *
 * It collapses *declaration* only. A site that overrides `extractContent`,
 * `processContent`, `enrichArticles`, `fetchArticleContent` or
 * `sourceTitleFrom` keeps doing so, in its own class body, extending the
 * class this returns.
 */
import type { AggregatorKey } from "@/lib/db/schema/enums";

import { AGGREGATOR_SPECS, defaultIdentifierFor } from "./specs";
import { FullWebsiteAggregator } from "./website";

export interface SiteDefinition {
  /**
   * This site's `AggregatorKey` -- the join to `specs.ts`, which is where the
   * default feed URL comes from. Must be the same key `registry.ts` maps to
   * the class being defined.
   */
  key: AggregatorKey;
  /**
   * The site's homepage, returned by `getSourceUrl()` -- read by the
   * `feed.logo` job handler as the page to look for a logo on. Written
   * verbatim, trailing slash and all: `logo.ts` resolves it as a base URL, so
   * the two spellings behave identically, and normalising them here would be
   * a behaviour change dressed up as a cleanup.
   */
  siteUrl: string;
  /**
   * The article-body selectors. Omitted means "keep the base class's
   * `DEFAULT_CONTENT_SELECTORS`" -- which is what `tagesschau` does, since its
   * body comes out of its own `extractContent()` override instead.
   */
  content?: string[];
  /**
   * Selectors stripped from the extracted body. Replaces the base list
   * outright rather than extending it (which is what the `protected` field it
   * feeds always did); a site that wants the base class's own
   * `IFRAME_SANITIZE_SELECTOR` names it, as most of them already do.
   */
  remove?: string[];
  /** `usesFirstContentMatch`: take only the first matching container. */
  firstMatchOnly: boolean;
}

/**
 * The two base classes a site can build on (`FullWebsiteAggregator` and
 * `RssSummaryFallbackAggregator`) present the same type surface -- the latter
 * only narrows `extractContent()`'s return -- so one non-generic signature
 * types both. Non-generic on purpose: a generic `<T extends typeof
 * FullWebsiteAggregator>` cannot be extended inside this function without
 * widening the constraint to `new (...args: any[]) => …`, and `any` is a lint
 * error here. The class returned is a real subclass of whichever base was
 * passed, so `RssSummaryFallbackAggregator`'s override still runs.
 */
type WebsiteAggregatorClass = typeof FullWebsiteAggregator;

export function defineSite(
  Base: WebsiteAggregatorClass,
  site: SiteDefinition,
): WebsiteAggregatorClass {
  const defaultIdentifier = defaultIdentifierFor(AGGREGATOR_SPECS[site.key]);

  return class Site extends Base {
    constructor(feed: ConstructorParameters<WebsiteAggregatorClass>[0]) {
      super(feed);
      // Assigned in the constructor body rather than as class fields, because
      // a field initializer runs unconditionally and would overwrite the base
      // class's defaults with `undefined` for a site that declares no
      // `content`/`remove` list.
      if (site.content) {
        this.contentSelectors = [...site.content];
      }
      if (site.remove) {
        this.selectorsToRemove = [...site.remove];
      }
      this.usesFirstContentMatch = site.firstMatchOnly;
      if (!this.identifier) {
        this.identifier = defaultIdentifier;
      }
    }

    override getSourceUrl(): string {
      return site.siteUrl;
    }
  };
}
