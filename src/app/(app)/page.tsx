import { connection } from "next/server";
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { CardSkeleton, CardSkeletonGroup } from "@/components/data-skeleton";
import { RecentArticles } from "@/components/dashboard/recent-articles";
import { SectionCards } from "@/components/dashboard/section-cards";
import { StatCards } from "@/components/dashboard/stat-cards";
import { isAdminRole } from "@/lib/auth/roles";
import { requireUserFreshRole } from "@/lib/auth/session";
import { getDashboardStats, getRecentUnreadArticles } from "@/lib/dashboard/queries";

async function DashboardStatCards() {
  const stats = await getDashboardStats();
  return <StatCards stats={stats} />;
}

async function DashboardRecentArticles() {
  const articles = await getRecentUnreadArticles();
  return <RecentArticles articles={articles} />;
}

/**
 * The dashboard: an overview of the signed-in user's library, at `/`.
 *
 * `await connection()` is the first statement -- this route now reaches
 * SQLite (through the two data regions below), and without it a production
 * build would bake the page against a `data/` directory that does not exist
 * at build time. See the `connection()` bullet in CLAUDE.md.
 *
 * The heading and `<SectionCards>` need no data and render synchronously; the
 * stats row and the recent-articles list are each an async component inside
 * its own `<Suspense>`, so a slow query in one never blocks the other. The
 * `(app)` group's `error.tsx` is the error boundary above both -- no second
 * one is added here.
 *
 * `isAdmin` comes from the same `requireUserFreshRole()` call
 * `getDashboardStats()` makes -- `cache()`d per request inside `session.ts`,
 * so reading it here is not a second database round trip. This is
 * deliberately not `requireUser()` + a role check on its own result: an admin
 * demoted a moment ago must not keep seeing admin-only cards off a stale
 * cookie-cached role, the same reason `getDashboardStats()` itself reads the
 * role this way.
 */
export default async function DashboardPage() {
  await connection();

  const user = await requireUserFreshRole();
  const isAdmin = isAdminRole(user.role);
  const t = await getTranslations("dashboard");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      <Suspense fallback={<CardSkeletonGroup count={5} />}>
        <DashboardStatCards />
      </Suspense>

      <Suspense fallback={<CardSkeleton />}>
        <DashboardRecentArticles />
      </Suspense>

      <SectionCards isAdmin={isAdmin} />
    </div>
  );
}
