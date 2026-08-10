"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { SignOutButton } from "@/components/auth/sign-out-button";
import { UserAvatar } from "@/components/user-avatar";
import { type AvatarUser, displayNameFor } from "@/lib/avatar";
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
  useSidebar,
} from "@/components/ui/sidebar";

/**
 * `user` carries only what the footer renders -- the five columns `<UserAvatar>`
 * reads. Not the whole `User` row: `role`, the ban columns and the timestamps
 * would then be serialized into the RSC payload of every page for no reason,
 * and the (app) layout already derives `isAdmin` server-side precisely so that
 * this component knows nothing about roles.
 */
type SidebarUser = AvatarUser & { image: string | null };

export function AppSidebar({ isAdmin, user }: { isAdmin: boolean; user: SidebarUser }) {
  const pathname = usePathname();
  const t = useTranslations();
  const { setOpenMobile } = useSidebar();
  const closeMobileSidebar = () => setOpenMobile(false);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link href="/" className="px-2 py-1 font-semibold" onClick={closeMobileSidebar}>
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
                  render={<Link href={item.href} onClick={closeMobileSidebar} />}
                  isActive={pathname.startsWith(item.href)}
                >
                  <item.icon />
                  <span>{t(item.labelKey)}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* `size="lg"` gives the 40px row the avatar needs, and collapses
                to a square in icon mode -- where the sidebar's own
                `group-data-[collapsible=icon]` rules hide the <span> and leave
                the avatar alone, which is what the brief asks for. The
                `render` prop is Base UI's; Radix's `asChild` does not exist
                here. */}
            <SidebarMenuButton
              size="lg"
              render={<Link href="/account" onClick={closeMobileSidebar} />}
              isActive={pathname.startsWith("/account")}
              tooltip={displayNameFor(user)}
            >
              <UserAvatar user={user} />
              <span className="truncate">{displayNameFor(user)}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/* Directly under the identity it ends. Sessions last 30 days, so a
              way out is not optional; the footer is the only chrome on every
              route, which is why it is here and not on /account. */}
          <SidebarMenuItem>
            <SignOutButton />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
