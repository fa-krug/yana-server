import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");

function read(relative: string): string {
  return fs.readFileSync(path.join(ROOT, relative), "utf8");
}

/**
 * A source-level guard for a coupling nothing else catches.
 *
 * Webpack compiles this hook for the **edge** runtime too and follows its
 * imports regardless of the `NEXT_RUNTIME` check, so `next.config.ts` cuts the
 * one specifier it imports out of the edge layer with an `IgnorePlugin` regexp.
 * Rename `src/lib/startup.ts`, import it relatively, or add a second import
 * here, and that regexp silently stops matching: the edge compilation then
 * pulls in `node:fs` and `better-sqlite3`, fails, and **`next dev` answers 500
 * on every route**.
 *
 * Almost nothing we run would notice. `next build` provably never compiles the
 * edge instrumentation hook (it emits one only when edge routes exist, and this
 * app has none) and `npm start` does not either, so the image jobs are no help.
 * CI's dev-boot smoke step *would* catch it, by fetching a page from a real
 * `next dev` -- but a `npm test` failure names the coupling, where a 500 from a
 * curl names only the symptom, and this runs in a second rather than a minute.
 * Deliberately a source check rather than a bundler one: reading the emitted
 * edge chunk would mean running a build to test a build flag.
 */
describe("the instrumentation hook's bundler contract", () => {
  /** Every module specifier `src/instrumentation.ts` imports, static or dynamic. */
  function importedSpecifiers(): string[] {
    const source = read("src/instrumentation.ts").replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    return [
      ...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);
  }

  /** The `resourceRegExp` the edge `IgnorePlugin` in `next.config.ts` is built with. */
  function edgeIgnorePattern(): RegExp {
    const source = read("next.config.ts");
    const match = /IgnorePlugin\(\{\s*resourceRegExp:\s*\/(.+?)\/\s*\}\)/.exec(source);
    expect(match, "next.config.ts no longer registers an IgnorePlugin for the edge layer").not.toBe(
      null,
    );
    return new RegExp(match![1]);
  }

  it("imports exactly one module, and next.config.ts excludes that exact one", () => {
    const specifiers = importedSpecifiers();

    // Exactly one, not "at least one": a second import is the failure mode
    // here, and the whole point of `runStartupTasks()` being the seam.
    expect(specifiers).toHaveLength(1);
    expect(edgeIgnorePattern().test(specifiers[0])).toBe(true);
  });

  it("keeps dev and build on the same bundler", () => {
    // The IgnorePlugin lives in the webpack hook, which Turbopack ignores
    // outright. Dropping `--webpack` from one script and not the other would
    // mean the bundler that compiles the edge hook in dev is no longer the one
    // the fix is written for -- so pin them together and force whoever changes
    // it to re-verify `npm run dev` (not just the build) on purpose.
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> })
      .scripts;

    expect(scripts.dev.includes("--webpack")).toBe(scripts.build.includes("--webpack"));
  });
});

/**
 * The startup-failure contract: log, then kill the process. Exercised through
 * `register()` itself with a `DATABASE_PATH` that cannot be opened, so the
 * failure is a real one out of `getDb()` rather than an injected throw.
 *
 * Left to Next, a thrown `register()` leaves the standalone production server
 * *up*, answering 500 to everything -- measured, and the reason the old
 * docker-entrypoint.sh `exit 1` had to be restored somewhere.
 */
describe("register", () => {
  let exit: MockInstance<typeof process.exit>;
  let logged: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_RUNTIME = "nodejs";
    // A path under a *file*, so mkdirSync -> ENOTDIR: nothing can create it.
    process.env.DATABASE_PATH = "/dev/null/nope/yana.db";
    exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    logged = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exit.mockRestore();
    logged.mockRestore();
    delete process.env.NEXT_RUNTIME;
    delete process.env.DATABASE_PATH;
    vi.unstubAllEnvs();
  });

  it("logs and exits when startup fails", async () => {
    // The contract docker-entrypoint.sh used to provide with `set -e`: a
    // container that cannot migrate must die, not linger answering 500s while
    // `docker ps` calls it running.
    const { register } = await import("./instrumentation");

    await expect(register()).rejects.toThrow();

    expect(exit).toHaveBeenCalledWith(1);
    expect(logged).toHaveBeenCalled();
  });

  it("exits regardless of NODE_ENV", async () => {
    // No dev/production branch, deliberately: `next dev` already exits with
    // code 1 on a thrown register() (measured), so a branch claiming to keep
    // the dev server alive would describe behaviour that does not exist. This
    // pins the absence of that branch, since it is the kind of thing a later
    // reader "fixes".
    vi.stubEnv("NODE_ENV", "development");
    const { register } = await import("./instrumentation");

    await expect(register()).rejects.toThrow();

    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does nothing at all on the edge runtime", async () => {
    process.env.NEXT_RUNTIME = "edge";
    const { register } = await import("./instrumentation");

    await expect(register()).resolves.toBeUndefined();

    expect(exit).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
  });
});
