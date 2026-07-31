import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { AVATAR_SIZE } from "./avatar";
import {
  AVATAR_CONTENT_TYPE,
  avatarDirectory,
  avatarFilePath,
  isUserIdShaped,
  mediaRoot,
  processAvatar,
} from "./avatar-storage";

/** A well-formed id: Better Auth's alphabet, Better Auth's length. */
const ID = "Nu2fXJ3rQKp1sVdWyBz0aLcMhE7tG4iO";

describe("mediaRoot", () => {
  afterEach(() => {
    delete process.env.MEDIA_PATH;
  });

  it("defaults to ./media beside the database's ./data", () => {
    expect(mediaRoot()).toBe(path.join(process.cwd(), "media"));
  });

  it("is read per call, so an override needs no module reset", () => {
    process.env.MEDIA_PATH = "/srv/yana-media";
    expect(mediaRoot()).toBe("/srv/yana-media");
    expect(avatarDirectory()).toBe(path.join("/srv/yana-media", "avatars"));
  });
});

describe("avatarFilePath", () => {
  it("puts a well-formed id inside the avatars directory", () => {
    expect(avatarFilePath(ID)).toBe(path.join(avatarDirectory(), `${ID}.webp`));
  });

  /**
   * The traversal shapes. Each is refused because it fails the whole-string
   * allow-list, not because it was recognised and stripped -- which is the
   * point: a blocklist only refuses the encodings someone remembered.
   */
  it.each([
    ["a parent-directory hop", "../../etc/passwd"],
    ["a hop inside a valid-looking id", `..${path.sep}${ID}`],
    ["a bare parent reference", ".."],
    ["a single dot", "."],
    ["an absolute path", "/etc/passwd"],
    ["a Windows separator", `..\\..\\${ID}`],
    ["a percent-encoded hop", "%2e%2e%2fetc%2fpasswd"],
    ["a double-encoded hop", "%252e%252e%252f"],
    ["an embedded NUL", `${ID.slice(0, 31)}\0`],
    ["a newline", `${ID}\n`],
    ["an extension", `${ID}.webp`],
    ["a nested path that ends in a valid id", `avatars/${ID}`],
    ["an empty segment", ""],
    ["one character too few", ID.slice(1)],
    ["one character too many", `${ID}a`],
    ["a non-ASCII homoglyph", `${ID.slice(0, 31)}Ο`],
    ["a SQL-ish payload", "' OR 1=1 --"],
  ])("refuses %s", (_label, segment) => {
    expect(avatarFilePath(segment)).toBe(null);
    expect(isUserIdShaped(segment)).toBe(false);
  });

  it("cannot produce a path outside the avatars directory for any refused shape", () => {
    // The property behind the table above, stated once: whatever comes back is
    // either null or a child of the directory. There is no third answer.
    for (const segment of ["..", "../..", `../${ID}`, ID, "/etc/passwd"]) {
      const file = avatarFilePath(segment);
      if (file === null) continue;
      expect(path.resolve(file).startsWith(path.resolve(avatarDirectory()) + path.sep)).toBe(true);
    }
  });
});

describe("processAvatar", () => {
  /** A deliberately non-square source, so `fit: cover` has something to do. */
  async function sourcePng(width = 800, height = 400): Promise<Buffer> {
    return sharp({
      create: { width, height, channels: 3, background: { r: 12, g: 200, b: 90 } },
    })
      .png()
      .toBuffer();
  }

  it("re-encodes to a square WebP of the declared size", async () => {
    const out = await processAvatar(await sourcePng());
    const meta = await sharp(out).metadata();

    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(AVATAR_SIZE);
    expect(meta.height).toBe(AVATAR_SIZE);
    // The constant the route handler sends is a fact about this output.
    expect(`image/${meta.format}`).toBe(AVATAR_CONTENT_TYPE);
  });

  it("discards everything that is not pixels", async () => {
    // The whole reason this function exists. An upload served back untouched is
    // how an "image" becomes stored HTML; here the payload is appended after a
    // real PNG's data, which every browser sniffer and no image decoder reads.
    const payload = "<script>alert(document.cookie)</script>";
    const poisoned = Buffer.concat([await sourcePng(), Buffer.from(payload)]);

    const out = await processAvatar(poisoned);

    expect(out.includes(payload)).toBe(false);
    // RIFF....WEBP -- the output is a WebP container and nothing else.
    expect(out.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(out.subarray(8, 12).toString("latin1")).toBe("WEBP");
  });

  it("turns an SVG carrying script into pixels", async () => {
    // An SVG is a document, not an image, and serving one back is a stored-XSS
    // primitive. Rasterising it keeps the picture and drops the document.
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">` +
        `<script>alert(1)</script><rect width="400" height="400" fill="#0c8"/></svg>`,
    );

    const out = await processAvatar(svg);

    expect(out.includes("alert(1)")).toBe(false);
    expect((await sharp(out).metadata()).format).toBe("webp");
  });

  it("strips EXIF orientation after honouring it", async () => {
    // .rotate() applies the tag; the re-encode then removes it. Doing that in
    // the other order would leave a photograph cropped along the wrong axis.
    const upright = await sharp({
      create: { width: 600, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .withExif({ IFD0: { Orientation: "6" } })
      .jpeg()
      .toBuffer();

    const meta = await sharp(await processAvatar(upright)).metadata();

    expect(meta.orientation).toBe(undefined);
    expect(meta.width).toBe(AVATAR_SIZE);
  });

  it("refuses a small file that decodes enormous", async () => {
    // The decompression bomb. A byte cap on the upload does not bound this: a
    // flat 6000x5000 PNG is a few kB on the wire and 30 MP in memory, and the
    // real thing goes much further (a 758 kB PNG decodes at 256 MP, ~250 MB of
    // RSS for one call). libvips checks the *header*, so nothing is decoded.
    const bomb = await sharp({
      create: { width: 6000, height: 5000, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    expect(bomb.byteLength).toBeLessThan(200_000);
    // Matched on the message, so the test proves the *pixel limit* refused it
    // rather than some other decode failure that happened to throw.
    await expect(processAvatar(bomb)).rejects.toThrow(/pixel limit/i);
  });

  it("still accepts a photograph a real camera would produce", async () => {
    // The limit has to be generous enough not to refuse an ordinary upload --
    // 12 MP here, which is a phone's default mode.
    const photo = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: { r: 30, g: 60, b: 90 } },
    })
      .jpeg()
      .toBuffer();

    expect((await sharp(await processAvatar(photo)).metadata()).width).toBe(AVATAR_SIZE);
  });

  it("rejects a file that is not an image at all", async () => {
    // The caller's signal to refuse the upload -- task 6 must not catch this
    // and store the bytes anyway.
    await expect(processAvatar(Buffer.from("<!doctype html><h1>not an image"))).rejects.toThrow();
  });
});
