"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { ConfirmDestructive } from "@/components/crud/confirm-destructive";
import { Button } from "@/components/ui/button";
import { useUserImpact } from "@/components/users/use-user-impact";
import { displayNameFor } from "@/lib/avatar";
import { deleteUsers } from "@/lib/users/actions";
import { attempt } from "@/lib/users/result";

/**
 * The destructive action at the bottom of `/users/[id]`.
 *
 * It is the same server action the bulk delete calls, on a set of one -- so
 * every refusal the list can hit (deleting yourself, deleting the last
 * administrator who can still sign in) is refused here too, with the same
 * message, and there is no second code path to keep in agreement.
 *
 * The confirmation **names the user and the cascade**: an operator on this page
 * has one record in front of them, and "402 articles" is the part of the
 * consequence the page does not otherwise show. Until the counts arrive the
 * copy says what will happen without inventing numbers -- see `useUserImpact`.
 */
export function DeleteUserSection({
  user,
}: {
  user: { id: string; firstName: string; lastName: string; email: string };
}) {
  const t = useTranslations("users");
  const router = useRouter();
  const impact = useUserImpact([user.id]);
  // The two name columns default to "", so this falls back to the address
  // rather than asking "Delete ?".
  const name = displayNameFor(user);

  /** `true` only on success -- anything else keeps the dialog open. */
  async function remove(): Promise<boolean> {
    // attempt(), never a bare await. See @/lib/attempt.
    const result = await attempt(() => deleteUsers([user.id]));

    if (!result.ok) {
      toast.error(result.errorKey ? t(result.errorKey) : t("deleteFailed"));
      return false;
    }

    // `deleted: 0` means the row was already gone -- the call succeeded and
    // this page's subject no longer exists either way, so it still navigates,
    // but it must not report a deletion that did not happen.
    if (result.deleted === 0) toast.info(t("deletedNone"));
    else toast.success(t("deleted", { count: result.deleted }));

    // `replace`, not `push`: this record's page is gone, and Back must not
    // return to an edit form for a user who no longer exists.
    router.replace("/users");
    return true;
  }

  return (
    <div className="flex justify-end">
      <ConfirmDestructive
        trigger={<Button variant="destructive">{t("deleteAction")}</Button>}
        title={t("deleteTitle", { name })}
        description={
          impact
            ? t("deleteDescription", {
                name,
                feeds: impact.feeds,
                tags: impact.tags,
                articles: impact.articles,
              })
            : t("deleteDescriptionPending", { name })
        }
        confirmLabel={t("deleteConfirm")}
        onConfirm={remove}
      />
    </div>
  );
}
