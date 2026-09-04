import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrationsAt } from "@/lib/db/test-support";

import { MAX_DECODE_PIXELS } from "@/lib/aggregators/images/compression";

import { pickBestIcon, removeWhiteBackground } from "./logo";

async function solidWhitePng() {
  return await sharp({
    create: {
      width: 10,
      height: 10,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

async function transparentPng() {
  return await sharp({
    create: {
      width: 10,
      height: 10,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
}

async function hasTransparency(buffer: Buffer) {
  const { data } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

describe("pickBestIcon", () => {
  it("prefers a larger declared size", () => {
    const chosen = pickBestIcon([
      { href: "/small.png", sizes: "16x16", rel: "icon" },
      { href: "/large.png", sizes: "180x180", rel: "apple-touch-icon" },
    ]);
    expect(chosen?.href).toBe("/large.png");
  });

  it("treats sizes=any as best", () => {
    const chosen = pickBestIcon([
      { href: "/png.png", sizes: "48x48", rel: "icon" },
      { href: "/svg.svg", sizes: "any", rel: "icon" },
    ]);
    expect(chosen?.href).toBe("/svg.svg");
  });

  it("returns null when there is nothing to pick", () => {
    expect(pickBestIcon([])).toBeNull();
  });
});

describe("removeWhiteBackground", () => {
  it("makes near-white pixels transparent", async () => {
    const output = await removeWhiteBackground(await solidWhitePng());
    expect(await hasTransparency(output)).toBe(true);
  });

  it("leaves an image that is already transparent alone", async () => {
    const input = await transparentPng();
    expect(await removeWhiteBackground(input)).toEqual(input);
  });
});

describe("storeLogo", () => {
  let dbPath: string;
  let mediaPath: string;
  let client: typeof import("@/lib/db/client");
  let schema: typeof import("@/lib/db/schema");
  let logo: typeof import("./logo");
  let feedId: number;

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  beforeEach(async () => {
    // storeLogo transitively reaches ../db/client (and, via storeImageBytes,
    // @/lib/db/client -- the same file). Both must be dynamically imported
    // AFTER vi.resetModules(), like every other test here that touches the
    // database: a static top-of-file import of "./logo" would freeze a
    // reference to the module graph as it existed at file-load time, before
    // any DATABASE_PATH was ever set, so its own lazy getDb() singleton would
    // diverge from the fixture's freshly-imported one instead of sharing it.
    vi.resetModules();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-logo-${stamp}.db`);
    mediaPath = fs.mkdtempSync(path.join(os.tmpdir(), `yana-logo-media-${stamp}-`));
    applyMigrationsAt(dbPath);
    process.env.DATABASE_PATH = dbPath;
    process.env.MEDIA_PATH = mediaPath;
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-this-file-0123456789";

    client = await import("@/lib/db/client");
    schema = await import("@/lib/db/schema");
    logo = await import("./logo");

    const { createUserWithPassword } = await import("@/lib/auth/server");
    const user = await createUserWithPassword({
      email: "a@example.com",
      password: "correct horse battery staple",
    });
    const feed = client.writeTransaction((tx) =>
      tx
        .insert(schema.feeds)
        .values({
          name: "F",
          aggregator: "full_website",
          identifier: "https://x.example",
          userId: user.id,
        })
        .returning({ id: schema.feeds.id })
        .get(),
    );
    feedId = feed.id;
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.MEDIA_PATH;
    delete process.env.BETTER_AUTH_SECRET;
    if (client) {
      const connection = raw(client.getDb());
      if (connection.open) connection.close();
    }
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
    fs.rmSync(mediaPath, { recursive: true, force: true });
  });

  it("stores the logo content-addressed and sets logoImageHash", async () => {
    const bytes = await solidWhitePng();
    const hash = await logo.storeLogo(feedId, bytes, "https://example.com/favicon.ico");
    if (!hash) throw new Error("expected storeLogo to resolve a hash for a valid PNG");

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const feed = client
      .getDb()
      .select()
      .from(schema.feeds)
      .where(eq(schema.feeds.id, feedId))
      .get();
    expect(feed?.logoImageHash).toBe(hash);
    expect(feed?.logoSourceUrl).toBe("https://example.com/favicon.ico");

    const image = client
      .getDb()
      .select()
      .from(schema.articleImages)
      .where(eq(schema.articleImages.contentHash, hash))
      .get();
    expect(image).toBeDefined();
  });

  it("dedupes two feeds with an identical favicon", async () => {
    const { createUserWithPassword } = await import("@/lib/auth/server");
    const otherUser = await createUserWithPassword({
      email: "b@example.com",
      password: "correct horse battery staple",
    });
    const otherFeed = client.writeTransaction((tx) =>
      tx
        .insert(schema.feeds)
        .values({
          name: "G",
          aggregator: "full_website",
          identifier: "https://y.example",
          userId: otherUser.id,
        })
        .returning({ id: schema.feeds.id })
        .get(),
    );

    const bytes = await solidWhitePng();
    const hashA = await logo.storeLogo(feedId, bytes, "https://a.example.com/favicon.ico");
    const hashB = await logo.storeLogo(otherFeed.id, bytes, "https://b.example.com/favicon.ico");
    if (!hashA) throw new Error("expected storeLogo to resolve a hash for a valid PNG");

    expect(hashA).toBe(hashB);
    const rows = client
      .getDb()
      .select()
      .from(schema.articleImages)
      .where(eq(schema.articleImages.contentHash, hashA))
      .all();
    expect(rows).toHaveLength(1);
  });

  // `storeLogo()`'s resize ran on a bare `sharp()` -- sharp's 268 MP default,
  // which is no protection -- over bytes `fetchIconBytes()` pulls from a URL a
  // site's own `<link rel="icon">` or web manifest declared, under nothing but
  // a 2 MB byte cap. `removeWhiteBackground()` above it is only accidentally
  // safe: its MAX_FILL_PIXELS bail returns *before* decoding, and what it
  // returns is the full-size original, which is exactly what reached the
  // unguarded resize. This is the worker-executed `feed.logo` path, with
  // WORKER_CONCURRENCY peers.
  it("refuses an icon whose pixel count exceeds the decode limit", async () => {
    // 36 MP of flat colour: ~1 MB of PNG, hundreds of MB decoded. Past
    // MAX_DECODE_PIXELS and comfortably inside the 2 MB icon byte cap, so no
    // byte-level check can see it.
    const bomb = await sharp({
      create: { width: 6000, height: 6000, channels: 3, background: { r: 4, g: 5, b: 6 } },
    })
      .png({ compressionLevel: 1 })
      .toBuffer();

    expect(6000 * 6000).toBeGreaterThan(MAX_DECODE_PIXELS);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);

    // Unguarded, sharp resizes this to 128x128 happily and returns a hash --
    // having decoded the whole raster first. A feed with no logo is the cost
    // of refusing, and the `feed.logo` handler already treats null that way.
    expect(await logo.storeLogo(feedId, bomb, "https://example.com/huge.png")).toBeNull();

    const feed = client
      .getDb()
      .select()
      .from(schema.feeds)
      .where(eq(schema.feeds.id, feedId))
      .get();
    expect(feed?.logoImageHash).toBeNull();
  });

  it("returns null instead of throwing when the icon isn't a format sharp can decode", async () => {
    // A real Windows .ico: sharp/libvips has no ICO codec, which is exactly what a bare
    // `/favicon.ico` fallback (see jobs/handlers/logo.ts) can hand storeLogo.
    const fakeIco = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00]);
    const hash = await logo.storeLogo(feedId, fakeIco, "https://example.com/favicon.ico");
    expect(hash).toBeNull();

    const feed = client
      .getDb()
      .select()
      .from(schema.feeds)
      .where(eq(schema.feeds.id, feedId))
      .get();
    expect(feed?.logoImageHash).toBeNull();
  });
});
