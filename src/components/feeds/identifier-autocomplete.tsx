"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompletePopup,
  AutocompleteStatus,
} from "@/components/ui/autocomplete";
import { searchFeedIdentifier } from "@/lib/aggregators/search";
import { attempt } from "@/lib/feeds/result";

type Result = { value: string; label: string };

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

/**
 * The `search`-mode identifier field: type a query, get live YouTube
 * channel / Reddit subreddit results, click one to select it. `value` is the
 * real identifier (a channel id or a subreddit name) -- never shown as the
 * input's text once a result has been picked, since a picked result displays
 * its human-readable `label` instead. On mount, an existing feed's stored
 * `value` is shown as-is (no reverse lookup to a friendly label -- every
 * other identifier mode shows the raw stored value on load too).
 */
export function IdentifierAutocomplete({
  aggregator,
  value,
  onValueChange,
  disabled,
  id,
  required,
}: {
  aggregator: "youtube" | "reddit";
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  id?: string;
  required?: boolean;
}) {
  const t = useTranslations("feeds");
  const [query, setQuery] = useState(value);
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      clearTimeout(debounceRef.current);
    };
  }, []);

  function handleQueryChange(nextQuery: string, eventDetails: { reason?: string }) {
    // Base UI's Root fills the input's own text when an item is pressed and
    // reports it here with `reason: "item-press"` -- carrying the picked
    // *value*, not its label. Left unguarded that fired immediately after
    // `handleSelect` had set the display text to the human-readable label,
    // overwriting it back to the raw channel id / subreddit name and
    // scheduling a redundant debounced search for it. `handleSelect` owns
    // both the display text and the reported value for that case, so there is
    // nothing to do here.
    if (eventDetails?.reason === "item-press") return;

    setQuery(nextQuery);
    clearTimeout(debounceRef.current);

    // Invalidate any in-flight request unconditionally -- not just when a new
    // search supersedes it. Without this, typing "linus" (schedules request 1)
    // and then deleting back down to "l" before it resolves took this
    // below-threshold branch, which cleared `results` but left `requestIdRef`
    // at 1; when request 1's promise later resolved, `requestId !==
    // requestIdRef.current` (1 !== 1) was false, so its now-stale results
    // silently repopulated `results` even though the query had been cleared.
    const requestId = ++requestIdRef.current;

    const trimmed = nextQuery.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setLoading(false);
      setOpen(false);
      return;
    }

    setLoading(true);
    setOpen(true);

    debounceRef.current = setTimeout(() => {
      void (async () => {
        const attempted = await attempt(() => searchFeedIdentifier(aggregator, trimmed));
        if (!mountedRef.current) return; // unmounted while the request was in flight
        // A newer keystroke (a real search or a drop below the threshold)
        // already superseded this one.
        if (requestId !== requestIdRef.current) return;
        setLoading(false);
        if (!attempted.ok) {
          // Without this, a real failure (the integration switched off
          // mid-session, a transient network error) was indistinguishable
          // from a search that genuinely matched nothing: both showed
          // "No results" and `errorKey` was dropped on the floor.
          setResults([]);
          toast.error(t(attempted.errorKey));
          return;
        }
        setResults(attempted.results);
      })();
    }, DEBOUNCE_MS);
  }

  function handleSelect(result: Result) {
    setQuery(result.label);
    setOpen(false);
    onValueChange(result.value);
  }

  return (
    <Autocomplete
      items={results}
      value={query}
      onValueChange={handleQueryChange}
      open={open}
      onOpenChange={setOpen}
      mode="none"
      disabled={disabled}
    >
      <AutocompleteInput
        id={id}
        required={required}
        placeholder={t("identifierSearch.placeholder")}
      />
      <AutocompletePopup>
        <AutocompleteStatus>{loading ? t("identifierSearch.loading") : null}</AutocompleteStatus>
        <AutocompleteEmpty>{!loading ? t("identifierSearch.empty") : null}</AutocompleteEmpty>
        {results.map((result) => (
          <AutocompleteItem
            key={result.value}
            value={result.value}
            onClick={() => handleSelect(result)}
          >
            {result.label}
          </AutocompleteItem>
        ))}
      </AutocompletePopup>
    </Autocomplete>
  );
}
