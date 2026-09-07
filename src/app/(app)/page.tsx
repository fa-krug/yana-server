import { connection } from "next/server";

import { RecentArticles } from "@/components/dashboard/recent-articles";
import { SectionCardsGate } from "@/components/dashboard/section-cards";
import { StatCards } from "@/components/dashboard/stat-cards";
import { isAdminRole } from "@/lib/auth/roles";
import { requireUserFreshRole } from "@/lib/auth/session";
import { getDashboardStats, getRecentUnreadArticles } from "@/lib/dashboard/queries";

/**
 * The dashboard: an overview of the signed-in user's library, at `/`.
 *
 * The instant-render-no-fallback migration (see `src/app/(app)/settings/page.tsx`):
 * this page body now awaits nothing, so it cannot suspend and `loading.tsx` --
 * deleted along with this rewrite -- is unreachable.
 *
 * `connection()` is called but **not awaited** -- calling it is what
 * interrupts static generation (it throws synchronously during `next build`,
 * whether or not anything awaits the result), which is what still keeps
 * `rm -rf data/ && npm run build` from baking this page against a `data/`
 * directory that does not exist yet. At real request time it resolves to
 * `undefined` and is never observed. See `SettingsPage`'s identical comment
 * for the full reasoning; the `cacheComponents` caveat itself lives in
 * CLAUDE.md's `connection()` bullet, which that comment points to.
 *
 * There is no `<h1>` here: the breadcrumb already names the page, so the
 * per-page heading was removed everywhere (along with the `await
 * getTranslations()` that once produced it).
 *
 * `getDashboardStats()` and `getRecentUnreadArticles()` are **not** awaited
 * here, same as before this migration -- each is handed straight to its own
 * `<StatCards>`/`<RecentArticles>`, whose own internal `<Suspense>` shows the
 * real card frame in its pending state.
 *
 * `requireUserFreshRole()` is likewise not awaited any more. It used to be
 * awaited here and then reduced to `isAdmin` synchronously; now the whole
 * thing -- read plus reduction -- is one unawaited `.then()` chain, and only
 * the resulting `Promise<boolean>` is handed to `<SectionCardsGate>`. That
 * narrowing happens **here**, before the promise crosses to that Client
 * Component -- never inside it -- for the same reason `getSettingsSummary()`
 * narrows before `/settings` hands its promise down: a promise's declared
 * type is not what gets serialized, its resolved *value* is, so handing a
 * `Promise<User>` across and only reading `.role` on the other side would
 * still serialize the whole row (email, ban fields, timestamps) into the
 * page's flight payload. `isAdminRole()` (not a raw `=== "admin"`) is the one
 * function everything else in this codebase agrees on for that check.
 *
 * This is still deliberately not `requireUser()` + a role check on its own
 * result: an admin demoted a moment ago must not keep seeing admin-only
 * cards off a stale, cookie-cached role. `requireUserFreshRole()` reads with
 * `disableCookieCache: true` and nothing here wraps it in `cache()` --
 * caching it would silently reintroduce the five-minutes-stale-admin bug it
 * exists to close.
 */
export default function DashboardPage() {
  connection();

  const stats = getDashboardStats();
  const recentArticles = getRecentUnreadArticles();
  const isAdmin = requireUserFreshRole().then((user) => isAdminRole(user.role));

  return (
    <div className="space-y-6">
      <StatCards promise={stats} />

      <RecentArticles promise={recentArticles} />

      <SectionCardsGate promise={isAdmin} />
    </div>
  );
}
