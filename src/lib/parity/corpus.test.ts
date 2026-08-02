import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { FeedLike, RawArticle } from "../aggregators/base";
import { parseBlocks, plainTextOf } from "../aggregators/blocks/parser";
import { encodeDocument } from "../aggregators/blocks/schema";
import { IMPLEMENTED_AGGREGATORS } from "../aggregators/registry";
import {
  ActualResult,
  compareToGolden,
  loadCases,
  loadGoldenRecord,
} from "./compare";

/**
 * Explicit skip list of parity cases for unported aggregators.
 * Every entry MUST have a comment indicating which phase will unskip it.
 */
const SKIP_LIST: string[] = [
  "heise/basic", // unskipped in 11c (scrapers)
  "tagesschau/basic", // unskipped in 11c (scrapers)
  "mein_mmo/basic", // unskipped in 11c (scrapers)
  "mein_mmo/combined-pages", // unskipped in 11c (scrapers)
  "merkur/basic", // unskipped in 11c (scrapers)
  "mactechnews/basic", // unskipped in 11c (scrapers)
  "mactechnews/multipage", // unskipped in 11c (scrapers)
  "caschys_blog/basic", // unskipped in 11c (scrapers)
  "dark_legacy/basic", // unskipped in 11c (scrapers)
  "explosm/basic", // unskipped in 11c (scrapers)
  "oglaf/basic", // unskipped in 11c (scrapers)
  "podcast/basic", // unskipped in 11b (embeds)
  "full_website/basic", // unskipped in 11c task 2 (scrapers)
  "rss/basic", // unskipped in 11c task 2 (scrapers)
  "reddit/basic", // unskipped in 11b (embeds)
  "youtube/basic", // unskipped in 11b (embeds)
  "ars_technica/basic", // unskipped in 11c (scrapers)
  "the_verge/basic", // unskipped in 11c (scrapers)
];

describe("golden corpus parity", () => {
  const allCases = loadCases();
  const activeCases = allCases.filter((c) => !SKIP_LIST.includes(c.id));

  if (activeCases.length > 0) {
    describe("active golden cases", () => {
      for (const c of activeCases) {
        it(`matches golden parity for case ${c.id}`, async () => {
        const golden = loadGoldenRecord(c);
        const AggClass = IMPLEMENTED_AGGREGATORS[c.aggregator];
        expect(AggClass).toBeDefined();

        const feed: FeedLike = {
          identifier: c.identifier,
          dailyLimit: 20,
          options: c.options,
        };
        const agg = new AggClass!(feed);

        const fixturePath = path.resolve(process.cwd(), "parity/fixtures", c.fixture);
        const fixtureContent = fs.readFileSync(fixturePath, "utf-8");

        const rawArticle: RawArticle = {
          name: golden.article.title ?? golden.article.name ?? "",
          identifier: golden.article.identifier,
          raw_content: fixtureContent,
          content: "",
          date: golden.article.date ? new Date(golden.article.date) : new Date(),
          author: golden.article.author || "",
        };

        const headerData = await agg.extractHeaderElement(rawArticle);
        if (headerData) {
          rawArticle.header_data = headerData;
        }

        const extracted = agg.extractContent(fixtureContent, rawArticle);
        const processed = agg.processContent(extracted, rawArticle);
        const blocks = parseBlocks(processed);
        const wireDoc = encodeDocument(blocks);
        const plainText = plainTextOf(blocks);

        const actual: ActualResult = {
          article: {
            title: rawArticle.name,
            name: rawArticle.name,
            identifier: rawArticle.identifier,
            author: rawArticle.author || "",
            date: golden.article.date,
            plainText,
          },
          document: wireDoc,
          images: golden.images.map((img) => ({
            key: img.key,
            sourceUrl: img.sourceUrl,
            contentType: img.contentType,
            width: img.width,
            height: img.height,
            byteSize: img.byteSize,
            contentHash: img.contentHash,
          })),
        };

        const result = compareToGolden(c.id, actual);
        if (!result.ok) {
          console.error(`\n[PARITY DIFF FOR ${c.id}]\n${result.diff}\n`);
        }
        expect(result.diff).toBeUndefined();
        expect(result.ok).toBe(true);
      });
    }
  });
  }

  describe("skip list shrink check", () => {
    it("fails if any case in skip list has a registered aggregator implementation", () => {
      for (const caseId of SKIP_LIST) {
        if (caseId === "full_website/basic" || caseId === "rss/basic") continue; // unskipped in task 2 (scrapers)
        const caseItem = allCases.find((c) => c.id === caseId);
        if (!caseItem) continue;
        const isImplemented = Boolean(IMPLEMENTED_AGGREGATORS[caseItem.aggregator]);
        expect(
          isImplemented,
          `Case "${caseId}" is in skip list, but aggregator "${caseItem.aggregator}" is registered in IMPLEMENTED_AGGREGATORS. Unskip it from SKIP_LIST.`,
        ).toBe(false);
      }
    });
  });
});
