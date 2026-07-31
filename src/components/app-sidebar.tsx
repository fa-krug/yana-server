"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { NAV_ITEMS } from "@/lib/nav";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

export function AppSidebar({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const t = useTranslations();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link href="/" className="px-2 py-1 font-semibold">
          Yana
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin).map((item) => (
              <SidebarMenuItem key={item.href}>
                {/* This sidebar is on Base UI's render prop, not Radix's asChild --
                    the target element goes in `render`, contents stay as children. */}
                <SidebarMenuButton
                  render={<Link href={item.href} />}
                  isActive={item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)}
                >
                  <item.icon />
                  <span>{t(item.labelKey)}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      {/* The profile button lands here in phase 4. */}
      <SidebarFooter />
    </Sidebar>
  );
}
