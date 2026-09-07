"use client";

import { useTranslations } from "next-intl";

/**
 * What a detail route (`/articles/[id]`, `/feeds/[id]`, `/tags/[id]`,
 * `/users/[id]`, `/jobs/[id]`) renders once its record promise resolves to
 * `null` -- a missing id, someone else's row, or (for `/jobs/[id]`) an
 * ownerless job a non-admin may not see. See the instant-render-no-fallback
 * migration's design note (`src/app/(app)/settings/page.tsx`) for why these
 * routes no longer call `notFound()`: the record read moved out of the
 * awaited page body into a promise consumed with `use()`, so by the time an
 * empty result is known the response's 200 status has already been decided
 * -- `notFound()` here would only truncate the stream, not produce a 404.
 *
 * The copy is deliberately generic and identical for every reason a record
 * can be missing -- **"gone" and "not yours" must read the same**, the same
 * "every refusal is the same empty 404" principle CLAUDE.md states for the
 * avatar route and `requireAdmin()`. A message that distinguished "deleted"
 * from "not yours" would be an ownership oracle. `/jobs/[id]` depends on this
 * literally: `getJobForCurrentUser()` already collapses missing/unowned/
 * ownerless to the same `null`, and this component is what must not
 * reintroduce a distinction on top of it.
 *
 * `useTranslations("common")`, not a per-route namespace: the message never
 * varies by route, so one shared pair of catalog keys
 * (`recordNotFoundTitle`/`recordNotFoundDescription`) replaces what would
 * otherwise be five near-identical copies.
 */
export function RecordNotFound() {
  const t = useTranslations("common");

  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">{t("recordNotFoundTitle")}</h1>
      <p className="text-muted-foreground text-sm">{t("recordNotFoundDescription")}</p>
    </div>
  );
}
