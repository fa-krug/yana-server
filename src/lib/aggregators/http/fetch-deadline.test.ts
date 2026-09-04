import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A tripwire over every `fetch()` in the aggregator tree.
 *
 * **Why this exists rather than a fourth hand-fix.** This review has now
 * closed the same "several call sites must each remember the same precaution"
 * defect by hand three times, and on the third pass two of the four offending
 * sites turned out to have carried no deadline *at all* -- not a misplaced
 * `clearTimeout`, simply no signal. Nothing failed, because nothing was
 * looking. `withDeadline()` makes the *placement* half structural (a caller
 * that never holds the timer cannot disarm it early); this makes the
 * *presence* half checked.
 *
 * **Why it asserts the deadline and not the size cap.** The deadline is
 * mechanically decidable: it is a property of the `fetch()` call's own init
 * object, which this test reads. A size cap is not -- the read that needs
 * capping can be any number of lines away, behind a helper, or absent because
 * the body is legitimately discarded -- so a regex asserting it would either
 * pass on a file where only one of two fetches is capped, or fail on correct
 * code. That half stays a review obligation, stated in `readCapped()`'s doc
 * comment. The deadline is also the half with the catastrophic failure mode:
 * an uncapped body costs memory, where an undeadlined one holds a worker loop
 * forever -- `worker.ts`'s budget timer only requests cooperative cancellation
 * and has no checkpoint inside a fetch, so `WORKER_CONCURRENCY` (4) such feeds
 * deadlock every background job with no way back.
 *
 * A `signal` satisfying this can be either shape, because both are honest:
 * `AbortSignal.timeout(...)`, which is never disarmed and so covers the body
 * by construction, or a signal handed down by `withDeadline()`.
 */
const AGGREGATORS_DIR = path.join(process.cwd(), "src/lib/aggregators");

/**
 * True when a `/` at `at` opens a regex literal rather than a division -- the
 * usual "what came before it" heuristic.
 */
function regexCanStartHere(source: string, at: number): boolean {
  for (let k = at - 1; k >= 0; k--) {
    const ch = source[k];
    if (/\s/.test(ch)) continue;
    return "(,=:[!&|?{};+-*%~^".includes(ch);
  }
  return true;
}

/**
 * Blank out comments, string/template bodies and regex literals, leaving
 * offsets intact so a match's line number stays correct.
 */
function blankCommentsAndStrings(source: string): string {
  const out = source.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    const ch0 = source[i];
    if (two === "//") {
      const end = source.indexOf("\n", i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch0 === "/" && two !== "/*" && regexCanStartHere(source, i)) {
      // A regex literal, not a division -- and it must be recognised, because
      // `.replace(/["']/g, "")` in ./fetcher.ts otherwise reads as the start
      // of a string literal and blanks the rest of the file, hiding that
      // module's own two fetches from this scan. It did.
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        else if (source[j] === "/" && !inClass) break;
        else if (source[j] === "\n") break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      blank(i, end === -1 ? source.length : end + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    const ch = ch0;
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === ch) break;
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join("");
}

function tsFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...tsFilesUnder(full));
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts") || entry === "test-support.ts") continue;
    found.push(full);
  }
  return found;
}

/** Every `fetch(...)` call site, as "path:line" plus its argument text. */
function fetchCallSites(file: string): { where: string; args: string }[] {
  const source = readFileSync(file, "utf8");
  const scanned = blankCommentsAndStrings(source);
  const sites: { where: string; args: string }[] = [];

  for (const match of scanned.matchAll(/\bfetch\(/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = open;
    for (let i = open; i < scanned.length; i++) {
      const ch = scanned[i];
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    const args = source.slice(open + 1, close);
    if (!args.trim()) continue; // a bare `fetch()` mention, not a call
    const line = source.slice(0, open).split("\n").length;
    sites.push({ where: `${path.relative(process.cwd(), file)}:${line}`, args });
  }
  return sites;
}

describe("every fetch() in the aggregator tree carries a deadline", () => {
  it("finds the call sites at all, so a silent zero cannot pass", () => {
    const sites = tsFilesUnder(AGGREGATORS_DIR).flatMap(fetchCallSites);
    // Sixteen at the time of writing. Asserted as a floor rather than an
    // exact count: a new bounded fetch should not have to edit this test,
    // but a scanner that quietly matches nothing must not read as green.
    expect(sites.length).toBeGreaterThanOrEqual(16);
  });

  it("passes a signal at every one of them", () => {
    const undeadlined = tsFilesUnder(AGGREGATORS_DIR)
      .flatMap(fetchCallSites)
      .filter((site) => !/\bsignal\b/.test(site.args))
      .map((site) => site.where);

    expect(undeadlined).toEqual([]);
  });
});
