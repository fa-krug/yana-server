# Phase 3: App Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mobile-first shell — sidebar left, content right, breadcrumbs on top — that renders instantly with skeleton placeholders while data streams in, plus a toast system, EN/DE localization, and a settings page with general, library and about sections.

**Architecture:** The layout is a server component that renders chrome synchronously and wraps every data region in `<Suspense>` with a skeleton fallback. That is what "load the chrome directly, then data asynchronously" means in App Router terms: streaming SSR, not client-side fetching after mount. Breadcrumbs derive from the URL's route segments, so a new page gets correct breadcrumbs by existing at the right path rather than by registering anything. Settings persist to the bootstrap user's `userSettings` row; phase 4 swaps that id for the session's.

**Tech Stack:** Next.js App Router (RSC + Suspense streaming), shadcn/ui sidebar + breadcrumb + skeleton, `sonner`, `next-intl`, `next-themes`.

## Global Constraints

- **Mobile-first.** Every layout rule starts at the smallest breakpoint; `sm:`/`md:`/`lg:` only widen. A layout written desktop-first and patched with `max-` queries is a defect.
- **Chrome never waits on data.** No `await` of a data call above a `<Suspense>` boundary in a layout or page shell. Violating this blocks the whole route's first byte, which is the exact failure this phase exists to prevent.
- Every subpage is reflected in **both** the URL and the breadcrumbs. A view reachable only through client state is a defect.
- Languages are **English and German only**. Every user-facing string comes from a message catalog — no literals in components.
- Theme is `light` | `dark` | `system`, persisted per user and applied without a flash of wrong theme on first paint.
- Settings write through a server action, not a client-side fetch.
- All settings queries scope to `BOOTSTRAP_USER_ID` from phase 2. Phase 4 replaces that single import; nothing else changes.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/app/layout.tsx` | Root: providers, theme, locale, `<Toaster>` |
| `src/app/(app)/layout.tsx` | Sidebar + content frame + breadcrumb slot |
| `src/app/(app)/page.tsx` | Dashboard placeholder |
| `src/app/(app)/settings/page.tsx` | Settings, three sections |
| `src/app/health/route.ts` | Health check |
| `src/components/app-sidebar.tsx` | Navigation |
| `src/components/route-breadcrumbs.tsx` | Segment-derived breadcrumbs |
| `src/components/theme-provider.tsx` | `next-themes` wrapper |
| `src/lib/nav.ts` | Route→label registry; the single source for nav *and* breadcrumbs |
| `src/lib/settings/actions.ts` | `updateGeneralSettings`, `updateLibrarySettings` server actions |
| `src/lib/settings/queries.ts` | `getSettings()` |
| `src/i18n/request.ts`, `src/i18n/routing.ts` | next-intl config |
| `messages/en.json`, `messages/de.json` | Catalogs |

---

### Task 1: Localization and theme foundations

**Files:**
- Create: `src/i18n/request.ts`, `messages/en.json`, `messages/de.json`, `src/components/theme-provider.tsx`
- Modify: `src/app/layout.tsx`, `next.config.ts`

**Interfaces:**
- Produces: `useTranslations(namespace)` available in every component; `ThemeProvider` mounted at the root; `<Toaster />` mounted once.

- [ ] **Step 1: Install**

```bash
npm install --save-exact next-intl next-themes
```

- [ ] **Step 2: Write the catalogs**

`messages/en.json`:

```json
{
  "nav": {
    "dashboard": "Dashboard",
    "feeds": "Feeds",
    "articles": "Articles",
    "tags": "Tags",
    "users": "Users",
    "settings": "Settings",
    "integrations": "Integrations",
    "ai": "AI",
    "account": "Account"
  },
  "settings": {
    "title": "Settings",
    "general": { "title": "General", "theme": "Theme", "language": "Language" },
    "theme": { "light": "Light", "dark": "Dark", "system": "System" },
    "language": { "en": "English", "de": "German" },
    "library": {
      "title": "Library",
      "retention": "Article retention",
      "retentionHelp": "Articles older than this are removed. Starred articles are kept.",
      "interval": "Update interval",
      "intervalHelp": "How often feeds are checked for new articles.",
      "days": "days",
      "minutes": "minutes"
    },
    "about": { "title": "About", "source": "Source code", "issues": "Report an issue" },
    "saved": "Settings saved",
    "saveFailed": "Could not save settings"
  },
  "common": { "save": "Save", "cancel": "Cancel", "loading": "Loading" }
}
```

`messages/de.json` — same keys, German values:

```json
{
  "nav": {
    "dashboard": "Übersicht",
    "feeds": "Feeds",
    "articles": "Artikel",
    "tags": "Tags",
    "users": "Benutzer",
    "settings": "Einstellungen",
    "integrations": "Integrationen",
    "ai": "KI",
    "account": "Konto"
  },
  "settings": {
    "title": "Einstellungen",
    "general": { "title": "Allgemein", "theme": "Design", "language": "Sprache" },
    "theme": { "light": "Hell", "dark": "Dunkel", "system": "System" },
    "language": { "en": "Englisch", "de": "Deutsch" },
    "library": {
      "title": "Bibliothek",
      "retention": "Aufbewahrung",
      "retentionHelp": "Ältere Artikel werden entfernt. Markierte Artikel bleiben erhalten.",
      "interval": "Aktualisierungsintervall",
      "intervalHelp": "Wie oft Feeds auf neue Artikel geprüft werden.",
      "days": "Tage",
      "minutes": "Minuten"
    },
    "about": { "title": "Über", "source": "Quellcode", "issues": "Problem melden" },
    "saved": "Einstellungen gespeichert",
    "saveFailed": "Einstellungen konnten nicht gespeichert werden"
  },
  "common": { "save": "Speichern", "cancel": "Abbrechen", "loading": "Wird geladen" }
}
```

- [ ] **Step 3: Write the failing test**

```ts
// src/i18n/messages.test.ts
import en from "../../messages/en.json";
import de from "../../messages/de.json";
import { describe, expect, it } from "vitest";

