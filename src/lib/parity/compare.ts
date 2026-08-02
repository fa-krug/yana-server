import fs from "node:fs";
import path from "node:path";
import { plainTextOf } from "../aggregators/blocks/parser";
import { decodeDocument, WireDocument } from "../aggregators/blocks/schema";
import { normalizeDocument } from "./normalize";

export interface GoldenCase {
  id: string;
  aggregator: string;
  sourceUrl: string;
  fixture: string;
  options: Record<string, unknown>;
  identifier: string;
}

export interface GoldenArticle {
  name?: string;
  title?: string;
  identifier: string;
  author: string;
  date: string | null;
  plainText: string;
}

export interface GoldenImageEntry {
  key?: string;
  sourceUrl?: string;
  contentType: string;
  width: number | null;
  height: number | null;
  byteSize: number;
  contentHash?: string;
}

export interface GoldenRecord {
  parityVersion?: number;
  caseId?: string;
  aggregator?: string;
  fixture?: string;
  options?: Record<string, unknown>;
  article: GoldenArticle;
  document: WireDocument;
  images: GoldenImageEntry[];
}

export interface ActualArticle {
  title?: string;
  name?: string;
  identifier: string;
  author: string;
  date: string | Date | null;
  plainText: string;
}

export interface ActualImageEntry {
  key?: string;
  sourceUrl?: string;
  contentType: string;
  width: number | null;
  height: number | null;
  byteSize: number;
  contentHash?: string;
}

export interface ActualResult {
  article: ActualArticle;
  document: WireDocument;
  images: ActualImageEntry[];
}

export interface CompareResult {
  ok: boolean;
  diff?: string;
}

/**
 * Loads golden parity cases from `parity/cases.json`.
 */
export function loadCases(casesPath?: string): GoldenCase[] {
  const file = casesPath || path.resolve(process.cwd(), "parity/cases.json");
  if (!fs.existsSync(file)) {
    throw new Error(`cases.json not found at ${file}`);
  }
  const content = fs.readFileSync(file, "utf-8");
  const parsed = JSON.parse(content);
  return parsed.cases as GoldenCase[];
}

/**
 * Loads golden record for a given case ID or GoldenCase object.
 */
export function loadGoldenRecord(caseIdOrCase: string | GoldenCase, desiredDir?: string): GoldenRecord {
  const c =
    typeof caseIdOrCase === "string"
      ? loadCases().find((item) => item.id === caseIdOrCase)
      : caseIdOrCase;
  if (!c) {
    throw new Error(`Case not found: ${caseIdOrCase}`);
  }
  const desiredFilename = c.aggregator === "rss" ? "feed_content.json" : `${c.aggregator}.json`;
  const dir = desiredDir || path.resolve(process.cwd(), "parity/fixtures/desired");
  const goldenPath = path.join(dir, desiredFilename);
  if (!fs.existsSync(goldenPath)) {
    throw new Error(`Golden record file not found at ${goldenPath}`);
  }
  const content = fs.readFileSync(goldenPath, "utf-8");
  const record = JSON.parse(content) as GoldenRecord;
  if (record.article && !record.article.plainText) {
    const blocks = decodeDocument(record.document);
    record.article.plainText = plainTextOf(blocks);
  }
  return record;
}

function buildHashToUrlMap(
  images: Array<{ contentHash?: string; key?: string; sourceUrl?: string }>,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const img of images) {
    if (img.sourceUrl) {
      if (img.contentHash) map[img.contentHash] = img.sourceUrl;
      if (img.key) map[img.key] = img.sourceUrl;
    }
  }
  return map;
}

function findDeepDiff(actual: unknown, expected: unknown, currentPath = "$"): string | null {
  if (actual === expected) return null;

  if (typeof actual !== typeof expected) {
    return `Mismatch at ${currentPath}: expected type ${typeof expected} (${JSON.stringify(
      expected,
    )}), got type ${typeof actual} (${JSON.stringify(actual)})`;
  }

  if (actual === null || expected === null || typeof actual !== "object") {
    return `Mismatch at ${currentPath}: expected ${JSON.stringify(
      expected,
    )}, got ${JSON.stringify(actual)}`;
  }

  const isActualArray = Array.isArray(actual);
  const isExpectedArray = Array.isArray(expected);

  if (isActualArray !== isExpectedArray) {
    return `Mismatch at ${currentPath}: expected ${
      isExpectedArray ? "array" : "object"
    }, got ${isActualArray ? "array" : "object"}`;
  }

  if (isActualArray && isExpectedArray) {
    const actArr = actual as unknown[];
    const expArr = expected as unknown[];
    if (actArr.length !== expArr.length) {
      return `Mismatch at ${currentPath}.length: expected ${expArr.length}, got ${actArr.length}`;
    }
    for (let i = 0; i < expArr.length; i++) {
      const diff = findDeepDiff(actArr[i], expArr[i], `${currentPath}[${i}]`);
      if (diff) return diff;
    }
    return null;
  }

  const actObj = actual as Record<string, unknown>;
  const expObj = expected as Record<string, unknown>;

  const expKeys = Object.keys(expObj);
  const actKeys = Object.keys(actObj);

  for (const key of expKeys) {
    if (!(key in actObj)) {
      return `Mismatch at ${currentPath}: missing key "${key}" (expected ${JSON.stringify(
        expObj[key],
      )})`;
    }
    const diff = findDeepDiff(actObj[key], expObj[key], `${currentPath}.${key}`);
    if (diff) return diff;
  }

  for (const key of actKeys) {
    if (!(key in expObj)) {
      return `Mismatch at ${currentPath}: unexpected extra key "${key}" (${JSON.stringify(
        actObj[key],
      )})`;
    }
  }

  return null;
}

