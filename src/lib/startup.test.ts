import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveDataDir } from "./startup";

describe("resolveDataDir", () => {
  const origEnv = process.env.YANA_DATA_DIR;
  const tmpDir = path.join(os.tmpdir(), "yana-startup-test-" + Date.now());

  beforeEach(() => {
    delete process.env.YANA_DATA_DIR;
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.YANA_DATA_DIR = origEnv;
    } else {
      delete process.env.YANA_DATA_DIR;
    }
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("prioritizes explicit argument over env and default", () => {
    process.env.YANA_DATA_DIR = path.join(tmpDir, "env-dir");
    const explicit = path.join(tmpDir, "explicit-dir");
    const result = resolveDataDir(explicit);

    expect(result).toBe(path.resolve(explicit));
    expect(fs.existsSync(result)).toBe(true);
  });

  it("uses YANA_DATA_DIR env if explicit arg is absent", () => {
    const envDir = path.join(tmpDir, "env-dir");
    process.env.YANA_DATA_DIR = envDir;
    const result = resolveDataDir();

    expect(result).toBe(path.resolve(envDir));
    expect(fs.existsSync(result)).toBe(true);
  });

  it("defaults to ~/.yana if explicit arg and env are absent", () => {
    const defaultDir = path.resolve(os.homedir(), ".yana");
    const result = resolveDataDir();

    expect(result).toBe(defaultDir);
    expect(fs.existsSync(result)).toBe(true);
  });
});
