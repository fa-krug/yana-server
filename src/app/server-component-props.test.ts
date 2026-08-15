import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A Server Component may not pass a function to a Client Component.
 *
 * React has to serialize every prop that crosses the RSC boundary, and a
 * closure is not serializable (only a Server Action is). Rendering such a
 * subtree throws `Event handlers cannot be passed to Client Component props`
 * -- which, when the offending subtree is a `loading.tsx` or a
 * `<Suspense fallback>`, is a **cold-start-only** failure: the fallback is
 * only committed when the data read is slow enough to suspend, so a warm
 * reload renders the real section instead and the page looks fine. That is
 * exactly how `/ai`, `/account` and `/integrations` each shipped a
 * `onSubmit={(event) => event.preventDefault()}` no-op that replaced the
 * whole page with `(app)/error.tsx` on the first visit after a restart and
 * never again. `tsc` cannot see it (the shells declare `onSubmit` as a plain
 * callback), and no jsdom test can either, because testing-library renders
 * components directly and never runs the flight serializer.
 *
 * So this is a specifier-style tripwire over the source, in the spirit of the
 * "imports nothing at all" tests beside `src/lib/secrets.ts` and friends: no
 * file under `src/app/` that is *not* a Client Component may write an
 * `onFoo={...}` prop. The fix is always the same -- give the shell a default
 * no-op and omit the prop -- and it is what `youtube-section.tsx` and
 * `reddit-section.tsx` already do.
 */

const APP_DIR = join(process.cwd(), "src/app");

/** Every `.tsx` under `src/app/`, excluding tests. */
function appComponents(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return appComponents(path);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [path];
  });
}

/** `onClick={`, `onSubmit={`, ... -- a JSX prop whose name is an event handler. */
const HANDLER_PROP = /[\s{]on[A-Z][A-Za-z]*=\{/g;

describe("Server Components under src/app", () => {
  it("never pass an event handler to a Client Component", () => {
    const offenders: string[] = [];

    for (const path of appComponents(APP_DIR)) {
      const source = readFileSync(path, "utf8");
      // A Client Component may pass handlers freely -- it is one bundle, no
      // serialization boundary. `(app)/error.tsx` and `global-error.tsx` are
      // the only two, and both legitimately wire an onClick.
      if (/^\s*["']use client["']/m.test(source)) continue;

      for (const match of source.matchAll(HANDLER_PROP)) {
        offenders.push(`${relative(process.cwd(), path)}: ${match[0].trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
