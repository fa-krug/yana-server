"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

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
import {
  listOpenrouterModels,
  removeProvider,
  saveProvider,
  setActiveProvider,
  testProvider,
} from "@/lib/ai/actions";
import {
  AI_PROVIDERS,
  OPENAI_DEFAULT_API_URL,
  providerByKey,
  type AiProvider,
  type AiProviderKey,
} from "@/lib/ai/providers";
import type { AiProviderStatus } from "@/lib/ai/queries";
import { attempt } from "@/lib/ai/result";
import { attemptCall } from "@/lib/attempt";

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
  // The live OpenRouter catalog, once fetched -- `null` until "Refresh models"
  // is pressed, so `modelItems` below falls back to the static two-entry list
  // (`provider.models`) until then. A third transition rather than folding
  // into `busy`: Save and Test disable each other, but a refresh in flight
  // has no reason to block either of them, only the model select and its own
  // button.
  const [fetchedModels, setFetchedModels] = useState<{ value: string; label: string }[] | null>(
    null,
  );
  const [refreshingModels, startRefreshModels] = useTransition();

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
  // The fetched catalog wins over the static fallback, but only for the
  // provider that declares one -- `fetchedModels` is reset to `null` on every
  // provider switch (see `choose()`), so this can never show OpenRouter's live
  // list under a different provider's picker value.
  const modelItems = provider
    ? (provider.hasDynamicModels && fetchedModels ? fetchedModels : provider.models).map(
        ({ value, label }) => ({ value, label }),
      )
    : [];

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
    // So switching away from OpenRouter and back doesn't show a stale fetch
    // from a previous selection on screen -- it re-shows the static fallback
    // until refreshed again.
    setFetchedModels(null);
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
        /**
         * "None (disabled)": nothing to verify, so the only write is the
         * preference.
         *
         * **Deliberately not routed through {@link report}.** That reporter's
         * vocabulary is credentials -- its success is "Credentials verified and
         * saved." and its keyless failure "Could not save these credentials." --
         * and this path verified nothing and saved no credential, for a press of
         * a button labelled "Switch AI off". Reporting an outcome about a
         * different subject is the exact defect the reporter's own per-action
         * fallbacks exist to prevent (`@/components/section-kit`); the button
         * pressed is not the same question as what the message is about.
         */
        const result = await attempt(() => setActiveProvider(""));
        if (result.ok) {
          toast.success(t("provider.turnedOff"));
        } else {
          // The namespace's own `saveFailed` -- "Could not save these settings."
          // -- because a preference is what this path writes.
          toast.error(t(result.errorKey ?? "saveFailed"));
        }
        return;
      }

      const saved = await attempt(() => saveProvider(provider.key, submission(provider)));
      if (!saved.ok) {
        // Not cleared: a typo is corrected, not retyped.
        report(saved, "saved");
        return;
      }

      // Cleared as soon as the *save* succeeds, which is the event the rule is
      // about: the stored key has been replaced and the placeholder the save
      // just refreshed is what the field should show. Doing it after the
      // activation below instead left a stored key sitting in the input on the
      // one branch that fails there, to be re-submitted by the next Save.
      setApiKey("");

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
          //
          // **The `"saved"` fallback is credential-worded, and that is latent
          // rather than wrong.** `useReportOutcome`'s `saveFailed` is
          // `credentialsSaveFailed` ("Could not save these credentials"), which
          // is not what failed here -- the credentials saved. It is unreachable
          // today: every way `setActiveProvider()` can fail returns a specific
          // `errorKey`, and the fallback only shows when a result carries none.
          // Left as-is on purpose, so a reviewer does not re-derive it as a
          // defect: the fix is a third fallback key on the binding, which is
          // worth adding the first time this action can fail keylessly, not
          // before.
          report(activated, "saved");
          return;
        }
      }

      report(saved, "saved");
    });
  }

  function test() {
    if (!provider) return;
    startTest(async () => {
      report(await attempt(() => testProvider(provider.key, submission(provider))), "tested");
    });
  }

  /**
   * The live OpenRouter catalog, on demand. Not routed through the `ai`
   * namespace's `attempt()`/`report()`: it takes no credential and writes
   * nothing, so the credential-worded reporter vocabulary does not apply -- a
   * plain toast on failure is the whole contract, and `listOpenrouterModels()`
   * already collapses every failure to one catalog key (see its doc comment in
   * `@/lib/ai/actions`).
   *
   * **It still goes through `attemptCall()`, never a bare `await` (CLAUDE.md).**
   * `listOpenrouterModels()` itself never rejects -- it collapses every
   * failure to `{ ok: false, errorKey }` -- but the network layer between this
   * click and the server action can still reject on its own (a dropped
   * connection, the container restarting, an over-sized response), and an
   * unhandled rejection inside this `useTransition` scope would escalate to
   * the nearest error boundary and replace the whole `/ai` page -- including
   * any half-typed credentials -- with "Something went wrong." `attemptCall()`
   * is the namespace-free layer the CRUD kit's own backstops
   * (`confirm-destructive.tsx`, `bulk-action-bar.tsx`) use for exactly this
   * reason; on a `"rejected"` status it has already logged the failure and, if
   * the session turned out to be the cause, navigated to `/login` itself, so
   * this only needs one toast to cover the plain "the request never came back"
   * case.
   */
  function refreshModels() {
    if (!provider?.hasDynamicModels) return;
    startRefreshModels(async () => {
      const attempted = await attemptCall(listOpenrouterModels, {
        label: "Fetching the OpenRouter model catalog rejected instead of reporting",
      });
      if (attempted.status !== "returned") {
        toast.error(t("openrouter.modelsFetchFailed"));
        return;
      }
      if (attempted.result.ok) {
        setFetchedModels(attempted.result.models);
      } else {
        toast.error(t(attempted.result.errorKey));
      }
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
    <ProviderSectionShell
      statusBadge={status ? <StatusBadge enabled={status.enabled} /> : null}
      providerControl={
        <Select
          items={providerItems}
          value={selected}
          // `refreshingModels` too, not just `busy`: `choose()` resets
          // `fetchedModels` to `null` synchronously, but it cannot cancel an
          // in-flight `refreshModels()` transition. Left enabled, a
          // switch-away-and-back before that fetch resolves would let its
          // `setFetchedModels(result.models)` land after the reset and
          // silently repopulate the catalog with a stale request's answer --
          // defeating the very reset this picker's own `choose()` performs.
          disabled={busy || refreshingModels}
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
      }
      providerHint={t(hintKey)}
      modelControl={
        provider ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select
              items={modelItems}
              value={model}
              disabled={busy || refreshingModels}
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
            {/* Only the provider with a live catalog gets this -- every other
                provider's `models` is the whole list there is. */}
            {provider.hasDynamicModels ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy || refreshingModels}
                onClick={refreshModels}
              >
                {refreshingModels ? t("provider.refreshingModels") : t("provider.refreshModels")}
              </Button>
            ) : null}
          </div>
        ) : null
      }
      apiKeyControl={
        provider ? (
          // type="password" and autoComplete="off": a credential is not a
          // login, so no password manager should offer to fill or store it,
          // and it must not be readable over the operator's shoulder.
          <Input
            id="ai-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={secretPlaceholder(status?.apiKeyMasked ?? "")}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        ) : null
      }
      apiKeyHelp={provider ? (configured ? t("keepHint") : t("notConfigured")) : null}
      apiUrlControl={
        provider?.hasCustomUrl ? (
          // Plaintext and shown in full: an operator setting rather than a
          // credential, and the one field they most often have to correct.
          // The placeholder is the value an empty field resolves to on the
          // server.
          <Input
            id="ai-api-url"
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={OPENAI_DEFAULT_API_URL}
            value={apiUrl}
            onChange={(event) => setApiUrl(event.target.value)}
          />
        ) : null
      }
      saveControl={
        <Button type="submit" disabled={busy} className="w-full sm:w-auto">
          {provider
            ? saving
              ? t("saving")
              : t("save")
            : saving
              ? t("provider.turningOff")
              : t("provider.turnOff")}
        </Button>
      }
      testControl={
        provider ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={test}
            className="w-full sm:w-auto"
          >
            {testing ? t("testing") : t("test")}
          </Button>
        ) : null
      }
      removeControl={
        // The one control here that destroys something -- offered only when
        // there is something to destroy.
        configured ? (
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
        ) : null
      }
      onSubmit={save}
    />
  );
}

