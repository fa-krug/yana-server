"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useListParams } from "@/components/crud/use-list-params";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { buildListHref } from "@/lib/crud/params";
import { TagColorDot } from "@/components/tags/tag-color-dot";

/** How long typing pauses before the search becomes a navigation. */
const DEBOUNCE_MS = 300;

export type FilterSpec = {
  /** The query-string key this filter occupies -- `?role=admin`. */
  key: string;
  /** Already translated, and used as the control's accessible name. */
  label: string;
  /**
   * Already translated. An option with `value: ""` clears the filter:
   * `buildListHref` omits empty values, so "All roles" produces a URL with no
   * `role` at all rather than `?role=all`.
   *
   * `color`, when present, renders as a small dot before the label -- inside
   * the open popup only, never on the collapsed trigger, which every filter
   * (this one included) still resolves the plain way through `items`. Most
   * filters (roles, aggregator, read/starred) never set it.
   */
  options: { value: string; label: string; color?: string }[];
};

/**
 * Search box and filter selects for a list page.
 *
 * Every change is a **`router.replace`**, never a `push`: a debounced search
 * still fires once per pause, and with `push` a five-word query would bury the
 * page the operator came from under five history entries.
 */
export function SearchFilterBar({
  placeholder,
  filters = [],
}: {
  /** Already translated, and the input's accessible name. */
  placeholder: string;
  filters?: FilterSpec[];
}) {
  const router = useRouter();
  const { pathname, params } = useListParams();
  /**
   * The input is local state seeded from the URL once.
   *
   * It cannot mirror `params.q`: the navigation lands ~300ms after the
   * keystroke, so re-seeding on every render would fight whatever was typed in
   * between. The consequence to know about is that a *back* navigation changes
   * the URL without changing the box; the results below it are correct either
   * way, since the server reads the URL.
   */
  const [q, setQ] = useState(params.q);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unmounting mid-pause must not navigate afterwards -- the component may be
  // gone because the operator already left this list.
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);

  function search(value: string) {
    setQ(value);
    clearTimeout(timer.current ?? undefined);
    timer.current = setTimeout(() => {
      router.replace(buildListHref(pathname, params, { q: value }));
    }, DEBOUNCE_MS);
  }

  function filter(key: string, value: string) {
    // One key, not the whole record: `buildListHref` merges `changes.filters`
    // per key, so the other filters stand and `""` clears this one.
    router.replace(buildListHref(pathname, params, { filters: { [key]: value } }));
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        value={q}
        onChange={(event) => search(event.target.value)}
        className="w-full sm:max-w-64"
      />
      {filters.map((spec) => (
        <Select
          key={spec.key}
          // One list feeds both the trigger and the popup. Base UI resolves the
          // collapsed trigger's label from `items` alone, so this is what keeps
          // it from printing the raw value -- and `<Select>` now requires it.
          items={spec.options}
          value={params.filters[spec.key] ?? ""}
          onValueChange={(value) => filter(spec.key, value ?? "")}
        >
          <SelectTrigger aria-label={spec.label} className="w-full sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {spec.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.color && <TagColorDot color={option.color} className="mr-2 size-2" />}
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}
    </div>
  );
}
