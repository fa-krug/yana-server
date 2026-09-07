/**
 * SERVER-ONLY: every class below reaches `@/lib/db/client` (and therefore
 * `better-sqlite3`) through the image store. The option *descriptions* a form
 * needs live in `./specs`, which imports none of this — see the comment there.
 *
 * `IMPLEMENTED_AGGREGATORS` is the one map from an `AggregatorKey` to its
 * class. `./factory`'s `createAggregator()` is the only thing that reads it
 * to instantiate an aggregator -- there used to be a second entry point here
 * too (`AggregatorRegistry.get`/`getAll` + `getAggregator()`), but nothing
 * called it outside this module's own tests, and it disagreed with
 * `createAggregator()` on an unknown key (`.get` threw; `createAggregator`
 * falls back to `FullWebsiteAggregator`, which is the behaviour every real
 * caller depends on). Removed rather than reconciled, per the 2026-09-03
 * pipeline-review-4 cleanup plan's Task 2.
 */
import type { FeedLike } from "./base";
import { BaseAggregator } from "./base";
import { RssAggregator } from "./rss";
import { ArsTechnicaAggregator } from "./sites/ars_technica";
import { CaschysBlogAggregator } from "./sites/caschys_blog";
import { DarkLegacyAggregator } from "./sites/dark_legacy";
import { ExplosmAggregator } from "./sites/explosm";
import { HeiseAggregator } from "./sites/heise";
import { MactechnewsAggregator } from "./sites/mactechnews/aggregator";
import { MeinMmoAggregator } from "./sites/mein_mmo/aggregator";
import { MerkurAggregator } from "./sites/merkur";
import { OglafAggregator } from "./sites/oglaf";
import { PodcastAggregator } from "./sites/podcast";
import { RedditAggregator } from "./sites/reddit/aggregator";
import { TagesschauAggregator } from "./sites/tagesschau/aggregator";
import { TheVergeAggregator } from "./sites/the_verge";
import { YouTubeAggregator } from "./sites/youtube/aggregator";
import { FullWebsiteAggregator } from "./website";

export type AggregatorClass = new (feed: FeedLike) => BaseAggregator;

export const IMPLEMENTED_AGGREGATORS: Record<string, AggregatorClass | undefined> = {
  feed_content: RssAggregator as unknown as AggregatorClass,
  rss: RssAggregator as unknown as AggregatorClass,
  full_website: FullWebsiteAggregator as unknown as AggregatorClass,
  oglaf: OglafAggregator as unknown as AggregatorClass,
  dark_legacy: DarkLegacyAggregator as unknown as AggregatorClass,
  explosm: ExplosmAggregator as unknown as AggregatorClass,
  caschys_blog: CaschysBlogAggregator as unknown as AggregatorClass,
  merkur: MerkurAggregator as unknown as AggregatorClass,
  the_verge: TheVergeAggregator as unknown as AggregatorClass,
  ars_technica: ArsTechnicaAggregator as unknown as AggregatorClass,
  mactechnews: MactechnewsAggregator as unknown as AggregatorClass,
  tagesschau: TagesschauAggregator as unknown as AggregatorClass,
  heise: HeiseAggregator as unknown as AggregatorClass,
  mein_mmo: MeinMmoAggregator as unknown as AggregatorClass,
  podcast: PodcastAggregator as unknown as AggregatorClass,
  youtube: YouTubeAggregator as unknown as AggregatorClass,
  reddit: RedditAggregator as unknown as AggregatorClass,
};
