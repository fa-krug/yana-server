import fs from "fs";
import * as cheerio from "cheerio";
import { getDb, writeTransaction } from "./src/lib/db/client";
import { articles } from "./src/lib/db/schema/articles";
import { feeds } from "./src/lib/db/schema/feeds";
import { users } from "./src/lib/db/schema/users";
import { eq } from "drizzle-orm";

function importRss() {
  const html = fs.readFileSync("mock-rss.html", "utf-8");
  const $ = cheerio.load(html);

  const items: any[] = [];
  $(".item").each((_, el) => {
    const title = $(el).find(".title").text();
    const link = $(el).find(".link").text();
    const pubDateStr = $(el).find(".pubDate").text();
    const description = $(el).find(".description").text();

    items.push({ title, link, pubDateStr, description });
  });

  const db = getDb();

  writeTransaction((tx) => {
    let user = tx.select().from(users).limit(1).get();
    if (!user) {
      console.log("No user found. Creating a default user.");
      const result = tx
        .insert(users)
        .values({
          id: "mock_user_1",
          name: "Mock User",
          email: "mock@example.com",
        })
        .returning()
        .get();
      user = result;
    }

    let feed = tx.select().from(feeds).where(eq(feeds.userId, user!.id)).limit(1).get();
    if (!feed) {
      console.log("No feed found. Creating a mock feed.");
      const result = tx
        .insert(feeds)
        .values({
          name: "Mock Feed",
          aggregator: "full_website",
          identifier: "https://example.com/mock",
          userId: user!.id,
        })
        .returning()
        .get();
      feed = result;
    }

    let inserted = 0;
    for (const item of items) {
      try {
        tx.insert(articles)
          .values({
            name: item.title,
            identifier: item.link,
            plainText: item.description,
            date: new Date(item.pubDateStr),
            feedId: feed.id,
          })
          .run();
        inserted++;
      } catch (e) {
        console.error("Error inserting item:", item.title, e);
      }
    }
    console.log(`Successfully imported ${inserted} items.`);
  });
}

importRss();
