import { getTranslations } from "next-intl/server";

import { RecentArticlesView } from "@/components/dashboard/recent-articles";
import { StatCardsView } from "@/components/dashboard/stat-cards";

/**
 * The dashboard route's (`/`) own fallback -- shown by Next while the RSC
 * payload for a **client-side soft navigation** into `/` is still in flight
 * over the network. That is real latency server-side streaming cannot
 * remove: `DashboardPage`'s own client components only help once the new
 * route's payload has already arrived, and `await getTranslations()` staying
 * in the page body means the page still suspends briefly on that
 * per-request-cached read even server-side.
 *
 * This file sits directly beside `page.tsx` at the top of the `(app)` group.
 * A `loading.js` wraps its own segment **and everything below it**, so the
 * nearest ancestor wins -- and every other route under this group now carries
 * its own: `/settings`, `/articles`, `/tags`, `/feeds`, `/integrations`,
 * `/ai`, `/users`, `/jobs` and `/account`, each of their `[id]` detail routes,
 * and (since this migration's Task 6) each of the three `/new` routes
 * (`/tags/new`, `/feeds/new`, `/users/new`), which used to fall through to
 * their parent segment's table fallback and show a feeds *table* while
 * loading a feeds *form*. `/api-docs` is a route handler, which `loading.tsx`
 * does not apply to at all. So this file is exclusively `/`'s fallback rather
 * than a shared generic one -- but it stays as the backstop a future segment
 * that forgets its own would land on, which is why it renders neutral
 * dashboard chrome and not a table.
 *
 * It renders the **real card chassis in its pending state** -- the same
 * `StatCardsView`/`RecentArticlesView` components `DashboardPage`'s own
 * `<Suspense>` fallbacks use, called with `pending` -- rather than a whole-card
 * skeleton standing in for each one. The heading, every stat card's
 * frame/icon/title and the recent-articles card's frame/heading are all on
 * screen from the very first frame of the navigation; only the numbers and
 * the article list stream in afterward.
 *
 * `<SectionCards>` is deliberately not rendered here: which items it
 * contains depends on `isAdmin`, itself derived from a fresh, uncached
 * session read (see `DashboardPage`'s doc comment) -- reading that here would
 * make this fallback pay for the very session check it exists to render
 * ahead of.
 */
export default async function Loading() {
  const t = await getTranslations("dashboard");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      <StatCardsView pending />

      <RecentArticlesView pending />
    </div>
  );
}
