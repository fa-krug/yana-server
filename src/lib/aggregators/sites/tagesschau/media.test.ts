import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrationsAt } from "@/lib/db/test-support";
import { RawArticle } from "../../base";

const AUDIO_PAGE_HTML = `<html><body>
  <div data-v-type="MediaPlayer" class="mediaplayer teaser-top" data-v='${JSON.stringify({
    mc: {
      streams: [
        {
          isAudioOnly: true,
          poster: "https://example.com/poster.jpg",
          media: [{ url: "https://example.com/episode.mp3", mimeType: "audio/mpeg" }],
        },
      ],
    },
  }).replace(/'/g, "&#39;")}'>
  </div>
</body></html>`;

/**
 * Regression test for the bug this fixed: the media-header poster used to
 * embed `yana-img://<sha256(url)>` -- a hash of the URL string, computed
 * synchronously with no fetch -- which pointed at bytes that were never
 * downloaded or stored anywhere. `extractContent()`/`processContent()` here
 * must produce a reference to bytes this process actually fetched and wrote.
 */
describe("TagesschauAggregator media header image", () => {
  let dbPath: string;
  let mediaPath: string;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let TagesschauAggregator: typeof import("./aggregator").TagesschauAggregator;

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  beforeEach(async () => {
    vi.resetModules();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-tagesschau-media-${stamp}.db`);
    mediaPath = fs.mkdtempSync(path.join(os.tmpdir(), `yana-tagesschau-media-${stamp}-`));
    applyMigrationsAt(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.MEDIA_PATH = mediaPath;

    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    ({ TagesschauAggregator } = await import("./aggregator"));
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.MEDIA_PATH;
    const connection = raw(client.getDb());
    if (connection.open) connection.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
    fs.rmSync(mediaPath, { recursive: true, force: true });
  });

  it("fetches and stores the poster's real bytes instead of hashing the URL", async () => {
    const posterBytes = await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array(posterBytes), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );

    const agg = new TagesschauAggregator({
      identifier: "https://www.tagesschau.de/infoservices/alle-meldungen-100~rss2.xml",
      dailyLimit: 20,
    });

    const article: RawArticle = {
      name: "Test",
      identifier: "https://www.tagesschau.de/inland/test-100.html",
      raw_content: AUDIO_PAGE_HTML,
      content: "",
      date: new Date(),
    };

    const extracted = agg.extractContent(AUDIO_PAGE_HTML, article);
    const processed = await agg.processContent(extracted, article);

    // The fetch actually happened -- proving this is real network I/O, not a
    // synchronous hash of the URL string.
    expect(fetchSpy).toHaveBeenCalledWith("https://example.com/poster.jpg", expect.anything());

    const refMatch = processed.match(/yana-img:\/\/([0-9a-f]{64})/);
    expect(refMatch).not.toBeNull();
    const storedHash = refMatch![1]!;

    // The old, broken behavior: a hash of the URL string, not the bytes.
    const urlHash = crypto
      .createHash("sha256")
      .update("https://example.com/poster.jpg")
      .digest("hex");
    expect(storedHash).not.toBe(urlHash);

    // And it resolves to a real row -- not just a differently-shaped fake.
    const imageRow = client
      .getDb()
      .select()
      .from(schema.articleImages)
      .where(eq(schema.articleImages.contentHash, storedHash))
      .get();
    expect(imageRow).toBeDefined();
    expect(imageRow?.contentType).toMatch(/^image\//);
  });
});