function keys(object: unknown, prefix = ""): string[] {
  if (typeof object !== "object" || object === null) return [prefix];
  return Object.entries(object).flatMap(([key, value]) =>
    keys(value, prefix ? `${prefix}.${key}` : key),
  );
}

describe("message catalogs", () => {
  it("define exactly the same keys", () => {
    // A missing key renders the raw key path to the user, which no visual review
    // reliably catches -- so it is asserted instead.
    expect(keys(de).sort()).toEqual(keys(en).sort());
  });

  it("leave no value empty", () => {
    for (const [name, catalog] of [["en", en], ["de", de]] as const) {
      for (const path of keys(catalog)) {
        const value = path.split(".").reduce<unknown>((node, part) => (node as never)[part], catalog);
        expect(value, `${name}:${path}`).not.toBe("");
      }
    }
  });
});
```

- [ ] **Step 4: Run it**

```bash
npm test -- messages
```

Expected: PASS if the catalogs are aligned. If it fails, align them — do not relax the test.

- [ ] **Step 5: Configure next-intl and the root layout**

`src/i18n/request.ts`:

```ts
import { getRequestConfig } from "next-intl/server";

import { getSettings } from "@/lib/settings/queries";

export default getRequestConfig(async () => {
  // Locale comes from the user's stored preference, not from Accept-Language:
  // this is a single-user-per-session app where the setting is explicit.
  const settings = await getSettings();
  const locale = settings.language === "de" ? "de" : "en";
  return { locale, messages: (await import(`../../messages/${locale}.json`)).default };
});
```

`next.config.ts` — wrap the export:

```ts
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");
export default withNextIntl(config);
```

`src/app/layout.tsx`:

```tsx
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";

import "./globals.css";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} suppressHydrationWarning>
      {/* suppressHydrationWarning is required: next-themes sets the class on
          <html> before React hydrates, to avoid a flash of the wrong theme. */}
      <body>
        <ThemeProvider>
          <NextIntlClientProvider>{children}</NextIntlClientProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
