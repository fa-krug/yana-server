import { hexForTagColor } from "@/lib/tags/colors";
import { cn } from "@/lib/utils";

/**
 * A small colored circle with no text -- for contexts where a tag's name is
 * already rendered and only a color cue is needed beside it. `aria-hidden`
 * because the name is the accessible content; the color is decoration.
 */
export function TagColorDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2.5 shrink-0 rounded-full", className)}
      style={{ backgroundColor: hexForTagColor(color) }}
    />
  );
}
