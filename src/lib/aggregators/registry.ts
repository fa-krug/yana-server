/**
 * SERVER-ONLY: every class below reaches `@/lib/db/client` (and therefore
 * `better-sqlite3`) through the image store. The option *descriptions* a form
 * needs live in `./specs`, which imports none of this — see the comment there.
 */
import type { AggregatorKey } from "@/lib/db/schema/enums";
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
import { TagesschauAggregator } from "./sites/tagesschau/aggregator";
import { TheVergeAggregator } from "./sites/the_verge";
import { FullWebsiteAggregator } from "./website";

export type AggregatorClass = (new (feed: any) => BaseAggregator) & {
  identifierField?: string;
  getIdentifierFromRelated?: (relatedObj: unknown) => string;
  getDefaultIdentifier?: () => string;
  selectorsToRemove?: string[];
  contentSelectors?: string[];
};

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
};

export class AggregatorRegistry {
  static get(aggregatorType: string): AggregatorClass {
    const cls = IMPLEMENTED_AGGREGATORS[aggregatorType as AggregatorKey];
    if (!cls) {
      throw new Error(`Unknown aggregator type: ${aggregatorType}`);
    }
    return cls;
  }

  static getAll(): Partial<Record<AggregatorKey, AggregatorClass>> {
    return { ...IMPLEMENTED_AGGREGATORS };
  }
}

export function getAggregator(feed: FeedLike): BaseAggregator {
  const aggregatorType = feed.aggregator || "full_website";
  const AggregatorClass = AggregatorRegistry.get(aggregatorType);
  return new AggregatorClass(feed);
}
