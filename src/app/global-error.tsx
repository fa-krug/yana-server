"use client";

import messages from "../../messages/en.json";

import "./globals.css";

/**
 * The last-resort boundary: it catches what src/app/(app)/error.tsx cannot,
 * namely a throw in the root layout itself. The root layout reads the database
 * twice (locale and theme), and although both of those now degrade rather than
 * propagate (see src/i18n/request.ts and src/app/layout.tsx), a font fetch or a
 * provider can still fail there.
 *
 * This file *replaces* the root layout when it renders, which is why it must
 * carry its own <html>/<body> and import globals.css itself -- Next's error.md
 * is explicit about that. It also means none of the providers exist here:
 *
 * - No NextIntlClientProvider, so useTranslations()/getTranslations() would
 *   throw inside the error handler. The catalog is imported directly instead,
 *   and only the English one: resolving the stored language needs a database
 *   read from a Client Component that has no request scope, and guessing from
 *   navigator.language would be wrong as often as right. "en" is the same
 *   fallback locale src/i18n/request.ts uses when the preference is unreadable.
 * - No next-themes, so there is no `dark` class on <html> and this page paints
 *   in the light palette regardless of the user's theme. Next documents that
 *   trade-off for global-error; carrying a theme through a boundary whose whole
 *   premise is that the layout failed is not worth the machinery.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en">
      <body className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div role="alert" className="max-w-md space-y-4">
          <h1 className="text-xl font-semibold">{messages.error.fatalTitle}</h1>
          <p className="text-sm text-muted-foreground">{messages.error.fatalDescription}</p>
          {/* Same choice as (app)/error.tsx: unstable_retry() re-fetches, which
              is what recovers from a transient failure; reset() would re-render
              the same failed payload. */}
          <button
            type="button"
            onClick={() => unstable_retry()}
            className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent"
          >
            {messages.error.retry}
          </button>
          {error.digest ? (
            <p className="font-mono text-xs text-muted-foreground">{error.digest}</p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