```

`src/components/theme-provider.tsx`:

```tsx
"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem>
      {children}
    </NextThemesProvider>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(next): Add EN/DE localization and theming

A test asserts the catalogs define identical key sets: a missing key renders the
raw key path to the user, which visual review does not reliably catch.

Locale comes from the stored user preference rather than Accept-Language, since
the setting is explicit. suppressHydrationWarning on <html> is required --
next-themes sets the class before hydration to avoid a flash of the wrong theme."
```

---

### Task 2: Settings query and actions

Written before the UI, so the settings page has something real to render and the phase 4 seam is exercised from the start.

**Files:**
- Create: `src/lib/settings/queries.ts`, `src/lib/settings/actions.ts`
- Test: `src/lib/settings/settings.test.ts`

**Interfaces:**
- Produces:
  - `getSettings(): Promise<UserSettings>` — returns the current owner's row, creating it if absent.
  - `updateGeneralSettings(input: { theme: string; language: string }): Promise<{ ok: boolean; error?: string }>`
  - `updateLibrarySettings(input: { articleRetentionDays: number; updateIntervalMinutes: number }): Promise<{ ok: boolean; error?: string }>`
  - `currentUserId(): Promise<string>` — **the phase 4 seam.** Returns `BOOTSTRAP_USER_ID` today; phase 4 changes only this function.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/settings/settings.test.ts
import { describe, expect, it } from "vitest";

import { updateLibrarySettings } from "./actions";

describe("updateLibrarySettings", () => {
  it("rejects a retention of zero days", async () => {
    const result = await updateLibrarySettings({
      articleRetentionDays: 0,
      updateIntervalMinutes: 30,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an update interval below one minute", async () => {
    const result = await updateLibrarySettings({
      articleRetentionDays: 60,
      updateIntervalMinutes: 0,
    });
    expect(result.ok).toBe(false);
  });

  it("accepts sane values", async () => {
    const result = await updateLibrarySettings({
      articleRetentionDays: 60,
      updateIntervalMinutes: 30,
    });
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npm test -- settings
```

Expected: FAIL — module missing.

- [ ] **Step 3: Write the query, with the seam isolated**

```ts
// src/lib/settings/queries.ts
import { eq } from "drizzle-orm";

import { getDb } from "@/lib/db/client";
import { BOOTSTRAP_USER_ID, ensureBootstrapUser } from "@/lib/db/bootstrap";
import { type UserSettings, userSettings } from "@/lib/db/schema";

/**
 * The phase 3/4 seam, deliberately one function.
 *
 * Until authentication exists, everything is owned by the bootstrap user. Phase 4
 * replaces this body with a session lookup and nothing else in the app changes.
 */
export async function currentUserId(): Promise<string> {
  await ensureBootstrapUser();
  return BOOTSTRAP_USER_ID;
}

export async function getSettings(): Promise<UserSettings> {
  const db = getDb();
  const userId = await currentUserId();

  const existing = db.select().from(userSettings).where(eq(userSettings.userId, userId)).get();
  if (existing) return existing;

  db.insert(userSettings).values({ userId }).run();
  return db.select().from(userSettings).where(eq(userSettings.userId, userId)).get()!;
}
```

- [ ] **Step 4: Write the actions**

```ts
// src/lib/settings/actions.ts
"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getDb } from "@/lib/db/client";
import { userSettings } from "@/lib/db/schema";

import { currentUserId } from "./queries";

const general = z.object({
  theme: z.enum(["light", "dark", "system"]),
  language: z.enum(["en", "de"]),
});

const library = z.object({
  articleRetentionDays: z.number().int().min(1).max(3650),
  updateIntervalMinutes: z.number().int().min(1).max(1440),
});

type Result = { ok: boolean; error?: string };

async function write(values: Partial<typeof userSettings.$inferInsert>): Promise<Result> {
  const db = getDb();
  const userId = await currentUserId();
  db.update(userSettings)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(userSettings.userId, userId))
    .run();
  // The locale is read server-side per request, so a language change must
  // invalidate every rendered route, not just this page.
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function updateGeneralSettings(input: unknown): Promise<Result> {
  const parsed = general.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message };
  return write(parsed.data);
}

export async function updateLibrarySettings(input: unknown): Promise<Result> {
  const parsed = library.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message };
  return write(parsed.data);
}
```

