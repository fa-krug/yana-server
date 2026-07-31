import { AppSidebar } from "@/components/app-sidebar";
import { RouteBreadcrumbs } from "@/components/route-breadcrumbs";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";

/**
 * Chrome only. Nothing here awaits data -- an await above the Suspense
 * boundaries would block the route's first byte, which is exactly what the
 * skeleton-then-data requirement exists to prevent.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider>
      {/* isAdmin is hardcoded until phase 4 supplies a session. */}
      <AppSidebar isAdmin />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:px-4">
          <SidebarTrigger />
          <RouteBreadcrumbs />
        </header>
        <main className="flex-1 p-3 md:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
