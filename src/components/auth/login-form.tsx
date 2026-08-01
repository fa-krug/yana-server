"use client";

import { KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { attemptCall } from "@/lib/attempt";
import { signIn } from "@/lib/auth/client";
import { replaceLocation } from "@/lib/browser-location";
import {
  NETWORK_FAILURE,
  passkeyErrorKey,
  passwordErrorKey,
  type AuthMessageKey,
  type SignInError,
} from "@/lib/auth/sign-in-errors";

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
  const [showPassword, setShowPassword] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * A **full document navigation**, not `router.replace()` -- see
   * `replaceLocation()`. The short version: identity changes here, the root
   * layout owns the locale and the theme, and a soft navigation never
   * re-renders it, so the user lands inside chrome rendered for the person they
   * were a moment ago.
   *
   * `busy` deliberately stays true: the navigation is in flight, and
   * re-enabling the buttons only invites a second sign-in on top of it.
   */
  function goToNext() {
    replaceLocation(next);
  }

  function fail(key: AuthMessageKey) {
    // The catalog key, never `error.message`. Better Auth's messages are
    // English constants -- see src/lib/auth/sign-in-errors.ts.
    setBusy(false);
    toast.error(t(key));
  }

  /**
   * Run a sign-in call and hand back its error, or `NETWORK_FAILURE` if the
   * call never produced a response at all.
   *
   * **Not defensive: `@better-fetch/fetch` only turns *HTTP* failures into
   * `{ data, error }`.** The `await fetch(...)` inside it
   * (`node_modules/@better-fetch/fetch/dist/index.js`) is unwrapped, so a
   * network-level failure -- the container restarting, the host asleep, DNS
   * gone -- *rejects* instead. Unhandled, that rejection escapes the click
   * handler, `setBusy(false)` never runs, and the form sits on "Signing in"
   * forever with no message and no way back except a reload. On a self-hosted
   * box "I just restarted it" is the ordinary case, not the exotic one.
   *
   * Catching it is `attemptCall()`'s job (`@/lib/attempt`) -- the same core
   * every server-action call site in this repository goes through, which is why
   * the thrown reason is dropped rather than shown here too: a
   * `TypeError: fetch failed` from the platform is neither translated nor
   * useful, and the core has already logged it.
   *
   * **`sessionProbe: "skip"` is the one thing this call site does differently,
   * and the only place in the application that does.** Everywhere else a
   * rejection is followed by "did the session end?", and a `null` answer sends
   * the browser to `/login`. That is where this form already is: a caller with
   * no session is *supposed* to be here, so asking would point the sign-in page
   * at itself. Written as an argument rather than left as an absence, so the
   * next person can see it was decided.
   *
   * What is *not* different: the core re-throws Next's control-flow errors
   * before anything else. No `signIn.*` call can produce one -- it is an HTTP
   * request, not a server action -- so that branch is inert here, and inert is
   * the right default for a `catch` in this codebase.
   */
  async function attempt(
    call: () => Promise<{ error?: SignInError | null } | undefined | null>,
  ): Promise<{ ok: true } | { ok: false; error: SignInError | null }> {
    const attempted = await attemptCall(call, {
      label: "Sign-in request failed before it reached the server",
      sessionProbe: "skip",
    });
    if (attempted.status === "rejected") return { ok: false, error: NETWORK_FAILURE };
    // Optional-chained, and the same shape in both handlers: the two clients
    // are typed differently enough that one of them used `result?.error` and
    // the other `result.error`, which is two contracts for one call shape.
    return attempted.result?.error ? { ok: false, error: attempted.result.error } : { ok: true };
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
    const result = await attempt(() => signIn.passkey());
    if (!result.ok) {
      // A cancelled ceremony is the common case, and the password field is
      // what the user needs next -- so reveal it here too rather than making
      // them find the button.
      setShowPassword(true);
      fail(passkeyErrorKey(result.error));
      return;
    }
    goToNext();
  }

  async function withPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const result = await attempt(() => signIn.email({ email, password }));
    if (!result.ok) {
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
