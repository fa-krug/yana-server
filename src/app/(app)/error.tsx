"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

/**
 * The error boundary for every route in the app group.
 *
 * Half of the streaming pattern this phase establishes: a data region is
 * <Suspense> **plus** this. Once the shell has flushed its first byte the
 * response status is already 200 and cannot become a 5xx, so a throw inside a
 * Suspense boundary with no error boundary above it just truncates the stream
 * and leaves the user on a half-drawn page. This turns that into a bounded
 * failure -- chrome intact, one region replaced.
 *
 * A Client Component, as Next requires of every error boundary (it needs
 * getDerivedStateFromError). It renders *inside* the root layout, so
 * NextIntlClientProvider and next-themes are both available and every string
 * comes from the catalogs; the root layout's own failures are handled a level
 * up in src/app/global-error.tsx, which has neither.
 */
export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  const t = useTranslations("error");

  return (
    <div role="alert" className="space-y-4 rounded-lg border border-destructive/40 p-4">
      <h2 className="text-lg font-medium">{t("title")}</h2>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      {/* unstable_retry(), not reset(): Next 16.2 added it and documents it as
          the one to reach for in most cases (see
          node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md).
          reset() only clears the boundary's error state and re-renders the same
          RSC payload, which for a failed server-side database query re-renders
          the same failure; unstable_retry() re-fetches the segment, which is
          what actually recovers from a transient one. `reset` is still passed
          alongside it if a later phase needs the cheaper form. */}
      <Button onClick={() => unstable_retry()} variant="outline">
        {t("retry")}
      </Button>
      {/* error.message is deliberately not rendered: for a Server Component
          throw Next replaces it with a generic string plus this digest anyway,
          and the real message is in the server log. Shown so an operator can
          match the two. */}
      {error.digest ? (
        <p className="font-mono text-xs text-muted-foreground">{error.digest}</p>
      ) : null}
    </div>
  );
}
