"use client";

import { KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn } from "@/lib/auth/client";
import { passkeyErrorKey, passwordErrorKey, type AuthMessageKey } from "@/lib/auth/sign-in-errors";

/**
 * Passkey first, password always reachable.
 *
 * `next` arrives as a prop rather than from `useSearchParams()`: the page above
 * is a Server Component that already reads the query string, and Next's own
 * guidance for that case is to pass the value down ("If you're already in a
 * Server Component Page, consider using the `searchParams` prop and passing the
 * values to Client Components" --
 * `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md`).
 * It also puts the open-redirect check (`safeNextPath()`) in exactly one place,
 * on the server, instead of leaving a raw URL value in the client bundle that a
 * later edit could forget to validate -- and it sidesteps the missing-Suspense
 * build failure `useSearchParams()` causes on a prerenderable route entirely,
 * rather than papering over it with a boundary.
 */
export function LoginForm({ next }: { next: string }) {
  const t = useTranslations("auth");
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * `replace`, not `push`: /login must not sit in the history stack behind the
   * app, or the back button lands a signed-in user on a sign-in form.
   *
   * No `router.refresh()` afterwards. It refetches the route the app is on
   * *now*, which for the moment after a replace() is still /login -- and /login
   * with a valid session redirects to "/", so refreshing here can race the
   * navigation and steal the user away from `next`. It is not needed either:
   * every route in the app is dynamic (session and settings reads), so the
   * client router's stale time for it is zero and the navigation fetches it
   * from the server with the cookie the sign-in just set.
   *
   * `busy` deliberately stays true: the navigation is in flight, and
   * re-enabling the buttons only invites a second sign-in on top of it.
   */
  function goToNext() {
    router.replace(next);
  }

  function fail(key: AuthMessageKey) {
    // The catalog key, never `error.message`. Better Auth's messages are
    // English constants -- see src/lib/auth/sign-in-errors.ts.
    toast.error(t(key));
  }

  async function withPasskey() {
    // Feature-detected rather than assumed: `PublicKeyCredential` is absent in
    // older browsers and in a number of embedded webviews, where
    // signIn.passkey() would reject somewhere inside the ceremony and leave a
    // button that simply does nothing. Revealing the password field along with
    // the message means the user is one field away from signing in instead of
    // stranded.
    if (typeof window === "undefined" || !("PublicKeyCredential" in window)) {
      setShowPassword(true);
      fail("passkeyUnsupported");
      return;
    }

    setBusy(true);
    const result = await signIn.passkey();
    // A cancelled ceremony is the common case, and the password field is what
    // the user needs next -- so reveal it here too rather than making them find
    // the button.
    if (result?.error) {
      setBusy(false);
      setShowPassword(true);
      fail(passkeyErrorKey(result.error));
      return;
    }
    goToNext();
  }

  async function withPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const result = await signIn.email({ email, password });
    if (result.error) {
      setBusy(false);
      fail(passwordErrorKey(result.error));
      return;
    }
    goToNext();
  }

  return (
    <div className="w-full space-y-6">
      <div className="space-y-1.5">
        <h1 className="text-2xl font-semibold tracking-tight">{t("signIn")}</h1>
        <p className="text-sm text-muted-foreground">{t("signInHint")}</p>
      </div>

      <Button onClick={withPasskey} disabled={busy} size="lg" className="w-full">
        <KeyRound aria-hidden="true" />
        {t("passkeySignIn")}
      </Button>

      {showPassword ? (
        <form onSubmit={withPassword} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="email">{t("email")}</Label>
            <Input
              id="email"
              name="email"
              type="email"
              required
              // The browser's own credential UI depends on these: without the
              // pair, a password manager neither offers to fill nor offers to
              // save, which on a self-hosted install is most users' only
              // realistic path back in.
              autoComplete="username"
              autoFocus
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">{t("password")}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy} variant="secondary" size="lg" className="w-full">
            {busy ? t("signingIn") : t("signIn")}
          </Button>
        </form>
      ) : (
        <Button
          variant="ghost"
          size="lg"
          disabled={busy}
          onClick={() => setShowPassword(true)}
          className="w-full"
        >
          {t("usePassword")}
        </Button>
      )}
    </div>
  );
}
