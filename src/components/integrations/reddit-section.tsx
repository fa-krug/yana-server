"use client";

import { useTranslations } from "next-intl";
import { Suspense, use, useState, useTransition } from "react";

import { ConfirmDestructive } from "@/components/crud/confirm-destructive";
import { StatusBadge, useReportOutcome } from "@/components/integrations/section-parts";
import { secretPlaceholder, submittedSecret } from "@/components/section-kit";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { removeReddit, saveReddit, testReddit } from "@/lib/integrations/actions";
import type { IntegrationStatus } from "@/lib/integrations/queries";
import { attempt } from "@/lib/integrations/result";

/**
 * The Reddit credentials card -- `<YoutubeSectionForm>`'s twin, with two
 * differences worth stating:
 *
 * - **Two secrets, one form.** Either field may be left empty to keep what is
 *   stored, independently of the other, so changing only a rotated secret does
 *   not require re-typing the client id.
 * - **The User-Agent is plaintext and is sent in full.** It is not a credential;
 *   Reddit throttles a generic one hard, so it is the field an operator most
 *   often has to correct, and masking it would make that impossible. It is also
 *   required -- the server refuses an empty one with its own key rather than
 *   letting the probe report it as rejected credentials.
 *
 * Every action goes through `attempt()` -- never a bare `await` (CLAUDE.md).
 *
 * All four props are optional (paired with `pending`) for the same "not
 * loaded yet" state `<YoutubeSectionForm>` documents: the real card renders,
 * disabled, from the first frame, and the status badge is omitted entirely
 * rather than shown with a neutral frame -- it is a probe-derived verdict,
 * and nothing honest can be shown before it is known. `userAgent` alone
 * defaults to `""` rather than staying `undefined`, because unlike the two
 * secrets it is not a credential and the field is meant to hold exactly what
 * is stored -- an empty string is what "not configured yet" looks like for a
 * plain text field, same as every other pending text input in this migration.
 */
export function RedditSectionForm({
  enabled,
  clientIdMasked,
  clientSecretMasked,
  userAgent: storedUserAgent = "",
  pending = false,
}: {
  enabled?: boolean;
  clientIdMasked?: string;
  clientSecretMasked?: string;
  userAgent?: string;
  pending?: boolean;
}) {
  const t = useTranslations("integrations");
  const report = useReportOutcome();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  // The one field that *is* seeded from the server, because it is not a secret.
  const [userAgent, setUserAgent] = useState(storedUserAgent);
  const [saving, startSave] = useTransition();
  const [testing, startTest] = useTransition();
  const busy = pending || saving || testing;
  const configured =
    (clientIdMasked !== undefined && clientIdMasked !== "") ||
    (clientSecretMasked !== undefined && clientSecretMasked !== "");

  function submission() {
    return {
      clientId: submittedSecret(clientId),
      clientSecret: submittedSecret(clientSecret),
      userAgent,
    };
  }

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startSave(async () => {
      const result = await attempt(() => saveReddit(submission()));
      report(result, "saved");
      if (result.ok) {
        setClientId("");
        setClientSecret("");
      }
    });
  }

  function test() {
    startTest(async () => {
      report(await attempt(() => testReddit(submission())), "tested");
    });
  }

  /** `true` only on success -- anything else keeps the dialog open. */
  async function remove(): Promise<boolean> {
    const result = await attempt(() => removeReddit());
    report(result, "removed");
    if (result.ok) {
      setClientId("");
      setClientSecret("");
    }
    return result.ok;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("reddit.title")}</CardTitle>
        <CardDescription>{t("reddit.description")}</CardDescription>
        {/* Omitted entirely while pending -- see the doc comment above. */}
        {pending ? null : <CardAction>{<StatusBadge enabled={enabled ?? false} />}</CardAction>}
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          {/* The two secrets and the one hint that belongs to both of them. It
              used to sit inside the client-secret group, where it read as a rule
              about that field alone -- and "leave a field empty to keep the
              stored value" is precisely the thing an operator has to know about
              the *pair*, since either may be left alone independently. */}
          <div className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="reddit-client-id">{t("reddit.clientId")}</Label>
              <Input
                id="reddit-client-id"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={secretPlaceholder(clientIdMasked ?? "")}
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                disabled={busy}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="reddit-client-secret">{t("reddit.clientSecret")}</Label>
              <Input
                id="reddit-client-secret"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={secretPlaceholder(clientSecretMasked ?? "")}
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                disabled={busy}
              />
            </div>
            <p className="text-sm text-muted-foreground">
              {configured ? t("keepHint") : t("notConfigured")}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="reddit-user-agent">{t("reddit.userAgent")}</Label>
            {/* type="text": not a secret, and an operator has to be able to
                read what they wrote. `required` saves a round trip; the
                server enforces it either way. */}
            <Input
              id="reddit-user-agent"
              type="text"
              required
              autoComplete="off"
              value={userAgent}
              onChange={(event) => setUserAgent(event.target.value)}
              disabled={busy}
            />
            <p className="text-sm text-muted-foreground">{t("reddit.userAgentHelp")}</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <Button type="submit" disabled={busy} className="w-full sm:w-auto">
              {saving ? t("saving") : t("save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={test}
              className="w-full sm:w-auto"
            >
              {testing ? t("testing") : t("test")}
            </Button>
          </div>
        </form>
      </CardContent>
      {configured ? (
        <CardFooter className="justify-end">
          <ConfirmDestructive
            trigger={
              <Button type="button" variant="destructive" disabled={busy}>
                {t("remove")}
              </Button>
            }
            title={t("reddit.removeTitle")}
            description={t("reddit.removeDescription")}
            confirmLabel={t("removeConfirm")}
            onConfirm={remove}
          />
        </CardFooter>
      ) : null}
    </Card>
  );
}

/** Calls use(); suspends until the promise resolves; renders the form for real. */
function RedditSectionResolved({ promise }: { promise: Promise<IntegrationStatus> }) {
  const status = use(promise);
  return (
    <RedditSectionForm
      enabled={status.reddit.enabled}
      clientIdMasked={status.reddit.clientIdMasked}
      clientSecretMasked={status.reddit.clientSecretMasked}
      userAgent={status.reddit.userAgent}
    />
  );
}

/**
 * What the page renders. The fallback is the real form, in its pending
 * state -- see the Design Reference in
 * docs/superpowers/plans/2026-08-16-streaming-controls-migration.md -- so the
 * heading, description and all three field labels are on screen from the
 * first frame and only the masks, the user agent, the badge and the enabled
 * state stream in afterward.
 */
export function RedditSection({ promise }: { promise: Promise<IntegrationStatus> }) {
  return (
    <Suspense fallback={<RedditSectionForm pending />}>
      <RedditSectionResolved promise={promise} />
    </Suspense>
  );
}