function formatDate(d: string | Date | null | undefined): string | null {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString();
  return d;
}

/**
 * Asserts parity between golden record (or caseId) and actual extraction result:
 * 1. Normalized block tree deep-equal.
 * 2. Article metadata (title, identifier, author, date, plainText) exact match.
 * 3. Image manifest (contentType, width, height) exact match and byteSize within ±25%.
 * 4. Image contentHash is NOT compared.
 */
export function compareToGolden(
  goldenOrCaseId: string | GoldenRecord,
  actual: ActualResult,
): CompareResult {
  const golden =
    typeof goldenOrCaseId === "string"
      ? loadGoldenRecord(goldenOrCaseId)
      : goldenOrCaseId;
  // 1. Check article metadata
  const goldenTitle = golden.article.title ?? golden.article.name ?? "";
  const actualTitle = actual.article.title ?? actual.article.name ?? "";
  if (actualTitle !== goldenTitle) {
    return {
      ok: false,
      diff: `Article title mismatch: expected "${goldenTitle}", got "${actualTitle}"`,
    };
  }

  if (actual.article.identifier !== golden.article.identifier) {
    return {
      ok: false,
      diff: `Article identifier mismatch: expected "${golden.article.identifier}", got "${actual.article.identifier}"`,
    };
  }

  if (actual.article.author !== golden.article.author) {
    return {
      ok: false,
      diff: `Article author mismatch: expected "${golden.article.author}", got "${actual.article.author}"`,
    };
  }

  const goldenDate = formatDate(golden.article.date);
  const actualDate = formatDate(actual.article.date);
  if (actualDate !== goldenDate) {
    return {
      ok: false,
      diff: `Article date mismatch: expected "${goldenDate}", got "${actualDate}"`,
    };
  }

  if (actual.article.plainText !== golden.article.plainText) {
    return {
      ok: false,
      diff: `Article plainText mismatch: expected ${JSON.stringify(
        golden.article.plainText,
      )}, got ${JSON.stringify(actual.article.plainText)}`,
    };
  }

  // 2. Check block tree after normalization
  const goldenMap = buildHashToUrlMap(golden.images || []);
  const actualMap = buildHashToUrlMap(actual.images || []);

  const { document: normGoldenDoc } = normalizeDocument(golden.document, goldenMap);
  const { document: normActualDoc } = normalizeDocument(actual.document, actualMap);

  const blockDiff = findDeepDiff(normActualDoc, normGoldenDoc, "$.document");
  if (blockDiff) {
    return {
      ok: false,
      diff: blockDiff,
    };
  }

  // 3. Check image manifest
  const goldenImgs = golden.images || [];
  const actualImgs = actual.images || [];

  if (actualImgs.length !== goldenImgs.length) {
    return {
      ok: false,
      diff: `Image count mismatch: expected ${goldenImgs.length}, got ${actualImgs.length}`,
    };
  }

  for (let i = 0; i < goldenImgs.length; i++) {
    const g = goldenImgs[i];
    const a = actualImgs[i];

    if (a.contentType !== g.contentType) {
      return {
        ok: false,
        diff: `Image[${i}] contentType mismatch: expected "${g.contentType}", got "${a.contentType}"`,
      };
    }

    if (a.width !== g.width) {
      return {
        ok: false,
        diff: `Image[${i}] width mismatch: expected ${g.width}, got ${a.width}`,
      };
    }

    if (a.height !== g.height) {
      return {
        ok: false,
        diff: `Image[${i}] height mismatch: expected ${g.height}, got ${a.height}`,
      };
    }

    const minSize = 0.75 * g.byteSize;
    const maxSize = 1.25 * g.byteSize;
    if (a.byteSize < minSize || a.byteSize > maxSize) {
      return {
        ok: false,
        diff: `Image[${i}] byteSize ${a.byteSize} outside ±25% of golden byteSize ${g.byteSize} (allowed: [${minSize}, ${maxSize}])`,
      };
    }
  }

  return { ok: true };
}
