import path from "node:path";

import sharp from "sharp";

/**
 * Avatar storage: the server-only half of `./avatar`.
 *
 * `sharp` is a native addon and `node:path` is not a browser module, so nothing
 * under `src/components` may import this file -- the presentation helpers it
 * would actually want are in `./avatar`, which imports nothing.
 */

/** Every avatar is re-encoded to this, so the served type is a constant. */
export const AVATAR_CONTENT_TYPE = "image/webp";

/** Square, and large enough for a 2x 128px rendering. */
export const AVATAR_SIZE = 256;

/**
 * The shape a user id is allowed to have, checked before it is ever joined into
 * a filesystem path.
 *
 * This is Better Auth's `generateId()` exactly -- `createRandomStringGenerator`
 * over `a-z A-Z 0-9`, 32 characters (`@better-auth/core/utils/id`) -- and it is
 * deliberately an *allow-list of the whole string*, not a scan for `..` or `/`.
 * Sanitising is how traversal bugs survive: every blocklist is a list of the
 * encodings someone thought of, and `%2e%2e%2f`, a NUL byte, a backslash on
 * Windows and a bare `.` are all things this pattern refuses without having to
 * enumerate them. Nothing that matches it can contain a path separator, so
 * `path.join()` below cannot escape the avatars directory.
 *
 * If a future `advanced.generateId` changes the id format, avatars 404 rather
 * than misbehave -- and `avatar-storage.test.ts` asserts a *real* Better
 * Auth-minted id against this pattern, so the change fails a test first.
 */
const USER_ID = /^[A-Za-z0-9]{32}$/;

/**
 * The root of the writable media volume (`/app/media` in the image, `./media`
 * locally -- both gitignored and both empty until something writes to them).
 *
 * A function rather than a module constant like `DB_PATH`: there is no
 * connection to cache here, so reading the environment per call costs nothing
 * and lets a test point `MEDIA_PATH` at a temp directory without having to
 * reset the module registry first.
 */
export function mediaRoot(): string {
  return process.env.MEDIA_PATH ?? path.join(process.cwd(), "media");
}

/** Where avatars live under the media root. */
export function avatarDirectory(): string {
  return path.join(mediaRoot(), "avatars");
}

/**
 * The file this user's avatar is stored at, or `null` if the id is not a user
 * id.
 *
 * **The validation lives in here, not at the call sites, on purpose.** Phase
 * 4's review already found an open redirect that looked correctly guarded
 * because it validated an input and then returned a *normalised* value; the
 * lesson is that the checked value and the used value have to be the same one.
 * Making this the only way to obtain an avatar path means no caller can build
 * one from a string that was never checked -- the route handler that reads and
 * task 6's upload that writes both go through here.
 */
export function avatarFilePath(userId: string): string | null {
  if (!USER_ID.test(userId)) return null;
  return path.join(avatarDirectory(), `${userId}.webp`);
}

/** Is this string shaped like a user id? Exposed for the storage tests. */
export function isUserIdShaped(value: string): boolean {
  return USER_ID.test(value);
}

/**
 * How many pixels an upload may decode to.
 *
 * **A byte cap on the upload does not bound this.** A decompression bomb is
 * small on the wire and enormous in memory: a 758 kB PNG can declare
 * 16000x16000 and decode at 256 MP, which is roughly 250 MB of RSS for one
 * call and about 700 MB for ten concurrent ones -- on a self-hosted box that
 * may have a modest ceiling. sharp's own default is 268 MP, which is no
 * protection at all here, so the limit is set to something an *avatar* could
 * plausibly need.
 *
 * 25 MP covers 5000x5000 and 6000x4200 -- every DSLR frame and every current
 * phone camera in its default mode -- at about 100 MB for the decoded raster.
 * A 48/50 MP "high resolution" shot is refused, and the user crops or shoots
 * normally. That is the line: generous for real photographs, closed for bombs.
 * libvips checks it against the *header* dimensions, so an oversized file is
 * rejected before any pixels are decoded.
 */
const MAX_INPUT_PIXELS = 25_000_000;

/**
 * Wall-clock ceiling on the whole pipeline.
 *
 * The pixel limit bounds memory but not time: a legal-sized image can still be
 * pathological (a deeply nested SVG, a highly interlaced PNG), and a request
 * that never returns is a worker that never returns. Ten seconds is far beyond
 * the ~50 ms a real avatar takes and still short enough not to hold a
 * connection open.
 */
const TIMEOUT_SECONDS = 10;

/**
 * Re-encode an upload rather than storing it.
 *
 * **An uploaded file that is served back untouched is how an "image" upload
 * becomes stored HTML, or an SVG carrying script.** Decoding to pixels and
 * re-encoding discards everything that is not pixels: the container, any
 * trailing bytes appended after the image data, EXIF, ICC and XMP payloads, and
 * the original content type. It is also what makes the route handler's fixed
 * `Content-Type: image/webp` a true statement rather than a guess -- the
 * handler serves only what came out of here.
 *
 * `failOn: "error"` refuses a truncated or malformed file instead of silently
 * producing a partial image; the throw is the caller's signal to reject the
 * upload. `.rotate()` comes before `.resize()` so an EXIF-rotated photograph is
 * cropped the way the camera meant it -- after re-encoding the orientation tag
 * is gone, so applying it afterwards is not possible.
 *
 * **The resource limits live here, not in the caller**, which is the whole
 * reason this function exists: a caller cannot forget what it never had to
 * remember, and every future upload path inherits them. Do not move them out.
 */
export async function processAvatar(input: Buffer): Promise<Buffer> {
  return sharp(input, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
    .timeout({ seconds: TIMEOUT_SECONDS })
    .rotate()
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: "cover" })
    .webp({ quality: 82 })
    .toBuffer();
}
