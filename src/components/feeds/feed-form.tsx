"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, use, useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { createFeed, updateFeed, updateFeedsBulk } from "@/lib/feeds/actions";
import { attempt } from "@/lib/feeds/result";
import { useTrackRun } from "@/components/jobs/active-runs-context";
import {
  AGGREGATOR_SPECS,
  defaultIdentifierFor,
  identifierModeFor,
  MAX_CUSTOM_PROMPT_LENGTH,
  visibleOptionsFor,
  type Capabilities,
  type OptionSpec,
} from "@/lib/aggregators/specs";
import type { Feed, Tag } from "@/lib/db/schema";
import { AlertCircle } from "lucide-react";
import { TagBadge } from "@/components/tags/tag-badge";
import { TagColorDot } from "@/components/tags/tag-color-dot";
import { IdentifierAutocomplete } from "./identifier-autocomplete";

export type FeedListRow = Feed & { tags: Tag[] };

/** No capability is known before the promise resolves -- see `pending` below. */
const EMPTY_CAPABILITIES: Capabilities = { youtube: false, reddit: false, ai: false };

/**
 * `capabilities`/`allTags` are optional and paired with `pending`, the same
 * "not loaded yet" shape as `@/components/settings/library-section.tsx` and
 * `@/components/ai/provider-section.tsx`: the real form renders disabled with
 * no value rather than a `<Skeleton>` standing in for each control. The
 * aggregator picker's own option list (`AGGREGATOR_SPECS`) needs no query, so
 * it renders fully populated while pending -- only the capability-based
 * filtering (which providers are configured) and the tag list are unknown.
 * See `NewFeedForm` below for the promise-consuming wrapper `/feeds/new` uses.
 */
