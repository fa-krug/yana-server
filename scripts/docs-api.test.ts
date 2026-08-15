import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const OUTPUT_PATH = path.resolve(__dirname, "../docs/api/openapi.json");

describe("docs-api --check", () => {
  it("exits 0 against the currently-committed, up-to-date file", () => {
    expect(() =>
      execFileSync("npx", ["tsx", "scripts/docs-api.ts", "--check"], {
        cwd: path.resolve(__dirname, ".."),
        stdio: "pipe",
      }),
    ).not.toThrow();
  });

  it("exits non-zero when the committed file is stale", () => {
    const original = fs.readFileSync(OUTPUT_PATH, "utf8");
    fs.writeFileSync(OUTPUT_PATH, original.replace('"openapi": "3.1.0"', '"openapi": "0.0.0"'));
    try {
      expect(() =>
        execFileSync("npx", ["tsx", "scripts/docs-api.ts", "--check"], {
          cwd: path.resolve(__dirname, ".."),
          stdio: "pipe",
        }),
      ).toThrow();
    } finally {
      fs.writeFileSync(OUTPUT_PATH, original);
    }
  });
});
