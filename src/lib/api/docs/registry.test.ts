import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ENDPOINT_REGISTRY } from "./registry";

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const API_V1_ROOT = path.join(REPO_ROOT, "src/app/api/v1");

/** Converts a Next.js route file's directory path to an OpenAPI-style path template:
 * `src/app/api/v1/articles/[id]/route.ts` -> `/api/v1/articles/{id}`. */
function toApiPath(routeFile: string): string {
  const rel = path
    .relative(path.join(REPO_ROOT, "src/app"), routeFile)
    .replace(/\/route\.ts$/, "")
    .replace(/\[(\w+)\]/g, "{$1}");
  return `/${rel}`;
}

/**
 * Walks the real `/api/v1/**` route tree and returns every (method, path) pair a route
 * file actually exports -- so a new route is discovered automatically instead of relying
 * on a hand-maintained list that a new file can silently bypass (the exact gap that let
 * `src/app/api/v1/openapi.json/route.ts` ship with no registry entry and no failing test).
 */
function discoverApiV1Routes(): Array<{ method: string; path: string; file: string }> {
  const results: Array<{ method: string; path: string; file: string }> = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === "route.ts") {
        const source = fs.readFileSync(full, "utf8");
        const apiPath = toApiPath(full);
        const relFile = path.relative(REPO_ROOT, full);
        for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
          if (new RegExp(`export async function ${method}\\(`).test(source)) {
            results.push({ method, path: apiPath, file: relFile });
          }
        }
      }
    }
  }
  walk(API_V1_ROOT);
  return results;
}

/**
 * The flow routes outside `/api/v1` that a native client needs to reach it -- hand-listed
 * because they live outside the `/api/v1` tree this test otherwise discovers by walking the
 * filesystem. See the design spec's Goal section for why these are in scope and nothing else
 * outside `/api/v1` is. (`POST /api/v1/auth/webview-session-token` is the third flow route the
 * design spec names, but its path already lives under `src/app/api/v1/**`, so
 * `discoverApiV1Routes()` above finds it without help -- listing it here too would just be a
 * duplicate.)
 */
const FLOW_ROUTES: Array<{ method: string; path: string; file: string }> = [
  { method: "GET", path: "/device/pair", file: "src/app/device/pair/route.ts" },
  { method: "GET", path: "/webview-session", file: "src/app/webview-session/route.ts" },
];

/**
 * Routes deliberately NOT documented in ENDPOINT_REGISTRY, with a reason each. Currently
 * empty -- `openapi.json/route.ts` looked like a candidate (it's arguably meta rather than
 * client-API surface) but was added to the registry instead of excluded here, since it's a
 * real, reachable `/api/v1` route with no reason to hide it from the document it itself serves.
 */
const EXCLUDED_PATHS = new Set<string>([]);

const EXPECTED = [...discoverApiV1Routes(), ...FLOW_ROUTES].filter(
  (e) => !EXCLUDED_PATHS.has(`${e.method} ${e.path}`),
);

describe("ENDPOINT_REGISTRY completeness", () => {
  it("discovered at least the routes this test previously hand-listed", () => {
    // A floor, not an exact count -- guards against the walk silently finding nothing (e.g.
    // a wrong root path) rather than pinning an exact number that has to be updated by hand
    // every time a route is added, which is the exact problem this fix exists to remove.
    expect(EXPECTED.length).toBeGreaterThanOrEqual(16);
  });

  it("has a defineEndpoint() entry for every discovered (method, path) pair", () => {
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
