import { solveLightnessForHue } from "@/lib/avatar";

/**
 * The curated set of tag colors, in the order a brand-new install's migration
 * cycles existing tags through (see `drizzle/0004_tag_colors.sql`) and the
 * order the swatch picker renders them in `<TagForm>`.
 */
export const TAG_COLOR_KEYS = [
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "violet",
  "pink",
] as const;

export type TagColorKey = (typeof TAG_COLOR_KEYS)[number];

/** What a brand-new tag starts as before anyone has picked a color. */
export const DEFAULT_TAG_COLOR: TagColorKey = "red";

/** Fixed across the palette; only the hue (and the lightness solved for it) vary. */
const SATURATION = 65;

const HUES: Record<TagColorKey, number> = {
  red: 0,
  orange: 25,
  amber: 40,
  yellow: 55,
  lime: 90,
  green: 140,
  teal: 175,
  cyan: 195,
  blue: 220,
  indigo: 245,
  violet: 270,
  pink: 330,
};

/** The foreground every swatch is solved to stay legible under, in both themes. */
export const TAG_COLOR_FOREGROUND = "#ffffff";

export function isTagColorKey(value: string): value is TagColorKey {
  return (TAG_COLOR_KEYS as readonly string[]).includes(value);
}

/**
 * The CSS color for a stored `tags.color` value.
 *
 * Falls back to `DEFAULT_TAG_COLOR` for a value that is not one of the twelve
 * keys -- defensive only, since the write path (the zod enum in
 * `src/lib/tags/fields.ts`) never lets an unrecognized one through, but a
 * render helper should degrade rather than throw over row data.
 */
export function hexForTagColor(value: string): string {
  const key = isTagColorKey(value) ? value : DEFAULT_TAG_COLOR;
  const hue = HUES[key];
  const lightness = solveLightnessForHue(hue, SATURATION);
  return `hsl(${hue} ${SATURATION}% ${lightness}%)`;
}
