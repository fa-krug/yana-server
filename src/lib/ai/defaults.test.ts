import { describe, expect, it } from "vitest";

import { freshDatabase } from "@/lib/db/test-support";

import { AI_COLUMNS } from "./columns";
import { AI_PROVIDERS, OPENAI_DEFAULT_API_URL, providerByKey } from "./providers";

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
    expect([row.openai_enabled, row.anthropic_enabled, row.gemini_enabled]).toEqual([0, 0, 0]);
  });
});
