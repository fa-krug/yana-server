import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";

import { mediaRoot } from "@/lib/avatar-storage";
import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { articleImages } from "@/lib/db/schema/articles";

const HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * `GET /media/images/<hash>` -- serves content-addressed article images.
 *
 * Hash is validated as 64 hex characters before any filesystem or DB access.
 * Serves file bytes with public, max-age=31536000, immutable cache header.
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ hash: string }> },
): Promise<Response> {
  await requireUser();

  const { hash } = await ctx.params;
  if (!HASH_PATTERN.test(hash)) {
    return refused();
  }

  const row = getDb()
    .select()
    .from(articleImages)
    .where(eq(articleImages.contentHash, hash.toLowerCase()))
    .get();

  if (!row) {
    return refused();
  }

  const filePath = path.join(mediaRoot(), row.file);

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(filePath);
  } catch {
    return refused();
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": row.contentType,
      "Content-Length": String(bytes.byteLength),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

function refused(): Response {
  return new Response(null, { status: 404 });
}
