"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

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
}: {
  aggregator: "youtube" | "reddit";
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("feeds");
  const [query, setQuery] = useState(value);
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const requestIdRef = useRef(0);

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  function handleQueryChange(nextQuery: string) {
    setQuery(nextQuery);
    clearTimeout(debounceRef.current);

    const trimmed = nextQuery.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setLoading(false);
      setOpen(false);
      return;
    }

    setLoading(true);
    setOpen(true);
    const requestId = ++requestIdRef.current;

    debounceRef.current = setTimeout(() => {
      void (async () => {
        const attempted = await attempt(() => searchFeedIdentifier(aggregator, trimmed));
        if (requestId !== requestIdRef.current) return; // a newer keystroke already superseded this one
        setLoading(false);
        setResults(attempted.ok ? attempted.results : []);
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
      <AutocompleteInput placeholder={t("identifierSearch.placeholder")} />
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
