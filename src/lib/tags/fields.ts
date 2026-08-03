import { z } from "zod";

import { TAG_COLOR_KEYS } from "./colors";

export const tagSchema = z.object({
  name: z.string().trim().min(1, "A name is required."),
  color: z.enum(TAG_COLOR_KEYS).optional(),
});

export type TagsSort = "name" | "createdAt";
export type TagsDir = "asc" | "desc";

