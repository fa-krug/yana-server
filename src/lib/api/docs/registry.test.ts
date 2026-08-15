import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ENDPOINT_REGISTRY } from "./registry";

/**
 * Every route this plan documents, as (method, path) pairs matching what
 * ENDPOINT_REGISTRY must declare. Hand-listed rather than derived from a glob
 * over HTTP verbs alone, because three of these are flow routes outside
 * /api/v1 (device/pair, webview-session-token, webview-session) -- see the
 * design spec's Goal section for why those three are in scope and nothing
 * else outside /api/v1 is.
 */
const EXPECTED: Array<{ method: string; path: string; file: string }> = [
  { method: "GET", path: "/api/v1/feeds", file: "src/app/api/v1/feeds/route.ts" },
  { method: "GET", path: "/api/v1/tags", file: "src/app/api/v1/tags/route.ts" },
  { method: "GET", path: "/api/v1/articles/sync", file: "src/app/api/v1/articles/sync/route.ts" },
  {
    method: "PATCH",
    path: "/api/v1/articles/{id}",
    file: "src/app/api/v1/articles/[id]/route.ts",
  },
  {
    method: "GET",
    path: "/api/v1/articles/{id}/content",
    file: "src/app/api/v1/articles/[id]/content/route.ts",
  },
  {
    method: "POST",
    path: "/api/v1/articles/{id}/reload",
    file: "src/app/api/v1/articles/[id]/reload/route.ts",
  },
  { method: "POST", path: "/api/v1/aggregate", file: "src/app/api/v1/aggregate/route.ts" },
  { method: "GET", path: "/api/v1/runs/{id}", file: "src/app/api/v1/runs/[id]/route.ts" },
  { method: "GET", path: "/api/v1/jobs/events", file: "src/app/api/v1/jobs/events/route.ts" },
  { method: "GET", path: "/api/v1/images/{hash}", file: "src/app/api/v1/images/[hash]/route.ts" },
  {
    method: "GET",
    path: "/api/v1/reading-position",
    file: "src/app/api/v1/reading-position/route.ts",
  },
  {
    method: "PATCH",
    path: "/api/v1/reading-position",
    file: "src/app/api/v1/reading-position/route.ts",
  },
  { method: "POST", path: "/api/v1/ai/prompt", file: "src/app/api/v1/ai/prompt/route.ts" },
  {
    method: "POST",
    path: "/api/v1/auth/webview-session-token",
    file: "src/app/api/v1/auth/webview-session-token/route.ts",
  },
  { method: "GET", path: "/device/pair", file: "src/app/device/pair/route.ts" },
  { method: "GET", path: "/webview-session", file: "src/app/webview-session/route.ts" },
];

describe("ENDPOINT_REGISTRY completeness", () => {
  it("every route file's exported HTTP methods exist in EXPECTED", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    for (const { method, file } of EXPECTED) {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      expect(source, `${file} should export ${method}`).toMatch(
        new RegExp(`export async function ${method}\\(`),
      );
    }
  });

  it("has a defineEndpoint() entry for every expected (method, path) pair", () => {
    const declared = new Set(ENDPOINT_REGISTRY.map((e) => `${e.method} ${e.path}`));
    const missing = EXPECTED.filter((e) => !declared.has(`${e.method} ${e.path}`));
    expect(missing, `missing registry entries: ${JSON.stringify(missing)}`).toEqual([]);
  });

  it("has no registry entry for a route that doesn't exist", () => {
    const expected = new Set(EXPECTED.map((e) => `${e.method} ${e.path}`));
    const extra = ENDPOINT_REGISTRY.filter((e) => !expected.has(`${e.method} ${e.path}`));
    expect(extra, `unexpected registry entries: ${JSON.stringify(extra)}`).toEqual([]);
  });
});