/**
 * The card's chrome alone: the heading, the picker's own label and hint, and
 * every conditionally-present field's structural wrapper -- with no
 * dependency on `active`/`providers`, so `src/app/(app)/ai/page.tsx` can
 * render this directly as its own `<Suspense>` fallback (with a skeleton bar
 * standing in for each slot) instead of an anonymous skeleton block. See the
 * doc comment on `GeneralSectionShell` in `../settings/general-section.tsx`
 * for why this split exists.
 *
 * **Presence, not just content, is a slot's job here.** Unlike
 * `GeneralSectionShell`, where both controls are always shown, whether the
 * model/API-key/API-url fields and the remove footer render *at all* depends
 * on which provider is selected and what is stored for it -- data this shell
 * never sees. So each of those slots is `null` when `<ProviderSection>`
 * decides nothing belongs there, and this shell's only job is to wrap a
 * non-null slot in its label/structure and render nothing for a null one;
 * it never inspects `active`/`providers` itself to make that call.
 *
 * The `<form>` lives here, wrapping the picker, the conditional fields and the
 * action buttons exactly as it did inside `<ProviderSection>`'s own
 * `CardContent` -- `onSubmit` is just a callback the shell forwards, unaware
 * of what it does.
 */
export function ProviderSectionShell({
  statusBadge,
  providerControl,
  providerHint,
  modelControl,
  apiKeyControl,
  apiKeyHelp,
  apiUrlControl,
  saveControl,
  testControl,
  removeControl,
  // Optional, and defaulted here rather than by the caller: `ai/page.tsx`'s
  // Suspense fallback and `ai/loading.tsx` both render this shell from a
  // Server Component, which cannot pass a function prop into a Client
  // Component (it isn't a Server Action, so React has nothing to serialize it
  // as). Defaulting inside this "use client" module keeps the function
  // entirely on the client, so neither fallback needs an `onSubmit` at all --
  // the same fix `YoutubeSectionShell` already carries.
  onSubmit = (event) => event.preventDefault(),
}: {
  statusBadge: ReactNode;
  providerControl: ReactNode;
  providerHint: ReactNode;
  modelControl: ReactNode;
  apiKeyControl: ReactNode;
  apiKeyHelp: ReactNode;
  apiUrlControl: ReactNode;
  saveControl: ReactNode;
  testControl: ReactNode;
  removeControl: ReactNode;
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
}) {
  const t = useTranslations("ai");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("provider.title")}</CardTitle>
        <CardDescription>{t("provider.description")}</CardDescription>
        {statusBadge ? <CardAction>{statusBadge}</CardAction> : null}
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="ai-provider">{t("provider.label")}</Label>
            {providerControl}
            <div className="text-sm text-muted-foreground">{providerHint}</div>
          </div>

          {modelControl ? (
            <div className="grid gap-2">
              <Label htmlFor="ai-model">{t("provider.model")}</Label>
              {modelControl}
            </div>
          ) : null}

          {apiKeyControl ? (
            <div className="grid gap-2">
              <Label htmlFor="ai-api-key">{t("provider.apiKey")}</Label>
              {apiKeyControl}
              <div className="text-sm text-muted-foreground">{apiKeyHelp}</div>
            </div>
          ) : null}

          {apiUrlControl ? (
            <div className="grid gap-2">
              <Label htmlFor="ai-api-url">{t("provider.apiUrl")}</Label>
              {apiUrlControl}
              <p className="text-sm text-muted-foreground">{t("provider.apiUrlHelp")}</p>
            </div>
          ) : null}

          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {saveControl}
            {testControl}
          </div>
        </form>
      </CardContent>
      {/* Outside the form, so the trigger cannot submit it, and visually apart
          from Save. */}
      {removeControl}
    </Card>
  );
}
