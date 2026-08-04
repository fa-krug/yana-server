import { Loader2Icon } from "lucide-react";

import { cn } from "@/lib/utils";

/** Matches the icon Sonner's own loading toasts use (`src/components/ui/sonner.tsx`). */
export function Spinner({ className }: { className?: string }) {
  return <Loader2Icon className={cn("size-4 animate-spin", className)} />;
}
