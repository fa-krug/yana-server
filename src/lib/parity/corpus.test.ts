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
  "podcast/basic", // unskipped in 11b (embeds)
  "full_website/basic", // unskipped in 11c task 2 (scrapers)
  "rss/basic", // unskipped in 11c task 2 (scrapers)
  "reddit/basic", // unskipped in 11b (embeds)
  "youtube/basic", // unskipped in 11b (embeds)
  // mein_mmo/* are skipped for a data bug, not a porting gap: the recovered
  // html/mein_mmo.html (test(parity): Recover the archived fixture corpus,
  // 6d80661) is an old pre-Django snapshot of an unrelated "OLED gaming
  // monitor deal" article (div.gp-entry-content), while desired/mein_mmo.json
  // (test(parity): Regenerate the fixture corpus against the fixed pipeline,
  // 7f1e2f7) describes a live-recollected "Gears of War: E-Day" article --
  // different title, different URL. No selector or aggregator change can
  // close that gap; the fixture pair needs a matched html capture of the
  // article desired/mein_mmo.json actually describes before this can unskip.
  "mein_mmo/basic",
  "mein_mmo/combined-pages",
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
        const processed = await agg.processContent(extracted, rawArticle);
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
        if (caseId === "mein_mmo/basic" || caseId === "mein_mmo/combined-pages") continue; // implemented; skipped for the fixture data bug explained above
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
