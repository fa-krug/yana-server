import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { freshDatabase } from "@/lib/db/test-support";

import { AI_COLUMNS } from "./columns";
import { AI_PROVIDERS, OPENAI_DEFAULT_API_URL, providerByKey } from "./providers";

const ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * **The tripwire under a hand-maintained duplicate.**
 *
 * The AI column defaults in `src/lib/db/schema/users.ts` are written out as
 * literals rather than imported from `./providers`, for the reason given there:
 * a derived DDL default would change silently whenever a model list is
 * refreshed, and the migration that has to accompany it would be discovered by a
 * container booting against an out-of-date table rather than by CI. This is the
 * other half of that arrangement -- the same shape as the `better-sqlite3`
 * override and the `bodySizeLimit`/`AVATAR_MAX_BYTES` pair.
 *
 * It goes through a **real migrated database**, not through the Drizzle column
 * objects, and that distinction is the point: the schema literal and the DDL are
 * two different things, and only the DDL decides what a fresh account gets. A
 * refreshed registry with no accompanying migration fails here.
 *
 * Why it matters beyond tidiness: a stored model absent from its provider's list
 * makes Base UI's `<Select.Value>` print the raw id, because it resolves its
 * label from `items` alone (CLAUDE.md). `resolveModel()` absorbs that for rows
 * written before migration `0003`; this keeps the fallback from being needed on
 * every new account.
 */
describe("a freshly provisioned user_settings row", () => {
  /** The row SQLite fills in when only `user_id` is supplied. */
  function bareRow(): Record<string, unknown> {
    const connection = freshDatabase();
    try {
      connection.exec(`
        INSERT INTO users (id, email) VALUES ('u1', 'a@b.c');
        INSERT INTO user_settings (user_id) VALUES ('u1');
      `);
      return connection.prepare("SELECT * FROM user_settings WHERE user_id = 'u1'").get() as Record<
        string,
        unknown
      >;
    } finally {
      connection.close();
    }
  }

  it("starts each provider on a model its registry entry still offers", () => {
    const row = bareRow();
    for (const provider of AI_PROVIDERS) {
      const column = AI_COLUMNS[provider.key].model;
      // `snake_case` is the SQL name; the descriptor names the JS property.
      const stored = row[column.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)];
      expect(stored).toBe(provider.defaultModel);
      expect(provider.models.map((model) => model.value)).toContain(stored);
    }
  });

  it("carries none of the stale phase-2 model ids", () => {
    // What migration `0003` exists to fix. Named explicitly so a revert is loud.
    const row = bareRow();
    for (const stale of ["gpt-4o-mini", "claude-3-5-sonnet-20240620", "gemini-1.5-flash"]) {
      expect(Object.values(row)).not.toContain(stale);
    }
  });

  it("starts OpenAI on the same base URL its probe defaults to", () => {
    // Disagreeing would send a fresh account's probe somewhere other than the
    // endpoint the form shows it -- and the probe's own fallback would hide it.
    expect(bareRow().openai_api_url).toBe(OPENAI_DEFAULT_API_URL);
  });

  it("starts with AI switched off entirely", () => {
    const row = bareRow();
    expect(row.active_ai_provider).toBe("");
    for (const provider of AI_PROVIDERS) {
      expect(providerByKey(provider.key)).toBeDefined();
    }
    expect([
      row.openai_enabled,
      row.anthropic_enabled,
      row.gemini_enabled,
      row.mistral_enabled,
      row.qwen_enabled,
      row.deepseek_enabled,
      row.openrouter_enabled,
    ]).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("starts new providers on their correct default models", () => {
    const row = bareRow();
    expect(row.mistral_model).toBe("mistral-small-latest");
    expect(row.qwen_model).toBe("qwen3.5-flash");
    expect(row.deepseek_model).toBe("deepseek-v4-flash");
    expect(row.openrouter_model).toBe("openrouter/free");
  });
});

/**
 * **The tripwire under `run.ts`'s model resolution.**
 *
 * `run.ts` must resolve every stored model id through `resolveModel()` rather
 * than falling back to a hardcoded literal, for the same reason a fresh row's
 * default has to agree with `providers.ts`: a stored id absent from the
 * current registry (any row written before a registry refresh) must not reach
 * a provider verbatim. A hardcoded `?? "some-model-id"` tail defeats that --
 * it silently reintroduces a fixed fallback that drifts from `providers.ts`'s
 * `defaultModel` the next time a model list is refreshed, exactly as three of
 * the seven literals this test replaces already had (`gpt-4o-mini` vs.
 * `gpt-5.6-luna`, `claude-sonnet-4-20250514` vs. `claude-haiku-4-5`, and
 * `gemini-3-flash-preview` vs. `gemini-3.5-flash-lite` -- the last of which
 * `providers.ts` deliberately excludes from its registry as a withdrawn
 * preview id).
 *
 * A specifier-style source tripwire, in the shape `src/lib/avatar.test.ts`
 * pins its "imports nothing" rule with: read the real file's source (comments
 * stripped, so a literal *mentioned* in a doc comment cannot trip it) and
 * assert no quoted model-id literal survives in it. Without this, the next
 * person to add an eighth provider (or to bump one of the current seven
 * defaults) can reintroduce a hardcoded fallback and nothing else would catch
 * it -- `defaults.test.ts`'s other cases only ever look at a freshly
 * provisioned row, never at `run.ts`'s own fallback logic.
 */
describe("run.ts's model resolution has no hardcoded literal fallback", () => {
  it("contains no quoted vendor model-id literal", () => {
    const source = fs
      .readFileSync(path.join(ROOT, "src/lib/ai/run.ts"), "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

    // Widened past a plain `[-/]` separator so a vendor token followed
    // directly by a digit -- "qwen3.5-flash", with no separator at all --
    // still trips this, alongside every hyphen/slash-separated id.
    const modelLiteral = /"(gpt|claude|gemini|mistral|qwen|deepseek|openrouter)[-/\d][a-z0-9.-]*"/;

    expect(source).not.toMatch(modelLiteral);
  });
});
