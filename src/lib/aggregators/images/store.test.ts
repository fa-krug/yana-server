import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { articleImages } from "@/lib/db/schema/articles";
import { applyMigrationsAt } from "@/lib/db/test-support";

describe("image store", () => {
  let dbPath: string;
  let mediaPath: string;
  let client: typeof import("@/lib/db/client");
  let store: typeof import("./store");

  function raw(db: unknown): Database.Database {
    return (db as { $client: Database.Database }).$client;
  }

  beforeEach(async () => {
    vi.resetModules();

    const stamp = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    dbPath = path.join(os.tmpdir(), `yana-store-test-${stamp}.db`);
    mediaPath = fs.mkdtempSync(path.join(os.tmpdir(), `yana-store-media-${stamp}-`));
    applyMigrationsAt(dbPath);

    process.env.DATABASE_PATH = dbPath;
    process.env.MEDIA_PATH = mediaPath;

    client = await import("@/lib/db/client");
    store = await import("./store");
  });

  afterEach(() => {
    delete process.env.DATABASE_PATH;
    delete process.env.MEDIA_PATH;
    if (client) {
      const connection = raw(client.getDb());
      if (connection.open) connection.close();
    }
    for (const suffix of ["", "-shm", "-wal"]) {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    }
    fs.rmSync(mediaPath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("builds image refs and finds image refs in text", () => {
    const hash = "a".repeat(64);
    const ref = store.buildImageRef(hash);
    expect(ref).toBe(`${store.IMAGE_REF_SCHEME}${hash}`);

    const text = `Check out <img src="${ref}"> and ${ref}`;
    const refs = store.findImageRefs(text);
    expect(refs.size).toBe(1);
    expect(refs.has(hash)).toBe(true);
  });

  it("stores image bytes and creates database row and file", async () => {
    const rawPixels = Buffer.alloc(200 * 200 * 3, 100);
    const imagePng = await sharp(rawPixels, {
      raw: { width: 200, height: 200, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

    const hash = await store.storeImageBytes(imagePng, "image/png", { compress: true });
    expect(hash).not.toBeNull();

    const row = client
      .getDb()
      .select()
      .from(articleImages)
      .where(eq(articleImages.contentHash, hash!))
      .get();
    expect(row).toBeDefined();

    const diskFile = path.join(mediaPath, row!.file);
    expect(fs.existsSync(diskFile)).toBe(true);
  });

  it("deduplicates identical image bytes", async () => {
    const rawPixels = Buffer.alloc(200 * 200 * 3, 150);
    const imagePng = await sharp(rawPixels, {
      raw: { width: 200, height: 200, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

    const hash1 = await store.storeImageBytes(imagePng, "image/png");
    const hash2 = await store.storeImageBytes(imagePng, "image/png");

    expect(hash1).toBe(hash2);

    const rows = client.getDb().select().from(articleImages).all();
    expect(rows.length).toBe(1);
  });

  it("repairs missing disk file for an existing DB row", async () => {
    const rawPixels = Buffer.alloc(200 * 200 * 3, 180);
    const imagePng = await sharp(rawPixels, {
      raw: { width: 200, height: 200, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

    const hash = await store.storeImageBytes(imagePng, "image/png");
    const row = client
      .getDb()
      .select()
      .from(articleImages)
      .where(eq(articleImages.contentHash, hash!))
      .get();
    const diskFile = path.join(mediaPath, row!.file);

    fs.unlinkSync(diskFile);
    expect(fs.existsSync(diskFile)).toBe(false);

    const hashAgain = await store.storeImageBytes(imagePng, "image/png");
    expect(hashAgain).toBe(hash);
    expect(fs.existsSync(diskFile)).toBe(true);
  });

  it("rejects 1x1 tracking pixels as non-content", async () => {
    const pixel1x1 = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();

    const hash = await store.storeImageBytes(pixel1x1, "image/png");
    expect(hash).toBeNull();
  });

  it("throws ImageHashCollisionError if hash collision has different byte size", async () => {
    const rawPixels = Buffer.alloc(200 * 200 * 3, 200);
    const imagePng1 = await sharp(rawPixels, {
      raw: { width: 200, height: 200, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

    const hash = await store.storeImageBytes(imagePng1, "image/png", { compress: false });
    expect(hash).not.toBeNull();

    client
      .getDb()
      .update(articleImages)
      .set({ byteSize: 999999 })
      .where(eq(articleImages.contentHash, hash!))
      .run();

    await expect(
      store.storeImageBytes(imagePng1, "image/png", { compress: false }),
    ).rejects.toThrow(store.ImageHashCollisionError);
  });

  it("storeBodyImageRefFromUrl returns NON_CONTENT_IMAGE for non-image responses or tracking pixels", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html>Html</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    const res1 = await store.storeBodyImageRefFromUrl("https://example.com/html");
    expect(res1).toBe(store.NON_CONTENT_IMAGE);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 500 }),
    );

    const res2 = await store.storeBodyImageRefFromUrl("https://example.com/500");
    expect(res2).toBeNull();

    const validPng = await sharp({
      create: {
        width: 300,
        height: 300,
        channels: 3,
        background: { r: 200, g: 100, b: 50 },
      },
    })
      .png()
      .toBuffer();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array(validPng), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );

    const res3 = await store.storeBodyImageRefFromUrl("https://example.com/valid.png");
    expect(typeof res3).toBe("string");
    expect(res3).toContain(store.IMAGE_REF_SCHEME);
  });

  it("storeImageRefFromUrl fetches and stores image", async () => {
    const validPng = await sharp({
      create: {
        width: 300,
        height: 300,
        channels: 3,
        background: { r: 50, g: 100, b: 200 },
      },
    })
      .png()
      .toBuffer();

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(new Uint8Array(validPng), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );

    const ref = await store.storeImageRefFromUrl("https://example.com/valid.png");
    expect(ref).not.toBeNull();
    expect(ref).toContain(store.IMAGE_REF_SCHEME);
  });
});
