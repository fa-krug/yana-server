"use client";

import { useEffect, useState, useTransition } from "react";

import { tagUsage } from "@/lib/tags/actions";

export function useTagUsage(selectedIds: number[]): { feeds: number } | null {
  const [usage, setUsage] = useState<{ feeds: number } | null>(null);
  const [, start] = useTransition();

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
  }, [selectedIds]);

  return usage;
}
