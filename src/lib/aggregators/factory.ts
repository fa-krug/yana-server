import { BaseAggregator } from "./base";
import { RssAggregator } from "./rss";
import { FullWebsiteAggregator } from "./website";
import type { Feed } from "@/lib/db/schema";

export function createAggregator(feed: Feed): BaseAggregator {
  switch (feed.aggregator) {
    case "feed_content":
    case "rss":
      return new RssAggregator(feed);
    case "full_website":
    default:
      return new FullWebsiteAggregator(feed);
  }
}
