import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";
import { BaseAggregator, type RawArticle } from "@/lib/aggregators/base";
import { parseBlocks, plainTextOf } from "@/lib/aggregators/blocks/parser";
import { writeBlocks } from "@/lib/aggregators/blocks/storage";
import {
  AggregatorRegistry,
  getAggregator,
  IMPLEMENTED_AGGREGATORS,
  type AggregatorClass,
} from "@/lib/aggregators/registry";
import { getDb, writeTransaction } from "@/lib/db/client";
import { articles, feeds, users, type Feed } from "@/lib/db/schema";
import type { AggregatorKey } from "@/lib/db/schema/enums";

/** The constructor `aggregator.constructor` resolves to, plus its runtime `.name`. */
type AggregatorCtor = AggregatorClass & { name: string };

/** Some aggregator subclasses (e.g. `FullWebsiteAggregator`) expose selector
 * introspection instance methods that `BaseAggregator` itself does not declare. */
type SelectorAggregator = BaseAggregator & {
  getContentSelectors?: () => string[];
  getIgnoreSelectors?: () => string[];
};

const DEFAULT_IDENTIFIERS: Record<string, string> = {
  tagesschau: "https://www.tagesschau.de/xml/rss2/",
  heise: "https://www.heise.de/rss/heise.rdf",
  mein_mmo: "https://www.mein-mmo.de/feed/",
  oglaf: "https://www.oglaf.com/feeds/rss/",
  caschys_blog: "https://stadt-bremerhaven.de/feed/",
  mactechnews: "https://www.mactechnews.de/Rss/News.x",
};

function printSection(title: string): void {
  console.log("");
  console.log("=".repeat(70));
  const centered = title.padStart(Math.floor((70 + title.length) / 2)).padEnd(70);
  console.log(centered);
  console.log("=".repeat(70) + "\n");
}

function printField(label: string, value: unknown): void {
  const labelWithDots = label.padEnd(40, ".");
  console.log(`  ${labelWithDots} ${value}`);
}

function getDefaultIdentifier(target: string): string | undefined {
  try {
    const cls = AggregatorRegistry.get(target);
    if (cls && typeof cls.getDefaultIdentifier === "function") {
      const defaultId = cls.getDefaultIdentifier();
      if (defaultId) return defaultId;
    }
  } catch {
    // Ignore if not in registry
  }
  return DEFAULT_IDENTIFIERS[target];
}

function validateArticles(articlesList: RawArticle[]): void {
  const issues: string[] = [];
  const missingFields = { name: 0, identifier: 0, content: 0, raw_content: 0 };
  let emptyContent = 0;
  let noDate = 0;

  for (const article of articlesList) {
    if (!article.name) missingFields.name++;
    if (!article.identifier) missingFields.identifier++;
    if (!article.raw_content) missingFields.raw_content++;
    if (!article.content || article.content.length === 0) emptyContent++;
    if (!article.date) noDate++;
  }

  if (missingFields.name > 0) {
    issues.push(`  ⚠ ${missingFields.name} articles missing 'name'`);
  }
  if (missingFields.identifier > 0) {
    issues.push(`  ⚠ ${missingFields.identifier} articles missing 'identifier'`);
  }
  if (missingFields.raw_content > 0) {
    issues.push(`  ⚠ ${missingFields.raw_content} articles missing 'raw_content'`);
  }
  if (emptyContent > 0) {
    issues.push(`  ⚠ ${emptyContent} articles have empty 'content'`);
  }
  if (noDate > 0) {
    issues.push(`  ⚠ ${noDate} articles missing 'date'`);
  }

  if (issues.length > 0) {
    for (const issue of issues) {
      console.log(issue);
    }
  } else {
    console.log("  ✓ All articles have required fields");
  }
}

