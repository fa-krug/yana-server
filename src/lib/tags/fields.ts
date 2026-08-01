import { z } from "zod";

export const tagSchema = z.object({
  name: z.string().trim().min(1, "A name is required."),
});

export type TagsSort = "name" | "createdAt";
export type TagsDir = "asc" | "desc";
