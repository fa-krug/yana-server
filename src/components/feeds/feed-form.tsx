"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";

import { createFeed, updateFeed } from "@/lib/feeds/actions";
import { AGGREGATOR_SPECS, visibleOptionsFor, type Capabilities } from "@/lib/aggregators/registry";
import type { Feed, Tag } from "@/lib/db/schema";
import { AlertCircle } from "lucide-react";

type FeedListRow = Feed & { tags: Tag[] };

export function FeedForm({ 
  feed, 
  capabilities,
  allTags 
}: { 
  feed?: FeedListRow; 
  capabilities: Capabilities;
  allTags: Tag[];
}) {
  const t = useTranslations("feeds");
  const c = useTranslations("common");
  const router = useRouter();
  
  const [pending, start] = useTransition();

  const [aggregator, setAggregator] = useState<keyof typeof AGGREGATOR_SPECS>(
    (feed?.aggregator as keyof typeof AGGREGATOR_SPECS) || "full_website"
  );
  const [name, setName] = useState(feed?.name ?? "");
  const [identifier, setIdentifier] = useState(feed?.identifier ?? "");
  const [tagIds, setTagIds] = useState<string[]>(
    feed?.tags.map((t) => String(t.id)) ?? []
  );
  const [enabled, setEnabled] = useState(feed?.enabled ?? true);
  
  const [options, setOptions] = useState<Record<string, unknown>>(feed?.options ?? {});

  const spec = AGGREGATOR_SPECS[aggregator];
  const visibleOptions = visibleOptionsFor(aggregator, capabilities);

  // Check what's hidden
  const missingGuards = new Set<string>();
  spec.options.forEach(opt => {
    if (opt.requires && !capabilities[opt.requires]) {
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
    }
    setOptions(newOptions);
  }

  function handleOptionChange(key: string, value: unknown) {
    setOptions(prev => ({ ...prev, [key]: value }));
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
          items={Object.values(AGGREGATOR_SPECS).map(s => ({ value: s.key, label: s.label }))}
          disabled={pending}
        >
          <SelectTrigger id="aggregator">
            <SelectValue placeholder={t("form.aggregatorPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {Object.values(AGGREGATOR_SPECS).map((s) => (
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
          disabled={pending}
        />
      </div>

      {(spec.identifierRequired || spec.identifierLabel) && (
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
            disabled={pending}
          />
          {spec.identifierHelp && (
            <p className="text-sm text-muted-foreground">{spec.identifierHelp}</p>
          )}
        </div>
      )}

      <div className="grid gap-2">
        <Label htmlFor="tags">{t("form.tags")}</Label>
        <Select
          multiple
          value={tagIds}
          onValueChange={(val: string[]) => setTagIds(val)}
          items={allTags.map((tag) => ({ value: String(tag.id), label: tag.name }))}
          disabled={pending}
        >
          <SelectTrigger id="tags">
            <SelectValue placeholder={t("form.tagsPlaceholder")}>
              {tagIds.length === 0 ? (
                <span className="text-muted-foreground">{t("form.tagsPlaceholder")}</span>
              ) : (
                <div className="flex gap-1 flex-wrap">
                  {tagIds.map(id => {
                    const tag = allTags.find(t => String(t.id) === id);
                    return tag ? <span key={id} className="bg-secondary px-1 rounded">{tag.name}</span> : null;
                  })}
                </div>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {allTags.map((tag) => (
              <SelectItem key={tag.id} value={String(tag.id)}>
                {tag.name}
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
            <p className="text-sm text-muted-foreground">
              {t("form.enabledDescription")}
            </p>
          </div>
          <Switch
            id="enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={pending}
          />
        </div>
      )}

      {visibleOptions.length > 0 && (
        <div className="space-y-4 rounded-lg border p-4 bg-muted/20">
          <h3 className="font-medium text-lg">{t("form.options")}</h3>
          
          {visibleOptions.map((opt) => (
            <div key={opt.key} className="grid gap-2">
              {opt.kind === "boolean" ? (
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id={`opt-${opt.key}`}
                    checked={options[opt.key] as boolean}
                    onCheckedChange={(checked) => handleOptionChange(opt.key, checked)}
                    disabled={pending}
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
                    disabled={pending}
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
                    value={Array.isArray(options[opt.key]) ? (options[opt.key] as string[]).join("\n") : (options[opt.key] as string) || ""}
                    onChange={(e) => {
                      const val = e.target.value.split("\n");
                      handleOptionChange(opt.key, val);
                    }}
                    disabled={pending}
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
                    disabled={pending}
                  />
                </div>
              ) : (
                <div className="grid gap-1.5">
                  <Label htmlFor={`opt-${opt.key}`}>{opt.label}</Label>
                  <Input
                    id={`opt-${opt.key}`}
                    value={(options[opt.key] as string) ?? ""}
                    onChange={(e) => handleOptionChange(opt.key, e.target.value)}
                    disabled={pending}
                  />
                </div>
              )}
            </div>
          ))}

          {missingGuards.size > 0 && Array.from(missingGuards).map((guard) => (
            <div key={guard} className="flex items-start gap-2 text-sm text-muted-foreground bg-secondary/50 p-3 rounded-md mt-4 border border-border">
              <AlertCircle className="size-4 mt-0.5 shrink-0" />
              <div>
                {guard === "ai" && (
                  <span>
                    Some AI options are hidden because no AI provider is configured. You can enable them in{" "}
                    <Link href="/ai" className="underline hover:text-primary">AI Settings</Link>.
                  </span>
                )}
                {guard !== "ai" && (
                  <span>
                    Some options are hidden because the {guard} integration is not configured. You can enable it in{" "}
                    <Link href="/integrations" className="underline hover:text-primary">Integrations</Link>.
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {feed ? t("form.save") : t("form.create")}
        </Button>
        <Link href="/feeds" className={buttonVariants({ variant: "outline" })}>
          {c("cancel")}
        </Link>
      </div>
    </form>
  );
}
