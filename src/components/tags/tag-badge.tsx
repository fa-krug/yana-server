import { Badge } from "@/components/ui/badge";
import { TAG_COLOR_FOREGROUND, hexForTagColor } from "@/lib/tags/colors";
import { cn } from "@/lib/utils";

/** A solid, colored pill for a tag -- the chip form used wherever tags render as tags. */
export function TagBadge({
  name,
  color,
  className,
}: {
  name: string;
  color: string;
  className?: string;
}) {
  return (
    <Badge
      className={cn("border-0", className)}
      style={{ backgroundColor: hexForTagColor(color), color: TAG_COLOR_FOREGROUND }}
    >
      {name}
    </Badge>
  );
}