export function FeedForm({
  feed,
  capabilities,
  allTags,
  pending = false,
}: {
  feed?: FeedListRow;
  capabilities?: Capabilities;
  allTags?: Tag[];
  pending?: boolean;
}) {
  const t = useTranslations("feeds");
  const c = useTranslations("common");
  const router = useRouter();
  const trackRun = useTrackRun();

  // `caps`/`tags` are what the rest of this component reads -- never the raw
  // `capabilities`/`allTags` props, so every derived value (the picker's
  // filtering, the missing-integration banners, the tag select) has a value to
  // work with while pending, rather than needing its own `?? …` at each site.
  const caps = capabilities ?? EMPTY_CAPABILITIES;
  const tags = allTags ?? [];

  const [saving, start] = useTransition();
  const [updating, startUpdate] = useTransition();
  // Disables every control: either this form's own submit is in flight, or
  // the data it needs (capabilities, tags) hasn't arrived yet.
  const busy = pending || saving;

  function runUpdate() {
    if (!feed) return;

    startUpdate(async () => {
      // Never a bare `await` of a server action from a client component (see
      // `@/lib/attempt`): an action that fails without returning -- a dropped
      // connection, the container restarting mid-request -- rejects inside this
      // transition scope and escalates to the (app) group's error boundary,
      // replacing the whole form with "Something went wrong".
      const result = await attempt(() => updateFeedsBulk([feed.id]));
      if (!result.ok) {
        toast.error(t("saveFailed"));
        return;
      }

      // The count comes from the run, never from the one id submitted: the feed
      // may have been deleted by another session between the click and the
      // enqueue, in which case nothing ran and "1 updated" would be a lie.
      trackRun(result.runId, {
        completed: (n) => t("aggregationCompleted", { count: n }),
        partial: (ok, failed) => t("aggregationCompletedWithFailures", { completed: ok, failed }),
        fallback: t("saveFailed"),
      });
    });
  }

  const [aggregator, setAggregator] = useState<keyof typeof AGGREGATOR_SPECS>(
    (feed?.aggregator as keyof typeof AGGREGATOR_SPECS) || "full_website",
  );
  const [name, setName] = useState(feed?.name ?? "");
  const [identifier, setIdentifier] = useState(feed?.identifier ?? "");
  const [tagIds, setTagIds] = useState<string[]>(feed?.tags.map((t) => String(t.id)) ?? []);
  const [enabled, setEnabled] = useState(feed?.enabled ?? true);

  const [options, setOptions] = useState<Record<string, unknown>>(feed?.options ?? {});
  const [updateIntervalMinutes, setUpdateIntervalMinutes] = useState(
    String(feed?.updateIntervalMinutes ?? AGGREGATOR_SPECS[aggregator].recommendedIntervalMinutes),
  );
  const [concurrency, setConcurrency] = useState(
    String(feed?.concurrency ?? AGGREGATOR_SPECS[aggregator].recommendedConcurrency),
  );
  const [maxArticleAgeDays, setMaxArticleAgeDays] = useState(String(feed?.maxArticleAgeDays ?? 30));

  const spec = AGGREGATOR_SPECS[aggregator];
  const visibleOptions = visibleOptionsFor(aggregator, caps);
  /**
   * `visibleOptions` minus the ones whose `dependsOn` box is unchecked. That is
   * a display rule and nothing more: the value stays in `options` and is still
   * submitted, so unchecking and re-checking gives the prompt back rather than
   * silently discarding what was typed.
   */
  const shownOptions = visibleOptions.filter((opt) => !opt.dependsOn || options[opt.dependsOn]);
  const identifierMode = identifierModeFor(spec);

  /**
   * While `pending`, `caps` is `EMPTY_CAPABILITIES`, so a capability-gated
   * aggregator (YouTube, Reddit) is filtered out of this list until the real
   * capabilities resolve -- the picker does **not** render the full,
   * unfiltered `AGGREGATOR_SPECS` while pending, even though the picker's
   * `<Select>` below is disabled the whole time.
   *
   * That is deliberate, not an oversight the brief's "fully populated, like
   * `/ai`'s provider picker" comparison would suggest fixing: the shorter
   * list is invisible in practice, because a disabled `<Select>` cannot be
   * opened to notice it. What is not invisible is which *direction* the list
   * changes the moment capabilities resolve. Of the two orderings, an option
   * appearing is harmless -- but an option *disappearing* could be the one
   * already selected, which would silently reset the operator's choice.
   * `/ai`'s provider picker has no equivalent hazard (its list is static and
   * never shrinks), so that comparison does not actually hold here. Hiding
   * capability-gated aggregators while pending and letting them appear once
   * capabilities resolve is therefore the strictly safer of the two
   * orderings, chosen over matching `/ai`'s pending shape exactly.
   */
  const availableAggregators = Object.values(AGGREGATOR_SPECS).filter(
    (s) => !s.identifierSearch || caps[s.identifierSearch] || s.key === feed?.aggregator,
  );
  const identifierSearchUnavailable =
    identifierMode === "search" && spec.identifierSearch && !caps[spec.identifierSearch];

  // Check what's hidden
  const missingGuards = new Set<string>();
  spec.options.forEach((opt) => {
    if (opt.requires && !caps[opt.requires]) {
      missingGuards.add(opt.requires);
    }
  });

  function handleAggregatorChange(newAggregator: string | null) {
    if (!newAggregator) return;
    const key = newAggregator as keyof typeof AGGREGATOR_SPECS;
    setAggregator(key);
    // Reset options to default for new aggregator
    const newSpec = AGGREGATOR_SPECS[key];
    const newOptions: Record<string, unknown> = {};
    if (newSpec) {
      for (const opt of newSpec.options) {
        newOptions[opt.key] = opt.default;
      }
      setIdentifier(defaultIdentifierFor(newSpec));
      setUpdateIntervalMinutes(String(newSpec.recommendedIntervalMinutes));
      setConcurrency(String(newSpec.recommendedConcurrency));
    }
    setOptions(newOptions);
  }

  function handleOptionChange(key: string, value: unknown) {
    setOptions((prev) => ({ ...prev, [key]: value }));
  }

  /**
   * The open prompt editor: which option it is editing and the draft text,
   * which only reaches `options` when Save is pressed -- closing or cancelling
   * leaves the stored prompt as it was.
   */
  const [promptEditor, setPromptEditor] = useState<{ key: string; draft: string } | null>(null);

  function openPromptEditor(opt: OptionSpec) {
    setPromptEditor({ key: opt.key, draft: (options[opt.key] as string) ?? "" });
  }

  function savePromptEditor() {
    if (!promptEditor) return;
    handleOptionChange(promptEditor.key, promptEditor.draft);
    setPromptEditor(null);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    start(async () => {
      const payload = {
        name,
        aggregator,
        identifier,
        tagIds: tagIds.map(Number),
        options,
        enabled,
        updateIntervalMinutes: Number(updateIntervalMinutes),
        concurrency: Number(concurrency),
        maxArticleAgeDays: Number(maxArticleAgeDays),
      };

      if (feed) {
        const result = await updateFeed(feed.id, payload);
        if (!result.ok) {
          toast.error(result.error || t("saveFailed"));
          return;
        }
        toast.success(t("form.saved"));
        router.push("/feeds");
        router.refresh();
        return;
      }

      const result = await createFeed(payload);
      if (!result.ok) {
        toast.error(result.error || t("saveFailed"));
        return;
      }
      toast.success(t("form.created"));
      router.push("/feeds");
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-6">
      <div className="grid gap-2">
        <Label htmlFor="aggregator">{t("form.aggregator")}</Label>
        <Select
          value={aggregator}
          onValueChange={handleAggregatorChange}
          items={availableAggregators.map((s) => ({ value: s.key, label: s.label }))}
          disabled={busy}
        >
          <SelectTrigger id="aggregator">
            <SelectValue placeholder={t("form.aggregatorPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {availableAggregators.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="name">{t("form.name")}</Label>
        <Input
          id="name"
          required
          autoComplete="off"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={busy}
        />
      </div>

      {identifierMode === "url" && (
        <div className="grid gap-2">
          <Label htmlFor="identifier">
            {spec.identifierLabel}
            {!spec.identifierRequired && " (Optional)"}
          </Label>
          <Input
            id="identifier"
            required={spec.identifierRequired}
            autoComplete="off"
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            disabled={busy}
          />
          {spec.identifierHelp && (
            <p className="text-sm text-muted-foreground">{spec.identifierHelp}</p>
          )}
        </div>
      )}

      {identifierMode === "choice" && (
        <div className="grid gap-2">
          <Label htmlFor="identifier">{spec.identifierLabel} (Optional)</Label>
          <Select
            value={identifier || defaultIdentifierFor(spec)}
            onValueChange={(val: string | null) => val && setIdentifier(val)}
            items={spec.identifierChoices}
            disabled={busy}
          >
            <SelectTrigger id="identifier">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {spec.identifierChoices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {spec.identifierHelp && (
            <p className="text-sm text-muted-foreground">{spec.identifierHelp}</p>
          )}
        </div>
      )}

      {identifierMode === "search" && (
        <div className="grid gap-2">
          <Label htmlFor="identifier">{spec.identifierLabel}</Label>
          <IdentifierAutocomplete
            // The autocomplete seeds its visible text from `value` once, on
            // mount, and never resyncs -- which is what keeps a picked
            // result's friendly label on screen instead of the raw id. The
            // cost is that switching aggregators left the previous one's typed
            // text visible even though `identifier` had been reset. Remounting
            // on the key is the reset, rather than a `value` effect that would
            // fight the label.
            key={aggregator}
            id="identifier"
            required={spec.identifierRequired}
            aggregator={spec.identifierSearch as "youtube" | "reddit"}
            value={identifier}
            onValueChange={setIdentifier}
            disabled={busy || identifierSearchUnavailable}
          />
          {spec.identifierHelp && (
            <p className="text-sm text-muted-foreground">{spec.identifierHelp}</p>
          )}
          {identifierSearchUnavailable && (
            <div className="flex items-start gap-2 text-sm text-muted-foreground bg-secondary/50 p-3 rounded-md border border-border">
              <AlertCircle className="size-4 mt-0.5 shrink-0" />
              <span>
                {t("identifierSearch.unavailableBannerBefore")}{" "}
                <Link href="/integrations" className="underline hover:text-primary">
                  {t("identifierSearch.unavailableBannerLink")}
                </Link>
                {t("identifierSearch.unavailableBannerAfter")}
              </span>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-2">
        <Label htmlFor="tags">{t("form.tags")}</Label>
        <Select
          multiple
          value={tagIds}
          onValueChange={(val: string[]) => setTagIds(val)}
          items={tags.map((tag) => ({ value: String(tag.id), label: tag.name }))}
          disabled={busy}
        >
          <SelectTrigger id="tags">
            <SelectValue placeholder={t("form.tagsPlaceholder")}>
              {tagIds.length === 0 ? (
                <span className="text-muted-foreground">{t("form.tagsPlaceholder")}</span>
              ) : (
                <div className="flex gap-1 flex-wrap">
                  {tagIds.map((id) => {
                    const tag = tags.find((t) => String(t.id) === id);
                    return tag ? (
                      <TagBadge
                        key={id}
                        name={tag.name}
                        color={tag.color}
                        className="text-[10px] px-1.5 h-4"
                      />
                    ) : null;
                  })}
                </div>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {tags.map((tag) => (
              <SelectItem key={tag.id} value={String(tag.id)}>
                <span className="flex items-center gap-2">
                  <TagColorDot color={tag.color} />
                  {tag.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {feed && (
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="enabled" className="text-base">
              {t("form.enabled")}
            </Label>
            <p className="text-sm text-muted-foreground">{t("form.enabledDescription")}</p>
          </div>
          <Switch id="enabled" checked={enabled} onCheckedChange={setEnabled} disabled={busy} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="grid gap-2">
          <Label htmlFor="updateIntervalMinutes">{t("form.updateInterval")}</Label>
          <Input
            id="updateIntervalMinutes"
            type="number"
            min={0}
            max={1440}
            value={updateIntervalMinutes}
            onChange={(event) => setUpdateIntervalMinutes(event.target.value)}
            disabled={busy}
          />
          <p className="text-sm text-muted-foreground">{t("form.updateIntervalHelp")}</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="concurrency">{t("form.concurrency")}</Label>
          <Input
            id="concurrency"
            type="number"
            min={1}
            max={10}
            value={concurrency}
            onChange={(event) => setConcurrency(event.target.value)}
            disabled={busy}
          />
          <p className="text-sm text-muted-foreground">{t("form.concurrencyHelp")}</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="maxArticleAgeDays">{t("form.maxArticleAge")}</Label>
          <Input
            id="maxArticleAgeDays"
            type="number"
            min={0}
            max={3650}
            value={maxArticleAgeDays}
            onChange={(event) => setMaxArticleAgeDays(event.target.value)}
            disabled={busy}
          />
          <p className="text-sm text-muted-foreground">{t("form.maxArticleAgeHelp")}</p>
        </div>
      </div>

      {visibleOptions.length > 0 && (
        <div className="space-y-4 rounded-lg border p-4 bg-muted/20">
          <h3 className="font-medium text-lg">{t("form.options")}</h3>

          {shownOptions.map((opt) => (
            <div key={opt.key} className="grid gap-2">
              {opt.kind === "prompt" ? (
                <div className="grid gap-1.5">
                  <button
                    type="button"
                    aria-label={t("form.customPromptEdit")}
                    onClick={() => openPromptEditor(opt)}
                    disabled={busy}
                    className={cn(
                      "w-full rounded-md border bg-background p-3 text-left text-sm",
                      "hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2",
                      "focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  >
                    {(options[opt.key] as string)?.trim() ? (
                      <span className="line-clamp-3 whitespace-pre-wrap">
                        {options[opt.key] as string}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{t("form.customPromptEmpty")}</span>
                    )}
                  </button>
                  {opt.help && <p className="text-xs text-muted-foreground">{opt.help}</p>}
                </div>
              ) : opt.kind === "boolean" ? (
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id={`opt-${opt.key}`}
                    checked={options[opt.key] as boolean}
                    onCheckedChange={(checked) => handleOptionChange(opt.key, checked)}
                    disabled={busy}
                  />
                  <Label htmlFor={`opt-${opt.key}`} className="font-normal cursor-pointer">
                    {opt.label}
                  </Label>
                </div>
              ) : opt.kind === "select" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor={`opt-${opt.key}`}>{opt.label}</Label>
                  <Select
                    value={options[opt.key] as string}
                    onValueChange={(val) => handleOptionChange(opt.key, val)}
                    items={opt.options || []}
                    disabled={busy}
                  >
                    <SelectTrigger id={`opt-${opt.key}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {opt.options?.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : opt.kind === "selectorList" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor={`opt-${opt.key}`}>{opt.label}</Label>
                  <Textarea
                    id={`opt-${opt.key}`}
                    value={
                      Array.isArray(options[opt.key])
                        ? (options[opt.key] as string[]).join("\n")
                        : (options[opt.key] as string) || ""
                    }
                    onChange={(e) => {
                      const val = e.target.value.split("\n");
                      handleOptionChange(opt.key, val);
                    }}
                    disabled={busy}
                    rows={4}
                  />
                  {opt.help && <p className="text-xs text-muted-foreground">{opt.help}</p>}
                </div>
              ) : opt.kind === "number" ? (
                <div className="grid gap-1.5">
                  <Label htmlFor={`opt-${opt.key}`}>{opt.label}</Label>
                  <Input
                    id={`opt-${opt.key}`}
                    type="number"
                    value={(options[opt.key] as number | string) ?? ""}
                    onChange={(e) => handleOptionChange(opt.key, Number(e.target.value))}
                    disabled={busy}
                  />
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <Label htmlFor={`opt-${opt.key}`}>{opt.label}</Label>
                  <Input
                    id={`opt-${opt.key}`}
                    value={(options[opt.key] as string) ?? ""}
                    onChange={(e) => handleOptionChange(opt.key, e.target.value)}
                    disabled={busy}
                  />
                </div>
              )}
            </div>
          ))}

          {missingGuards.size > 0 &&
            Array.from(missingGuards).map((guard) => (
              <div
                key={guard}
                className="flex items-start gap-2 text-sm text-muted-foreground bg-secondary/50 p-3 rounded-md mt-4 border border-border"
              >
                <AlertCircle className="size-4 mt-0.5 shrink-0" />
                <div>
                  {guard === "ai" && (
                    <span>
                      Some AI options are hidden because no AI provider is configured. You can
                      enable them in{" "}
                      <Link href="/ai" className="underline hover:text-primary">
                        AI Settings
                      </Link>
                      .
                    </span>
                  )}
                  {guard !== "ai" && (
                    <span>
                      Some options are hidden because the {guard} integration is not configured. You
                      can enable it in{" "}
                      <Link href="/integrations" className="underline hover:text-primary">
                        Integrations
                      </Link>
                      .
                    </span>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}

      <Dialog open={promptEditor !== null} onOpenChange={(open) => !open && setPromptEditor(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("form.customPromptTitle")}</DialogTitle>
            <DialogDescription>{t("form.customPromptDescription")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="custom-prompt-editor" className="sr-only">
              {t("form.customPromptTitle")}
            </Label>
            <Textarea
              id="custom-prompt-editor"
              rows={12}
              maxLength={MAX_CUSTOM_PROMPT_LENGTH}
              value={promptEditor?.draft ?? ""}
              onChange={(event) =>
                setPromptEditor((prev) => (prev ? { ...prev, draft: event.target.value } : prev))
              }
            />
            <p className="text-xs text-muted-foreground text-right">
              {(promptEditor?.draft.length ?? 0).toLocaleString()} / {MAX_CUSTOM_PROMPT_LENGTH}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setPromptEditor(null)}>
              {c("cancel")}
            </Button>
            <Button type="button" onClick={savePromptEditor}>
              {c("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="submit" disabled={busy} className="w-full sm:w-auto">
          {feed ? t("form.save") : t("form.create")}
        </Button>
        {feed && (
          <Button
            type="button"
            variant="outline"
            disabled={busy || updating}
            onClick={runUpdate}
            className="w-full sm:w-auto"
          >
            {t("form.updateNow")}
          </Button>
        )}
        <Link
          href="/feeds"
          className={cn(buttonVariants({ variant: "outline" }), "w-full sm:w-auto")}
        >
          {c("cancel")}
        </Link>
      </div>
    </form>
  );
}

/**
 * Calls use() on both promises; suspends until they settle; renders the form
 * for real. `/feeds/new` is the only caller -- `/feeds/[id]` has its own
 * pair below (`EditFeedFormResolved`/`EditFeedForm`), because it additionally
 * has a known `feed` (its 404 depends on the row, so the page body awaits it
 * rather than streaming it) that this one does not.
 */
function NewFeedFormResolved({
  capabilitiesPromise,
  allTagsPromise,
}: {
  capabilitiesPromise: Promise<Capabilities>;
  allTagsPromise: Promise<Tag[]>;
}) {
  const capabilities = use(capabilitiesPromise);
  const allTags = use(allTagsPromise);
  return <FeedForm capabilities={capabilities} allTags={allTags} />;
}

/**
 * What `/feeds/new/page.tsx` renders. The fallback is `<FeedForm pending />`
 * -- the real chassis, disabled -- so the aggregator picker (needs no query),
 * the name/identifier/interval/concurrency/options fields and both action
 * buttons are on screen from the first frame; only the capability-based
 * filtering and the tag list stream in once `capabilitiesFor()`/`listTags()`
 * resolve.
 */
export function NewFeedForm({
  capabilitiesPromise,
  allTagsPromise,
}: {
  capabilitiesPromise: Promise<Capabilities>;
  allTagsPromise: Promise<Tag[]>;
}) {
  return (
    <Suspense fallback={<FeedForm pending />}>
      <NewFeedFormResolved
        capabilitiesPromise={capabilitiesPromise}
        allTagsPromise={allTagsPromise}
      />
    </Suspense>
  );
}

/**
 * Calls `use()` on both promises; suspends until they settle; renders the
 * form for real. `feed` is already known by the time this is used --
 * `/feeds/[id]/page.tsx` awaits `getFeed()` at the top of the page body,
 * because it decides the 404 -- so only `capabilities`/`allTags` are
 * promises here, unlike `NewFeedFormResolved` above.
 */
function EditFeedFormResolved({
  feed,
  capabilitiesPromise,
  allTagsPromise,
}: {
  feed: FeedListRow;
  capabilitiesPromise: Promise<Capabilities>;
  allTagsPromise: Promise<Tag[]>;
}) {
  const capabilities = use(capabilitiesPromise);
  const allTags = use(allTagsPromise);
  return <FeedForm feed={feed} capabilities={capabilities} allTags={allTags} />;
}

/**
 * What `/feeds/[id]/page.tsx` renders. The fallback is
 * `<FeedForm feed={feed} pending />` -- the real chassis, disabled, already
 * carrying the fetched feed's own values -- so only the capability-based
 * filtering and the tag list stream in once `capabilitiesFor()`/`listTags()`
 * resolve.
 */
export function EditFeedForm({
  feed,
  capabilitiesPromise,
  allTagsPromise,
}: {
  feed: FeedListRow;
  capabilitiesPromise: Promise<Capabilities>;
  allTagsPromise: Promise<Tag[]>;
}) {
  return (
    <Suspense fallback={<FeedForm feed={feed} pending />}>
      <EditFeedFormResolved
        feed={feed}
        capabilitiesPromise={capabilitiesPromise}
        allTagsPromise={allTagsPromise}
      />
    </Suspense>
  );
}
