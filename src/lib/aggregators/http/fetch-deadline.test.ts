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
 * **Two limits, stated so this test is not read as more than it is.** It
 * checks the *presence of the token*, not a real deadline:
 * `signal: new AbortController().signal` with nothing ever aborting it
 * satisfies it, and no textual check can tell otherwise. And
 * `withDeadline()`'s guarantee reaches only the callers that use it -- the
 * four this task converted. `fetchHtml()`, `fetchBinary()` and
 * `fetchImageOutcome()` still hand-roll a controller and a timer, and they are
 * precisely the three sites that already made the placement mistake once, so
 * for them the structural half is not in force and 7d/7e's `finally` blocks
 * are all that hold it.
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
 * The two shapes seen in this tree are both honest: `AbortSignal.timeout(...)`,
 * which is never disarmed and so covers the body by construction, and a signal
 * handed down by `withDeadline()`.
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

/**
 * Every `fetch(...)` call site in `source`, as "label:line" plus its argument
 * text.
 *
 * **The argument text is sliced from `scanned`, not from `source`, and that one
 * word is the whole guard.** Slicing the original meant the bare token
 * `signal` anywhere inside the init satisfied the check -- in a string, or in a
 * comment. The realistic form is the dangerous one: someone adding a
 * deliberately unsignalled fetch writes `// no signal needed, fixed host`
 * inside the object and this test goes green. A check defeatable by a comment
 * is worse than no check, because it licenses the belief that the class is
 * closed. The negative controls at the bottom of this file are what keep the
 * slice honest.
 */
function fetchCallSitesIn(source: string, label: string): { where: string; args: string }[] {
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
    const args = scanned.slice(open + 1, close);
    if (!args.trim()) continue; // a bare `fetch()` mention, not a call
    const line = source.slice(0, open).split("\n").length;
    sites.push({ where: `${label}:${line}`, args });
  }
  return sites;
}

function fetchCallSites(file: string): { where: string; args: string }[] {
  return fetchCallSitesIn(readFileSync(file, "utf8"), path.relative(process.cwd(), file));
}

function hasNoSignal(site: { args: string }): boolean {
  return !/\bsignal\b/.test(site.args);
}

/** The `path:line` of every call site in `source` whose init passes no signal. */
function undeadlinedIn(source: string, label: string): string[] {
  return fetchCallSitesIn(source, label)
    .filter(hasNoSignal)
    .map((site) => site.where);
}

describe("every fetch() in the aggregator tree carries a deadline", () => {
  it("finds the call sites at all, so a silent zero cannot pass", () => {
    const sites = tsFilesUnder(AGGREGATORS_DIR).flatMap(fetchCallSites);
    // Sixteen at the time of writing (seventeen call sites, one of which is
    // in this scan's excluded test-support). A floor rather than an exact
    // count, so a new bounded fetch need not edit this test.
    //
    // A drop below it means *look*, not necessarily "the scanner broke":
    // consolidating the five `sites/reddit/` fetches behind one helper would
    // reduce the count perfectly legitimately. What the floor actually rules
    // out is the failure mode that would otherwise read as green -- a scanner
    // that matches nothing at all, which is what a mis-lexed new syntax would
    // produce.
    expect(sites.length).toBeGreaterThanOrEqual(16);
  });

  it("passes a signal at every one of them", () => {
    const undeadlined = tsFilesUnder(AGGREGATORS_DIR).flatMap(fetchCallSites).filter(hasNoSignal);

    expect(undeadlined.map((site) => site.where)).toEqual([]);
  });

  /**
   * Negative controls, against inline fixtures rather than a probe file left in
   * the tree.
   *
   * A tripwire nobody has watched fail is a tripwire nobody knows works, and
   * this one was defeatable in exactly the way that matters: it tested the
   * argument text taken from the *original* source, so the bare word `signal`
   * in a comment or a string satisfied it. The first two cases below are the
   * demonstration; the third is the one someone would really write.
   */
  describe("and is not satisfied by the word alone", () => {
    it("reports a fetch whose init has no signal", () => {
      const fixture = `const res = await fetch("https://example.com/x", { headers: {} });`;
      expect(undeadlinedIn(fixture, "fixture.ts")).toEqual(["fixture.ts:1"]);
    });

    it("reports one whose init mentions signal only in a string", () => {
      const fixture =
        `const res = await fetch("https://example.com/x", ` +
        `{ headers: { "x-note": "signal" } });`;
      expect(undeadlinedIn(fixture, "fixture.ts")).toEqual(["fixture.ts:1"]);
    });

    it("reports one whose init mentions signal only in a comment", () => {
      // The realistic form: a deliberately unsignalled fetch, explained in
      // place. Read off the raw source, this comment is what turned the check
      // green.
      const fixture = [
        `const res = await fetch("https://example.com/x", {`,
        `  // no signal needed, fixed host`,
        `  headers: {},`,
        `});`,
      ].join("\n");
      expect(undeadlinedIn(fixture, "fixture.ts")).toEqual(["fixture.ts:1"]);
    });

    it("accepts a real signal, so the controls are not vacuous", () => {
      const fixture =
        `const res = await fetch("https://example.com/x", ` +
        `{ signal: AbortSignal.timeout(1000) });`;
      expect(undeadlinedIn(fixture, "fixture.ts")).toEqual([]);
    });
  });
});
