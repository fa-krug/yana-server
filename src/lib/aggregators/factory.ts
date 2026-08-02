import { BaseAggregator } from "./base";
import { IMPLEMENTED_AGGREGATORS } from "./registry";
import { FullWebsiteAggregator } from "./website";
import type { Feed } from "@/lib/db/schema";
import type { AggregatorKey } from "@/lib/db/schema/enums";

export function createAggregator(feed: Feed): BaseAggregator {
  const cls = IMPLEMENTED_AGGREGATORS[feed.aggregator as AggregatorKey];
  if (cls) {
    return new cls(feed);
  }
  return new FullWebsiteAggregator(feed);
}