async function saveArticles(feed: Feed, articlesData: RawArticle[]): Promise<void> {
  const db = getDb();
  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const articleData of articlesData) {
    try {
      if (!articleData.identifier) continue;
      const htmlContent = articleData.raw_content || articleData.content || "";
      const blocks = parseBlocks(htmlContent, articleData.identifier);
      const plainText = plainTextOf(blocks);

      let articleId = 0;

      writeTransaction((tx) => {
        const existing = tx
          .select({ id: articles.id })
          .from(articles)
          .where(and(eq(articles.feedId, feed.id), eq(articles.identifier, articleData.identifier)))
          .get();

        const pubDate = articleData.date instanceof Date ? articleData.date : new Date();

        if (existing) {
          articleId = existing.id;
          tx.update(articles)
            .set({
              name: articleData.name || "Untitled",
              rawContent: htmlContent,
              plainText,
              date: pubDate,
              author: articleData.author || "",
              icon: articleData.icon || null,
            })
            .where(eq(articles.id, articleId))
            .run();
          updated++;
        } else {
          const inserted = tx
            .insert(articles)
            .values({
              feedId: feed.id,
              name: articleData.name || "Untitled",
              identifier: articleData.identifier,
              rawContent: htmlContent,
              plainText,
              date: pubDate,
              author: articleData.author || "",
              icon: articleData.icon || null,
            })
            .returning({ id: articles.id })
            .get();
          articleId = inserted.id;
          created++;
        }
      });

      if (articleId > 0 && blocks.length > 0) {
        await writeBlocks(articleId, blocks);
      }
    } catch (e) {
      console.log(`  ✗ Failed to save: ${e}`);
      failed++;
    }
  }

  printField("Created", created);
  printField("Updated", updated);
  if (failed > 0) {
    console.log(`  ✗ Failed: ${failed}`);
  } else {
    console.log("  ✓ All articles saved successfully");
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      first: { type: "string", default: "1" },
      limit: { type: "string" },
      "selector-debug": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const target = positionals[0];
  if (!target) {
    console.error("Error: target (Feed ID or Aggregator type) is required.");
    console.error("Usage: npm run aggregator <target> [identifier] [--flags]");
    process.exit(1);
  }

  const identifier = positionals[1];
  const dryRun = values["dry-run"] ?? false;
  const verbose = values.verbose ?? false;
  const numFirst = Math.max(1, parseInt(values.first ?? "1", 10) || 1);
  const limit = values.limit ? parseInt(values.limit, 10) : undefined;
  const selectorDebug = values["selector-debug"] ?? false;

  let feed: Feed | undefined;
  const isNumeric = /^\d+$/.test(target);

  if (isNumeric) {
    const db = getDb();
    const existing = db
      .select()
      .from(feeds)
      .where(eq(feeds.id, parseInt(target, 10)))
      .get();
    if (!existing) {
      console.log(`✗ Feed with ID ${target} does not exist`);
      process.exit(1);
    }
    feed = existing;
    if (identifier) {
      feed.identifier = identifier;
    }
  } else {
    let finalIdentifier = identifier;
    if (!finalIdentifier) {
      const defaultId = getDefaultIdentifier(target);
      if (defaultId) {
        console.log(`Using default identifier for ${target}: ${defaultId}`);
        finalIdentifier = defaultId;
      } else {
        console.error(
          `Error: identifier required for aggregator type '${target}'. Please provide it as the second argument.`,
        );
        process.exit(1);
      }
    }

    const db = getDb();
    const user = db.select().from(users).get();

    if (!dryRun) {
      if (!user) {
        console.error("Error: No user found to associate with test feed");
        process.exit(1);
      }
      writeTransaction((tx) => {
        const inserted = tx
          .insert(feeds)
          .values({
            name: `Test ${target}`,
            aggregator: target,
            identifier: finalIdentifier,
            userId: user.id,
            dailyLimit: limit ?? 20,
          })
          .returning()
          .get();
        feed = inserted;
      });
    } else {
      feed = {
        id: 0,
        name: `Test ${target}`,
        aggregator: target,
        identifier: finalIdentifier,
        dailyLimit: limit ?? 20,
        enabled: true,
        userId: user?.id ?? "test-user",
        options: {},
        logo: null,
        logoSourceUrl: "",
        createdAt: new Date(),
        updatedAt: new Date(),
        redditSubredditId: null,
        youtubeChannelId: null,
      };
    }
  }

  if (limit && feed) {
    feed.dailyLimit = limit;
  }

  printSection("FEED CONFIGURATION");
  printField("Aggregator type", feed!.aggregator);
  printField("Identifier", feed!.identifier);
  printField("Daily limit", feed!.dailyLimit);
  printField("Enabled", feed!.enabled);
  printField("Feed name", feed!.name);
  printField("Feed ID", feed!.id ? feed!.id : "(not saved)");

  printSection("AGGREGATOR CLASS INFO");
  const aggregator = getAggregator(feed!);
  const aggregatorClass = aggregator.constructor as unknown as AggregatorCtor;

  printField("Class", aggregatorClass.name);

  const baseClasses: string[] = [];
  let proto = Object.getPrototypeOf(aggregatorClass);
  while (proto && proto.name && proto.name !== "Object") {
    baseClasses.push(proto.name);
    proto = Object.getPrototypeOf(proto);
  }
  printField("Base classes", baseClasses.length > 0 ? baseClasses.join(", ") : "BaseAggregator");

  if (typeof aggregator.getSourceUrl === "function") {
    printField("Source URL", aggregator.getSourceUrl());
  }

  if (selectorDebug) {
    const selectorAggregator = aggregator as SelectorAggregator;
    if (typeof selectorAggregator.getContentSelectors === "function") {
      printField("Content selectors", selectorAggregator.getContentSelectors().join(", "));
    } else if (aggregatorClass.contentSelectors) {
      printField("Content selectors", aggregatorClass.contentSelectors.join(", "));
    }

    if (typeof selectorAggregator.getIgnoreSelectors === "function") {
      printField("Selectors to remove", selectorAggregator.getIgnoreSelectors().join(", "));
    } else if (aggregatorClass.selectorsToRemove) {
      printField("Selectors to remove", aggregatorClass.selectorsToRemove.join(", "));
    }
  }

  printSection("AGGREGATION RUN");
  const startTime = performance.now();
  let articlesData: RawArticle[] = [];
  try {
    articlesData = await aggregator.aggregate();
  } catch (err) {
    printSection("ERROR");
    console.error(`✗ ${(err as Error).name || "Error"}: ${(err as Error).message}`);
    if (verbose && (err as Error).stack) {
      console.error("\n" + (err as Error).stack);
    }
    process.exit(1);
  }

  const elapsed = (performance.now() - startTime) / 1000;
  printField("Time elapsed", `${elapsed.toFixed(2)}s`);
  printField("Articles returned", articlesData.length);

  if (articlesData.length === 0) {
    console.log("⚠ No articles returned!");
    return;
  }

  printSection("ARTICLE SUMMARIES (first 10)");
  const summaryList = articlesData.slice(0, 10);
  summaryList.forEach((article, idx) => {
    const name = (article.name || "").slice(0, 60);
    const idStr = (article.identifier || "").slice(0, 60);
    const rawLen = (article.raw_content || "").length;
    const contentLen = (article.content || "").length;
    const dateStr = article.date ? article.date.toString() : "";

    console.log(`  ${(idx + 1).toString().padStart(2)}. ${name}`);
    console.log(`      URL: ${idStr}`);
    console.log(`      Content: ${rawLen} raw / ${contentLen} processed chars | Date: ${dateStr}`);
  });

  printSection(`ARTICLE DETAILS (first ${numFirst})`);
  const detailList = articlesData.slice(0, numFirst);
  detailList.forEach((article, idx) => {
    console.log(`\n  Article ${idx + 1}:`);
    console.log(`    Name: ${(article.name || "").slice(0, 100)}`);
    console.log(`    URL: ${article.identifier || ""}`);
    console.log(`    Date: ${article.date || ""}`);
    console.log(`    Author: ${article.author || "(none)"}`);
    console.log(`    Raw content: ${(article.raw_content || "").length} chars`);
    console.log(`    Processed content: ${(article.content || "").length} chars`);

    if (verbose) {
      const raw = (article.raw_content || "").slice(0, 800);
      console.log("\n    >>> RAW CONTENT (first 800 chars):");
      console.log(`    ${raw}...\n`);

      const content = (article.content || "").slice(0, 800);
      console.log("    >>> PROCESSED CONTENT (first 800 chars):");
      console.log(`    ${content}...\n`);
    }
  });

  printSection("VALIDATION");
  validateArticles(articlesData);

  if (!dryRun && feed) {
    printSection("DATABASE SAVE");
    await saveArticles(feed, articlesData);
  } else {
    console.log("(Dry-run mode: articles NOT saved to database)");
  }
}

main().catch((err) => {
  console.error("Unhandled error in CLI:", err);
  process.exit(1);
});
