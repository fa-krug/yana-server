"use client";

import { useEffect, useState, useTransition } from "react";

import { tagUsage } from "@/lib/tags/actions";

export function useTagUsage(selectedIds: number[]): { feeds: number } | null {
  const [usage, setUsage] = useState<{ feeds: number } | null>(null);
  const [, start] = useTransition();

  // Callers (e.g. <TagForm>'s `tag ? [tag.id] : []`) build a fresh array
  // literal on every render, so depending on `selectedIds` itself reruns this
  // effect on every render regardless of whether the ids actually changed --
  // and each run's `start()` toggles this hook's own pending state, which
  // re-renders the caller and feeds the cycle forever. Depending on a joined
  // primitive instead makes the effect insensitive to the caller's array
  // identity, only to the ids it actually holds.
  const idsKey = selectedIds.join(",");

  useEffect(() => {
    let active = true;

    if (selectedIds.length === 0) {
      start(() => {
        if (active) setUsage(null);
      });
      return;
    }

    start(async () => {
      try {
        const result = await tagUsage(selectedIds);
        if (active) {
          setUsage(result);
        }
      } catch (error) {
        console.error("Failed to fetch tag usage:", error);
      }
    });

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- idsKey is the intentional, stable proxy for selectedIds; see comment above.
  }, [idsKey]);

  return usage;
}
