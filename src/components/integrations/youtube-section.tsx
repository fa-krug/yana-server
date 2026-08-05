"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

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
import { removeYoutube, saveYoutube, testYoutube } from "@/lib/integrations/actions";
import { attempt } from "@/lib/integrations/result";

/**
 * The YouTube credentials card.
 *
 * Four things about it are deliberate:
 *
 * 1. **It never receives the stored key.** `apiKeyMasked` is eight bullets and
 *    at most the last four characters, produced server-side (`mask()`), and it
 *    is rendered as the input's *placeholder*. The input's own value starts
 *    empty, so nothing secret is in this component's props, in the RSC payload,
 *    or in the DOM.
 * 2. **Save and Test both send `submittedSecret(apiKey)`**, so leaving the field
 *    alone keeps the stored key rather than replacing it with an empty string.
 * 3. **Test writes nothing**, which is what makes it safe to press before
 *    replacing a key that currently works.
 * 4. **The badge shows the probe-derived flag**, not "is something stored". A
 *    stored-but-rejected key reads as inactive, which is the whole point of
 *    deriving it.
 *
 * Every action goes through `attempt()` -- never a bare `await` (CLAUDE.md).
 */
export function YoutubeSection({
  enabled,
  apiKeyMasked,
}: {
  enabled: boolean;
  apiKeyMasked: string;
}) {
  const t = useTranslations("integrations");
  const report = useReportOutcome();
  const [apiKey, setApiKey] = useState("");
  // Two transitions rather than one flag: both buttons have to be disabled while
  // either call is in flight, but only the one that was pressed may say so.
  const [saving, startSave] = useTransition();
  const [testing, startTest] = useTransition();
  const busy = saving || testing;
  /** Is there anything to keep, or to remove? */
  const configured = apiKeyMasked !== "";

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startSave(async () => {
      const result = await attempt(() => saveYoutube({ apiKey: submittedSecret(apiKey) }));
      report(result, "saved");
      // Cleared only on success, so the placeholder (which the save just
      // refreshed) is what the field shows and a retry after a rejection still
      // has the typed key in it to correct.
      if (result.ok) setApiKey("");
    });
  }

  function test() {
    startTest(async () => {
      report(await attempt(() => testYoutube({ apiKey: submittedSecret(apiKey) })), "tested");
    });
  }

  /** `true` only on success -- anything else keeps the dialog open. */
  async function remove(): Promise<boolean> {
    const result = await attempt(() => removeYoutube());
    report(result, "removed");
    if (result.ok) setApiKey("");
    return result.ok;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("youtube.title")}</CardTitle>
        <CardDescription>{t("youtube.description")}</CardDescription>
        <CardAction>
          <StatusBadge enabled={enabled} />
        </CardAction>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="youtube-api-key">{t("youtube.apiKey")}</Label>
            {/* type="password" and autoComplete="off": a credential is not a
                login, so no password manager should offer to fill or store it,
                and it must not be readable over the operator's shoulder. */}
            <Input
              id="youtube-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={secretPlaceholder(apiKeyMasked)}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <p className="text-sm text-muted-foreground">
              {configured ? t("keepHint") : t("notConfigured")}
            </p>
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
      {/* Outside the form, so the trigger cannot submit it, and visually apart
          from Save: this is the one control here that destroys something. It is
          offered only when there is something to destroy -- `removeYoutube()`
          is idempotent either way. */}
      {configured ? (
        <CardFooter className="justify-end">
          <ConfirmDestructive
            trigger={
              <Button type="button" variant="destructive" disabled={busy}>
                {t("remove")}
              </Button>
            }
            title={t("youtube.removeTitle")}
            description={t("youtube.removeDescription")}
            confirmLabel={t("removeConfirm")}
            onConfirm={remove}
          />
        </CardFooter>
      ) : null}
    </Card>
  );
}
