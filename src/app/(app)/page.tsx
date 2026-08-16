import { connection } from "next/server";
import { getTranslations } from "next-intl/server";

import { RecentArticles } from "@/components/dashboard/recent-articles";
import { SectionCards } from "@/components/dashboard/section-cards";
import { StatCards } from "@/components/dashboard/stat-cards";
import { isAdminRole } from "@/lib/auth/roles";
import { requireUserFreshRole } from "@/lib/auth/session";
import { getDashboardStats, getRecentUnreadArticles } from "@/lib/dashboard/queries";

/**
 * The dashboard: an overview of the signed-in user's library, at `/`.
 *
 * `await connection()` is the first statement -- this route now reaches
 * SQLite (through the two data regions below), and without it a production
 * build would bake the page against a `data/` directory that does not exist
 * at build time. See the `connection()` bullet in CLAUDE.md.
 *
 * The heading and `<SectionCards>` need no data and render synchronously.
 * `getDashboardStats()` and `getRecentUnreadArticles()` are **not** awaited
 * here -- each is handed straight to its own `<StatCards>`/`<RecentArticles>`,
 * whose own internal `<Suspense>` shows the real card frame in its pending
 * state (see those components' doc comments) rather than this page rendering
 * a whole-card skeleton in its place. A slow query in one never
 * blocks the other, and the `(app)` group's `error.tsx` is the error boundary
 * above both -- no second one is added here.
 *
 * `isAdmin` is derived from `requireUserFreshRole()` here, called again --
 * uncached -- inside `getDashboardStats()` and `getRecentUnreadArticles()`.
 * `requireUserFreshRole()` is deliberately not `cache()`d (unlike
 * `currentUser()`/`currentUserRow()`): it reads with
 * `disableCookieCache: true`, so wrapping it would risk quietly reintroducing
 * a five-minute-stale role for its other callers (`/jobs`, `/jobs/[id]`, the
 * log-stream route). Three fresh session reads per render is the accepted
 * cost of that. This is deliberately not `requireUser()` + a role check on
 * its own result: an admin demoted a moment ago must not keep seeing
 * admin-only cards off a stale cookie-cached role, the same reason
 * `getDashboardStats()` itself reads the role this way.
 */
export default async function DashboardPage() {
  await connection();

  const user = await requireUserFreshRole();
  const isAdmin = isAdminRole(user.role);
  const t = await getTranslations("dashboard");

  const stats = getDashboardStats();
  const recentArticles = getRecentUnreadArticles();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      <StatCards promise={stats} />

      <RecentArticles promise={recentArticles} />

      <SectionCards isAdmin={isAdmin} />
    </div>
  );
}
