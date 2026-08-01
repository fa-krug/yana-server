"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { StatusBadge, useReportOutcome } from "@/components/ai/section-parts";
import { ConfirmDestructive } from "@/components/crud/confirm-destructive";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { removeProvider, saveProvider, setActiveProvider, testProvider } from "@/lib/ai/actions";
import {
  AI_PROVIDERS,
  OPENAI_DEFAULT_API_URL,
  providerByKey,
  type AiProvider,
  type AiProviderKey,
} from "@/lib/ai/providers";
import type { AiProviderStatus } from "@/lib/ai/queries";
import { attempt } from "@/lib/ai/result";

/**
 * The provider card: which provider the AI features run on, and its
 * credentials.
 *
 * `/integrations` renders one card per provider because YouTube and Reddit are
 * independent -- both can be on at once. Exactly one AI provider can be, so this
 * is a single card with a picker at the top and the selected provider's fields
 * below it. Everything under the picker is the same shape phase 6 shipped:
 * `type="password"`, the server's `mask()` as a *placeholder*, an empty field
 * meaning "keep what is stored", and Save beside Test.
 *
 * ## Choosing a provider does not write anything; **Save** does
 *
 * The picker is local state until Save is pressed, and that is a deliberate
 * departure from `@/components/settings/general-section`, which persists a theme
 * the moment it is chosen. Two reasons, both discovered by writing the
 * save-on-change version first:
 *
 * 1. **`setActiveProvider()` refuses a provider that has not passed a probe**
 *    (`activeNotVerified`), so on a fresh installation *every* first pick would
 *    answer with an error toast -- for the entirely reasonable act of opening
 *    the dropdown to configure something.
 * 2. Worse, it left a dead end. After that refusal the operator enters a key and
 *    saves; the flag flips true, but the picker's value is already `"openai"`,
 *    so re-picking it fires no `onValueChange` and the provider can never be
 *    activated without a reload.
 *
 * So **Save does both**: it verifies and stores the credentials, and on success
 * makes this provider the active one. That is what choosing it in a picker
 * labelled "AI provider" means, and it collapses the two-step flow into one
 * press. Picking "None (disabled)" and saving writes `""` and switches the AI
 * features off -- there are no credentials to verify on that path, so Save calls
 * only `setActiveProvider("")` and says so on the button.
 *
 * Nothing is hidden while the two disagree: {@link hintKey} states, under the
 * picker, whether the choice on screen is the one the server is acting on.
 *
 * ## Two selects, and the `<Select>` trap applies to both
 *
 * Base UI resolves the collapsed trigger's label from the root's `items` prop
 * alone and never reads `<SelectItem>`'s text (CLAUDE.md), so each list is built
 * once and feeds both. Getting this wrong prints `gemini-3.5-flash-lite` on the
 * trigger while the open popup looks perfect.
 *
 * **`""` is a real value here, not "nothing selected", and that needs one piece
 * of care.** Base UI's `hasSelectedValue` is `stringifyAsValue(value) !== ""`,
 * so an empty string reads as *unselected* -- which only matters because
 * `<Select.Value>` prefers its own `placeholder` prop over resolving a label
 * when nothing is selected. This one passes no `placeholder`, so the resolver
 * runs, finds the `{ value: "", label: … }` entry in `items` and prints "None
 * (disabled)". Adding a `placeholder` to that `<SelectValue>` would silently
 * replace the None label with it.
 *
 * Every action goes through `attempt()` -- never a bare `await` (CLAUDE.md).
 */

/** What the picker holds: a provider, or `""` for "AI features off". */
type Selection = AiProviderKey | "";

