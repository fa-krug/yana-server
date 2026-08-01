import { describe, expect, it } from "vitest";

import { userSettings } from "@/lib/db/schema";

import { providersWithColumns, resolveModel } from "./columns";
import { providerByKey } from "./providers";

describe("AI_COLUMNS", () => {
  it("names a real column for every provider", () => {
    // `TextColumn`/`FlagColumn` are derived from `userSettings.$inferInsert`, so
    // a renamed column already fails `npm run typecheck`. This covers the other
    // half: that the *runtime* table object really carries them, which is what a
    // query indexes.
    for (const { columns } of providersWithColumns()) {
      for (const column of [columns.enabled, columns.apiKey, columns.model, columns.apiUrl]) {
        if (column) expect(userSettings[column]).toBeDefined();
      }
    }
  });

  it("declares a base-URL column exactly where the registry says there is one", () => {
    // Two facts that must agree: `hasCustomUrl` decides whether the form shows a
    // field and whether the probe is handed a URL; the column decides whether
    // there is anywhere to put it. Disagreeing either way is a field that saves
    // nothing, or a column nothing ever writes.
    // Read through `providersWithColumns()`, which widens each entry to
    // `AiColumns`: `AI_COLUMNS.anthropic.apiUrl` is a *compile* error, which is
    // the stronger half of the same guarantee and the reason the record is
    // declared with `satisfies`.
    for (const { provider, columns } of providersWithColumns()) {
      expect(columns.apiUrl !== undefined).toBe(provider.hasCustomUrl);
    }
  });

  it("gives each provider its own columns", () => {
    // Every one of these is a `string` column, so a copy-paste slip between two
    // providers is not a type error -- it quietly shows one provider's mask under
    // another's heading and probes the wrong stored key.
    const named = providersWithColumns().flatMap(({ columns }) =>
      [columns.enabled, columns.apiKey, columns.model, columns.apiUrl].filter(Boolean),
    );
    expect(new Set(named).size).toBe(named.length);
  });
});

describe("resolveModel", () => {
  const openai = providerByKey("openai");

  it("keeps a model the provider still offers", () => {
    expect(openai && resolveModel(openai, openai.models[1].value)).toBe(openai?.models[1].value);
  });

  it("falls back to the default for an id the provider no longer offers", () => {
    // A row written before migration `0003` holds exactly this.
    expect(openai && resolveModel(openai, "gpt-4o-mini")).toBe(openai?.defaultModel);
  });

  it("falls back for an empty stored value", () => {
    expect(openai && resolveModel(openai, "")).toBe(openai?.defaultModel);
  });
});
