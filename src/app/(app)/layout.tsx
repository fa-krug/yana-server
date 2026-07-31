import { AppSidebar } from "@/components/app-sidebar";
import { RouteBreadcrumbs } from "@/components/route-breadcrumbs";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { isAdminRole } from "@/lib/auth/roles";
import { requireUser } from "@/lib/auth/session";

/**
 * Chrome, plus the one await the chrome itself depends on.
 *
 * `requireUser()` is the gate for every route in this group: `src/proxy.ts` only
 * saw that *a* session cookie existed, and this is where it is actually
 * validated -- an expired, revoked or forged cookie is redirected to /login from
 * here. It is also the last place that redirect can happen before a page starts
 * streaming, since a `redirect()` thrown after the first byte has flushed cannot
 * change the response.
 *
 * The "nothing above the Suspense boundaries may await" rule still holds for
 * *data*: this is a cookie read that usually resolves out of the session cookie
 * cache without touching the database at all (see `currentUser()`), and the
 * sidebar cannot render before it, because which items it contains depends on
 * the answer.
 *
 * The admin flag is derived here rather than pushed into the component:
 * `AppSidebar` keeps the `isAdmin: boolean` prop phase 3 gave it, so it stays a
 * client component that knows nothing about sessions or roles.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  return (
    <SidebarProvider>
      <AppSidebar isAdmin={isAdminRole(user.role)} />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:px-4">
          <SidebarTrigger />
          <RouteBreadcrumbs />
        </header>
        {/* A <div>, deliberately not a <main>: SidebarInset already renders the
            <main> landmark (see src/components/ui/sidebar.tsx), and nesting a
            second one is non-conforming HTML that hands assistive tech two
            "main" regions to choose between. It produces no hydration warning
            and no lint error, so nothing catches it automatically. The padding
            lives here rather than on SidebarInset's className because the
            header above must stay flush with the border. */}
        <div className="flex-1 p-3 md:p-6">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