export function ProviderSection({
  active,
  providers,
}: {
  active: Selection;
  providers: Record<AiProviderKey, AiProviderStatus>;
}) {
  const t = useTranslations("ai");
  const report = useReportOutcome();
  const [selected, setSelected] = useState<Selection>(active);
  // Never seeded from the server: the stored key is not in this component's
  // props at all, only its mask, which is the placeholder.
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(() => (active === "" ? "" : providers[active].model));
  const [apiUrl, setApiUrl] = useState(() => (active === "" ? "" : providers[active].apiUrl));
  // Two transitions rather than one flag: both buttons are disabled while either
  // call is in flight, but only the one that was pressed may say so.
  const [saving, startSave] = useTransition();
  const [testing, startTest] = useTransition();
  const busy = saving || testing;

  const provider = selected === "" ? null : (providerByKey(selected) ?? null);
  const status = provider ? providers[provider.key] : null;
  /** Is there a stored key to keep, or to remove? */
  const configured = status !== null && status.apiKeyMasked !== "";

  const providerItems: { value: Selection; label: string }[] = [
    { value: "", label: t("provider.none") },
    // `label` is the provider's own brand name -- the accepted untranslated
    // literal, like "Yana".
    ...AI_PROVIDERS.map((entry) => ({ value: entry.key as Selection, label: entry.label })),
  ];
  const modelItems = provider ? provider.models.map(({ value, label }) => ({ value, label })) : [];

  /**
   * The line under the picker: what the server is acting on, against what is on
   * screen.
   *
   * Four states rather than two, because "chosen" and "in force" are different
   * facts and an operator who has changed the picker but not pressed Save has to
   * be told so -- otherwise the page reads as if the AI features had already
   * moved.
   */
  const hintKey =
    selected === ""
      ? active === ""
        ? "provider.offHint"
        : "provider.pendingOff"
      : active === selected
        ? "provider.activeHint"
        : "provider.pendingActive";

  /**
   * Switching provider clears every field, including the key.
   *
   * Not tidiness: the API key belongs to the provider that was selected when it
   * was typed, and carrying it across would submit an OpenAI key to Anthropic on
   * the next Save. The model and base URL are re-seeded from the newly selected
   * provider's stored row for the same reason.
   */
  function choose(next: Selection) {
    setSelected(next);
    setApiKey("");
    setModel(next === "" ? "" : providers[next].model);
    setApiUrl(next === "" ? "" : providers[next].apiUrl);
  }

  /**
   * What Save and Test both send, so what Test validates is exactly what a Save
   * would store.
   *
   * `apiUrl` only where the provider declares one: Anthropic's and Gemini's
   * schemas do not have the field, and their endpoints are not an operator
   * setting.
   */
  function submission(entry: AiProvider) {
    return entry.hasCustomUrl
      ? { apiKey: submittedSecret(apiKey), model, apiUrl }
      : { apiKey: submittedSecret(apiKey), model };
  }

  function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startSave(async () => {
      if (!provider) {
        // "None (disabled)": nothing to verify, so the only write is the
        // preference. Reported as a save, because that is the button pressed.
        report(await attempt(() => setActiveProvider("")), "saved");
        return;
      }

      const saved = await attempt(() => saveProvider(provider.key, submission(provider)));
      if (!saved.ok) {
        report(saved, "saved");
        return;
      }

      // The credentials are stored and the probe passed, so the flag is on and
      // this cannot answer `activeNotVerified`. Skipped when the server already
      // names this provider, so re-saving a key does not write the column and
      // revalidate the route for nothing.
      if (active !== provider.key) {
        const activated = await attempt(() => setActiveProvider(provider.key));
        if (!activated.ok) {
          // Exactly one toast per press, and this is the honest headline: the
          // key was stored (the badge will say so) but the provider the operator
          // picked is not the one in force.
          report(activated, "saved");
          return;
        }
      }

      report(saved, "saved");
      // Cleared only on success, so the placeholder the save just refreshed is
      // what the field shows, and a retry after a rejection still has the typed
      // key in it to correct.
      setApiKey("");
    });
  }

  function test() {
    if (!provider) return;
    startTest(async () => {
      report(await attempt(() => testProvider(provider.key, submission(provider))), "tested");
    });
  }

  /** `true` only on success -- anything else keeps the dialog open. */
  async function remove(): Promise<boolean> {
    if (!provider) return false;
    const result = await attempt(() => removeProvider(provider.key));
    report(result, "removed");
    if (result.ok) setApiKey("");
    return result.ok;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("provider.title")}</CardTitle>
        <CardDescription>{t("provider.description")}</CardDescription>
        {status ? (
          <CardAction>
            <StatusBadge enabled={status.enabled} />
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent>
        <form onSubmit={save} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="ai-provider">{t("provider.label")}</Label>
            <Select
              items={providerItems}
              value={selected}
              disabled={busy}
              onValueChange={(value) => {
                // Base UI reports `null` for a clearable selection, which this
                // one never is. `""` is a listed item, not an absence.
                if (value === null) return;
                choose(value);
              }}
            >
              <SelectTrigger id="ai-provider" className="w-full sm:w-64">
                {/* No `placeholder` prop: see the header -- it would win over
                    the resolved label for the `""` item. */}
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {providerItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">{t(hintKey)}</p>
          </div>

          {provider ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="ai-model">{t("provider.model")}</Label>
                <Select
                  items={modelItems}
                  value={model}
                  disabled={busy}
                  onValueChange={(value) => {
                    if (value === null) return;
                    setModel(value);
                  }}
                >
                  <SelectTrigger id="ai-model" className="w-full sm:w-64">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {modelItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="ai-api-key">{t("provider.apiKey")}</Label>
                {/* type="password" and autoComplete="off": a credential is not a
                    login, so no password manager should offer to fill or store
                    it, and it must not be readable over the operator's
                    shoulder. */}
                <Input
                  id="ai-api-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={secretPlaceholder(status?.apiKeyMasked ?? "")}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <p className="text-sm text-muted-foreground">
                  {configured ? t("keepHint") : t("notConfigured")}
                </p>
              </div>

              {provider.hasCustomUrl ? (
                <div className="grid gap-2">
                  <Label htmlFor="ai-api-url">{t("provider.apiUrl")}</Label>
                  {/* Plaintext and shown in full: an operator setting rather
                      than a credential, and the one field they most often have
                      to correct. The placeholder is the value an empty field
                      resolves to on the server. */}
                  <Input
                    id="ai-api-url"
                    type="url"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={OPENAI_DEFAULT_API_URL}
                    value={apiUrl}
                    onChange={(event) => setApiUrl(event.target.value)}
                  />
                  <p className="text-sm text-muted-foreground">{t("provider.apiUrlHelp")}</p>
                </div>
              ) : null}
            </>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {provider
                ? saving
                  ? t("saving")
                  : t("save")
                : saving
                  ? t("provider.turningOff")
                  : t("provider.turnOff")}
            </Button>
            {provider ? (
              <Button type="button" variant="outline" disabled={busy} onClick={test}>
                {testing ? t("testing") : t("test")}
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
      {/* Outside the form, so the trigger cannot submit it, and visually apart
          from Save: this is the one control here that destroys something. It is
          offered only when there is something to destroy. */}
      {configured ? (
        <CardFooter className="justify-end">
          <ConfirmDestructive
            trigger={
              <Button type="button" variant="destructive" disabled={busy}>
                {t("remove")}
              </Button>
            }
            title={t("provider.removeTitle")}
            description={t("provider.removeDescription")}
            confirmLabel={t("removeConfirm")}
            onConfirm={remove}
          />
        </CardFooter>
      ) : null}
    </Card>
  );
}