```bash
npm install --save-exact zod
```

- [ ] **Step 5: Run the tests, then commit**

```bash
npm test -- settings
```

Expected: PASS.

```bash
git add -A
git commit -m "feat(next): Add settings queries and actions

currentUserId() is deliberately a single function: it is the phase 3/4 seam, and
phase 4 replaces its body with a session lookup without touching anything else.

A language change revalidates the whole layout, not just the settings route --
the locale is resolved server-side per request, so every rendered route is stale."
```

---

### Task 3: Sidebar, breadcrumbs and the content frame

**Files:**
- Create: `src/lib/nav.ts`, `src/components/app-sidebar.tsx`, `src/components/route-breadcrumbs.tsx`, `src/app/(app)/layout.tsx`, `src/app/(app)/page.tsx`
- Test: `src/lib/nav.test.ts`

**Interfaces:**
- Produces:
  - `NAV_ITEMS: readonly NavItem[]` where `NavItem = { href: string; labelKey: string; icon: LucideIcon; adminOnly: boolean }`.
  - `breadcrumbsFor(pathname: string): { href: string; labelKey: string }[]` — used by `route-breadcrumbs.tsx`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/nav.test.ts
import { describe, expect, it } from "vitest";

import { breadcrumbsFor } from "./nav";

describe("breadcrumbsFor", () => {
  it("returns just the root for the dashboard", () => {
    expect(breadcrumbsFor("/")).toEqual([{ href: "/", labelKey: "nav.dashboard" }]);
  });

  it("accumulates hrefs down the path", () => {
    expect(breadcrumbsFor("/feeds")).toEqual([
      { href: "/", labelKey: "nav.dashboard" },
      { href: "/feeds", labelKey: "nav.feeds" },
    ]);
  });

  it("labels an unknown trailing segment as a record id", () => {
    // /feeds/42 -> Dashboard / Feeds / 42, with the id shown verbatim.
    const crumbs = breadcrumbsFor("/feeds/42");
    expect(crumbs).toHaveLength(3);
    expect(crumbs[2]).toEqual({ href: "/feeds/42", labelKey: "42" });
  });

  it("ignores trailing slashes", () => {
    expect(breadcrumbsFor("/feeds/")).toEqual(breadcrumbsFor("/feeds"));
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

```bash
npm test -- nav
```

- [ ] **Step 3: Write `nav.ts`**

```ts
// src/lib/nav.ts
import {
  Bot,
  LayoutDashboard,
  Newspaper,
  Plug,
  Rss,
  Settings,
  Tags,
  Users,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  labelKey: string;
  icon: LucideIcon;
  adminOnly: boolean;
};

/** The single source for both sidebar navigation and breadcrumb labels. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", labelKey: "nav.dashboard", icon: LayoutDashboard, adminOnly: false },
  { href: "/feeds", labelKey: "nav.feeds", icon: Rss, adminOnly: false },
  { href: "/articles", labelKey: "nav.articles", icon: Newspaper, adminOnly: false },
  { href: "/tags", labelKey: "nav.tags", icon: Tags, adminOnly: false },
  { href: "/users", labelKey: "nav.users", icon: Users, adminOnly: true },
  { href: "/integrations", labelKey: "nav.integrations", icon: Plug, adminOnly: false },
  { href: "/ai", labelKey: "nav.ai", icon: Bot, adminOnly: false },
  { href: "/settings", labelKey: "nav.settings", icon: Settings, adminOnly: false },
];

const LABELS = new Map(NAV_ITEMS.map((item) => [item.href, item.labelKey]));

/**
 * Breadcrumbs from the URL alone.
 *
 * A new page gets correct breadcrumbs by living at the right path, with no
 * registration step -- which is why every view must be a real route.
 * An unmatched segment (a record id) is shown verbatim.
 */
export function breadcrumbsFor(pathname: string): { href: string; labelKey: string }[] {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs = [{ href: "/", labelKey: "nav.dashboard" }];

  let href = "";
  for (const segment of segments) {
    href += `/${segment}`;
    crumbs.push({ href, labelKey: LABELS.get(href) ?? segment });
  }
  return crumbs;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm test -- nav
```

Expected: PASS, all four.

- [ ] **Step 5: Write the sidebar**

```tsx
// src/components/app-sidebar.tsx
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
                <SidebarMenuButton
                  asChild
                  isActive={
                    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)
                  }
                >
                  <Link href={item.href}>
                    <item.icon />
                    <span>{t(item.labelKey)}</span>
                  </Link>
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
```

- [ ] **Step 6: Write the breadcrumbs component and the frame**

```tsx
// src/components/route-breadcrumbs.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { breadcrumbsFor } from "@/lib/nav";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export function RouteBreadcrumbs() {
  const pathname = usePathname();
  const t = useTranslations();
  const crumbs = breadcrumbsFor(pathname);

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          // A labelKey containing a dot is a catalog path; anything else is a
          // literal record id and must not be translated.
          const label = crumb.labelKey.includes(".") ? t(crumb.labelKey) : crumb.labelKey;
          return (
            <BreadcrumbItem key={crumb.href}>
              {isLast ? (
                <BreadcrumbPage>{label}</BreadcrumbPage>
              ) : (
                <>
                  <BreadcrumbLink asChild>
                    <Link href={crumb.href}>{label}</Link>
                  </BreadcrumbLink>
                  <BreadcrumbSeparator />
                </>
              )}
            </BreadcrumbItem>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
```

```tsx
// src/app/(app)/layout.tsx
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
```

`src/app/(app)/page.tsx`:

```tsx
export default function DashboardPage() {
  return <h1 className="text-2xl font-semibold">Yana</h1>;
}
```

- [ ] **Step 7: Verify on both viewports**

```bash
npm run dev
```

Check at 375px wide and at desktop width: the sidebar collapses to a sheet on mobile and is pinned on desktop, breadcrumbs update on navigation, and the trigger works at both sizes.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(next): Add the sidebar, segment-derived breadcrumbs and content frame

Breadcrumbs derive from the URL, so a page gets correct breadcrumbs by living at
the right path with no registration step -- which is what keeps every view a real
route rather than client state.

The layout awaits nothing: an await above the Suspense boundaries would block the
route's first byte, defeating the skeleton-then-data requirement."
```

---

### Task 4: The streaming skeleton pattern

This task establishes the pattern every later CRUD phase copies. Getting it wrong here propagates to nine phases.

**Files:**
- Create: `src/components/data-skeleton.tsx`
- Modify: `src/app/(app)/page.tsx`
- Create: `src/app/(app)/loading.tsx`

**Interfaces:**
- Produces: `<TableSkeleton rows={n} columns={n} />` and `<CardSkeleton />` from `@/components/data-skeleton`, used as `<Suspense>` fallbacks throughout.

- [ ] **Step 1: Write the skeletons**

```tsx
// src/components/data-skeleton.tsx
import { Skeleton } from "@/components/ui/skeleton";

export function TableSkeleton({ rows = 8, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-2">
          {Array.from({ length: columns }, (_, column) => (
            <Skeleton key={column} className="h-9 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="space-y-3 rounded-lg border p-4" aria-busy="true">
      <Skeleton className="h-5 w-1/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
```

- [ ] **Step 2: Demonstrate the pattern on the dashboard**

```tsx
// src/app/(app)/page.tsx
import { Suspense } from "react";

import { CardSkeleton } from "@/components/data-skeleton";
import { getSettings } from "@/lib/settings/queries";

/**
 * The data region. Async, and rendered inside Suspense so the shell streams
 * first. This is the shape every list and detail view in phases 5-10 follows.
 */
async function LibrarySummary() {
  const settings = await getSettings();
  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">
        Retention {settings.articleRetentionDays} days · updates every{" "}
        {settings.updateIntervalMinutes} minutes
      </p>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <div className="space-y-4">
      {/* Renders immediately -- not inside Suspense. */}
      <h1 className="text-2xl font-semibold">Yana</h1>
      <Suspense fallback={<CardSkeleton />}>
        <LibrarySummary />
      </Suspense>
    </div>
  );
}
```

- [ ] **Step 3: Add a route-level fallback**

```tsx
// src/app/(app)/loading.tsx
import { TableSkeleton } from "@/components/data-skeleton";

export default function Loading() {
  return <TableSkeleton />;
}
```

- [ ] **Step 4: Verify streaming actually happens**

```bash
npm run build && npm start
```

Then, in another shell:

```bash
curl -N -s http://localhost:3000/ | head -40
```

Expected: the heading and sidebar markup arrive in the first chunk, **before** the settings-dependent markup. If everything arrives at once, an `await` has leaked above a Suspense boundary — find it and move it down. This curl is the only reliable check; the browser is too fast locally to show the difference.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(next): Establish the streaming skeleton pattern

Data regions are async components inside Suspense; the shell renders
synchronously above them. Phases 5-10 copy this shape, so getting it right here
propagates.

Verified with curl -N rather than a browser: locally the browser is too fast to
show whether the shell actually streamed first, and an await leaking above a
boundary looks identical to correct behavior."
```

---

### Task 5: The settings page

**Files:**
- Create: `src/app/(app)/settings/page.tsx`, `src/components/settings/general-section.tsx`, `src/components/settings/library-section.tsx`, `src/components/settings/about-section.tsx`

**Interfaces:**
- Consumes: `getSettings`, `updateGeneralSettings`, `updateLibrarySettings` from Task 2; `TableSkeleton`/`CardSkeleton` from Task 4.
- Produces: the `/settings` route with three sections.

- [ ] **Step 1: Write the general section**

```tsx
// src/components/settings/general-section.tsx
"use client";

import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { updateGeneralSettings } from "@/lib/settings/actions";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function GeneralSection({ theme, language }: { theme: string; language: string }) {
  const t = useTranslations("settings");
  const { setTheme } = useTheme();
  const [pending, start] = useTransition();

  function save(next: { theme: string; language: string }) {
    start(async () => {
      const result = await updateGeneralSettings(next);
      if (result.ok) {
        toast.success(t("saved"));
      } else {
        toast.error(result.error ?? t("saveFailed"));
      }
    });
  }

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">{t("general.title")}</h2>

      <div className="grid gap-2">
        <Label htmlFor="theme">{t("general.theme")}</Label>
        <Select
          defaultValue={theme}
          disabled={pending}
          onValueChange={(value) => {
            // Applied locally at once so the change is visible before the round
            // trip; the server write is what makes it persist.
            setTheme(value);
            save({ theme: value, language });
          }}
        >
          <SelectTrigger id="theme" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["light", "dark", "system"].map((value) => (
              <SelectItem key={value} value={value}>
                {t(`theme.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="language">{t("general.language")}</Label>
        <Select
          defaultValue={language}
          disabled={pending}
          onValueChange={(value) => save({ theme, language: value })}
        >
          <SelectTrigger id="language" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["en", "de"].map((value) => (
              <SelectItem key={value} value={value}>
                {t(`language.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Write the library section**

```tsx
// src/components/settings/library-section.tsx
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { updateLibrarySettings } from "@/lib/settings/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LibrarySection({
  articleRetentionDays,
  updateIntervalMinutes,
}: {
  articleRetentionDays: number;
  updateIntervalMinutes: number;
}) {
  const t = useTranslations("settings");
  const [retention, setRetention] = useState(String(articleRetentionDays));
  const [interval, setInterval] = useState(String(updateIntervalMinutes));
  const [pending, start] = useTransition();

  function save() {
    start(async () => {
      const result = await updateLibrarySettings({
        articleRetentionDays: Number(retention),
        updateIntervalMinutes: Number(interval),
      });
      result.ok ? toast.success(t("saved")) : toast.error(result.error ?? t("saveFailed"));
    });
  }

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">{t("library.title")}</h2>

      <div className="grid gap-2">
        <Label htmlFor="retention">{t("library.retention")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="retention"
            type="number"
            min={1}
            max={3650}
            value={retention}
            onChange={(event) => setRetention(event.target.value)}
            className="w-24"
          />
          <span className="text-sm text-muted-foreground">{t("library.days")}</span>
        </div>
        <p className="text-sm text-muted-foreground">{t("library.retentionHelp")}</p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="interval">{t("library.interval")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="interval"
            type="number"
            min={1}
            max={1440}
            value={interval}
            onChange={(event) => setInterval(event.target.value)}
            className="w-24"
          />
          <span className="text-sm text-muted-foreground">{t("library.minutes")}</span>
        </div>
        <p className="text-sm text-muted-foreground">{t("library.intervalHelp")}</p>
      </div>

      <Button onClick={save} disabled={pending} className="w-full sm:w-auto">
        {t("../common.save" as never) ?? "Save"}
      </Button>
    </section>
  );
}
```

> Fix the button label to use a `useTranslations("common")` instance rather than the path hack above — two hook calls are correct here, and the hack does not work.

- [ ] **Step 3: Write the about section and the page**

```tsx
// src/components/settings/about-section.tsx
import { useTranslations } from "next-intl";

const REPO = "https://github.com/fa-krug/yana-server";

export function AboutSection() {
  const t = useTranslations("settings");
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-medium">{t("about.title")}</h2>
      <ul className="space-y-1 text-sm">
        <li>
          <a className="underline" href={REPO} target="_blank" rel="noreferrer noopener">
            {t("about.source")}
          </a>
        </li>
        <li>
          <a className="underline" href={`${REPO}/issues`} target="_blank" rel="noreferrer noopener">
            {t("about.issues")}
          </a>
        </li>
      </ul>
    </section>
  );
}
```

```tsx
// src/app/(app)/settings/page.tsx
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { CardSkeleton } from "@/components/data-skeleton";
import { AboutSection } from "@/components/settings/about-section";
import { GeneralSection } from "@/components/settings/general-section";
import { LibrarySection } from "@/components/settings/library-section";
import { Separator } from "@/components/ui/separator";
import { getSettings } from "@/lib/settings/queries";

async function Sections() {
  const settings = await getSettings();
  return (
    <div className="space-y-8">
      <GeneralSection theme={settings.theme} language={settings.language} />
      <Separator />
      <LibrarySection
        articleRetentionDays={settings.articleRetentionDays}
        updateIntervalMinutes={settings.updateIntervalMinutes}
      />
      <Separator />
      <AboutSection />
    </div>
  );
}

export default async function SettingsPage() {
  const t = await getTranslations("settings");
  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <Suspense fallback={<CardSkeleton />}>
        <Sections />
      </Suspense>
    </div>
  );
}
```

- [ ] **Step 4: Verify by hand**

```bash
npm run dev
```

At `/settings`: switching theme applies immediately and a toast confirms; switching language re-renders the whole shell in German; retention and interval save with validation rejecting 0. Reload and confirm all four persisted. Check at 375px — the selects and button go full width.

- [ ] **Step 5: Add the health route**

```ts
// src/app/health/route.ts
import { getDb } from "@/lib/db/client";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    // Prove the database is actually reachable, not just that Node is up.
    getDb().$client.prepare("SELECT 1").get();
    return Response.json({ status: "ok" });
  } catch (error) {
    return Response.json(
      { status: "error", detail: error instanceof Error ? error.message : "unknown" },
      { status: 503 },
    );
  }
}
```

- [ ] **Step 6: Run every check, then commit**

```bash
npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
curl -s localhost:3000/health
```

```bash
git add -A
git commit -m "feat(next): Add the settings page and health route

Three sections: general (theme, language), library (retention, update interval),
about (repo and issue links). Theme applies locally before the round trip so the
change is visible immediately, while the server write is what persists it.

The health route runs SELECT 1 rather than returning a constant, so it reports
database reachability instead of just proving Node is running."
```

---

## Self-Review

**Spec coverage.** Against bullet 3:

| Requirement | Task |
|---|---|
| Sidebar left, content right | 3 |
| Breadcrumbs at top of content | 3 |
| Subpages reflected in URL and breadcrumbs | 3 (`breadcrumbsFor`, tested) |
| Chrome first, data async with skeletons | 4 |
| Toast system | 1 (`<Toaster>`), used in 5 |
| Settings → general (theme, language) | 5 |
| Settings → library (retention, interval) | 5 |
| Settings → about (GitHub, issues) | 5 |
| Mobile-first | 3, 5 |
| Health route (parity with Django's `/health/`) | 5 |

**Placeholder scan.** One defect found and flagged inline rather than left: Task 5 Step 2's save-button label uses an invalid `t("../common.save")` path. The note directs the engineer to a second `useTranslations("common")` call. Fix it while implementing rather than copying it.

**Type consistency.** `getSettings()` returns `UserSettings` from phase 2's inferred types, and the section props destructure real column names (`articleRetentionDays`, `updateIntervalMinutes`, `theme`, `language`). `currentUserId()` is `Promise<string>` in Task 2 and consumed as such. `breadcrumbsFor` returns `{ href, labelKey }[]` in Task 3 Step 3 and is destructured identically in Step 6. `NavItem.adminOnly` is set in `nav.ts` and read by `AppSidebar`'s filter.

**One deferred item.** `AppSidebar` takes `isAdmin` and the layout passes `true` unconditionally, because no session exists yet. Phase 4 replaces that literal and phase 5 relies on the filter already being in place — so the prop exists now deliberately rather than being added later.

---

## Post-execution record (added after phase 3 landed)

This plan is an executed historical record — the tasks above are not rewritten. What follows is what
executing it actually revealed, kept here so later phase plans do not repeat it.

- **Task 3 Step 6's `AppLayout` snippet nested a second `<main>` inside `SidebarInset`**, which already
  renders a `<main>` landmark (see `src/components/ui/sidebar.tsx`). Two nested `<main>` elements is
  non-conforming HTML that hands assistive tech two "main" regions to choose between; it produces no
  hydration warning and no lint error. The executed code uses a plain `<div>` there instead.
- **The File Structure table listed no error boundary.** `src/app/(app)/error.tsx` is half of the
  streaming pattern this phase establishes — `<Suspense>` **plus** an error boundary — but the table
  never mentioned it.
- **Two snippets hardcoded user-facing English against this plan's own Global Constraint** ("every
  user-facing string comes from a message catalog — no literals in components"): Task 4 Step 2's
  `LibrarySummary` text ("Retention {n} days · updates every {n} minutes") and Task 5 Step 2's
  fallback `"Save"` string. Both were routed through the message catalog instead.
- **`src/i18n/routing.ts`, listed in the File Structure table, was correctly never created.** There is
  no `[locale]` URL segment in this app — locale comes from the stored user preference, not the URL —
  so the file would have had nothing to do.
- **The `curl -N` verification criterion in Task 4 Step 4 stopped reliably discriminating streaming
  from non-streaming once `getSettings()` was wrapped in `cache()`.** A cached read resolves quickly
  enough that the shell and the data region can arrive close together in that one curl, which is
  exactly the failure mode the check exists to catch — it needs a slower, less-memoized data read to
  stay a meaningful test.
- **Task 1 depended on Task 2, so the plan's stated order could not compile.** Task 1 Step 5 writes
  `src/i18n/request.ts`, which imports `getSettings` from `@/lib/settings/queries` — a module Task 2
  creates. Executed in the reverse order (Task 2 before Task 1) instead.
- **`asChild` appears throughout this plan's JSX snippets** (`SidebarMenuButton asChild`,
  `BreadcrumbLink asChild`) — that prop does not exist in this component library, which is built on
  Base UI, not Radix. Every such snippet was rewritten to use Base UI's `render` prop instead.
