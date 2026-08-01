import type { NamespaceKey } from "@/i18n/next-intl";
import { attemptIn, type ActionResult } from "@/lib/attempt";

export type TagsKey = NamespaceKey<"tags">;

export type TagsResult = ActionResult<"tags">;

export type CreateTagResult = TagsResult & { id?: number };

export type DeleteTagsResult = TagsResult & { deleted: number };

export const attempt = attemptIn("tags", {
  sessionEnded: "sessionEnded",
  requestFailed: "requestFailed",
});
