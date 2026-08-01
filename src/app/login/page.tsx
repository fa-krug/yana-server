import { redirect } from "next/navigation";
import { connection } from "next/server";

import { LoginForm } from "@/components/auth/login-form";
import { safeNextPath } from "@/lib/auth/next-path";
import { currentUser } from "@/lib/auth/session";

/**
 * The sign-in page. Deliberately outside the `(app)` route group: that group's
 * layout calls `requireUser()`, so rendering the login form inside it would
 * redirect to itself forever, and its sidebar is navigation a signed-out
 * visitor has nowhere to use anyway. The root layout still applies, so the
 * locale, the theme and the `<Toaster>` are all in place.
 */
export default async function LoginPage({
  searchParams,
}: {
  // A Promise in Next 16 -- search params are request data, so a page that
  // reads them is a page that cannot be prerendered.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Per CLAUDE.md: better-sqlite3 is synchronous, so its queries would
  // otherwise complete during prerendering and bake this page against a data/
  // directory that does not exist until the startup hook migrates it. `currentUser()`
  // below reaches the database whenever the session cookie cache has expired.
  await connection();

  // Validated, never trusted: this value comes out of a URL anyone can write.
  // See safeNextPath() -- `?next=https://evil.tld` would otherwise turn a real
  // sign-in on the real host into a redirect to someone else's page.
  const next = safeNextPath((await searchParams).next);

  // Signing in again while already signed in cannot do anything useful, and
  // leaving the form reachable means a bookmarked /login shows a sign-in
  // screen to a user who is already authenticated. Sending them to `next`
  // rather than always to "/" makes /login?next=/settings idempotent.
  //
  // `currentUser()`, not `requireUser()`: the whole point here is that no
  // session is the *normal* case, and requireUser() would redirect it back to
  // this page.
  if (await currentUser()) redirect(next);

  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <LoginForm next={next} />
      </div>
    </main>
  );
}
