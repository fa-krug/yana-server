"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ADMIN_ROLE, isAdminRole } from "@/lib/auth/roles";
import { createUser, updateUser } from "@/lib/users/actions";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, STANDARD_ROLE } from "@/lib/users/fields";
import { attempt, type UsersKey } from "@/lib/users/result";
import { cn } from "@/lib/utils";

/** The columns the form edits -- not the `User` row, which carries far more. */
export type EditableUser = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
};

/**
 * One form for both `/users/new` and `/users/[id]`.
 *
 * The two differ in exactly two places -- whether there is a password field and
 * which action the submit calls -- so they are one component rather than two
 * copies of the same four fields and the same error handling. `user` absent
 * means create.
 *
 * **Only the constants module is imported**, never `@/lib/users/queries` or a
 * constant out of `@/lib/users/actions`: both reach `better-sqlite3`, and this
 * runs in the browser. Calling the actions is fine -- they are `"use server"`
 * endpoints, not code that ships here.
 *
 * **What the edit form deliberately does not offer: a password.** With no mail
 * transport an administrator setting one would have to convey it out of band,
 * which is worse than the account holder changing their own; `@/lib/users/actions`
 * declines to implement it at all. The form says so rather than leaving the
 * absence to be noticed, because "where do I reset their password" is the first
 * question this page raises.
 *
 * `pending` is the "not loaded yet" state, the same shape
 * `@/components/settings/library-section.tsx` establishes -- but, like
 * `<TagForm>`, this form has no query of its own (`user` is either absent on
 * `/users/new` or already resolved by `/users/[id]`'s own awaited row read).
 * So `pending` exists purely for `/users/new/loading.tsx`, which renders this
 * same chassis, disabled, while the route's RSC payload is still crossing the
 * network on a client-side soft navigation -- real latency server-side
 * streaming cannot remove (see that file's own comment).
 */
export function UserForm({ user, pending = false }: { user?: EditableUser; pending?: boolean }) {
  const t = useTranslations("users");
  const router = useRouter();
  const [email, setEmail] = useState(user?.email ?? "");
  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  /**
   * **The select offers two roles; the column may hold more than two values,
   * and an untouched select must not rewrite it.**
   *
   * `users.role` is a comma-separated *list* -- `"user,admin"` is an
   * administrator to every Better Auth endpoint -- so the control is seeded
   * through `isAdminRole()`, the same predicate the sidebar, the badge and the
   * library's own `hasPermission()` use. What it cannot do is *submit* the
   * collapsed value: saving a last name on a user whose column reads
   * `"user,viewer"` would then write back plain `"user"`, a write the operator
   * never asked for and cannot see happen. So `null` means "the operator has
   * not touched this" and the stored string is sent back untouched; only an
   * actual selection replaces it.
   *
   * Unobservable today -- nothing writes a list, `/admin/set-role` is in
   * `disabledPaths` and `ADMIN_ROLES` has one entry -- which is exactly why it
   * had to be fixed while it was still free. The consequence to know about:
   * a stored value `ROLE_VALUES` in `@/lib/users/actions` does not recognise
   * now comes back as a visible `roleInvalid` rather than being silently
   * rewritten. A refusal the operator can act on is the better half of that
   * trade; silent data loss is the half this repository does not ship.
   */
  const storedRole = user?.role ?? STANDARD_ROLE;
  const [chosenRole, setChosenRole] = useState<string | null>(null);
  /** What the control shows: one of its two options, always. */
  const roleOption = isAdminRole(chosenRole ?? storedRole) ? ADMIN_ROLE : STANDARD_ROLE;
  /** What a save writes: the operator's choice, or the column as it stands. */
  const role = chosenRole ?? storedRole;
  const [password, setPassword] = useState("");
  const [saving, start] = useTransition();
  const busy = pending || saving;

  // One list feeding both the trigger and the popup: Base UI's <SelectValue>
  // resolves its label from `items` alone and never reads <SelectItem>'s text,
  // so without this the collapsed trigger would print the raw role value.
  const roleItems = [
    { value: ADMIN_ROLE, label: t("roleAdmin") },
    { value: STANDARD_ROLE, label: t("roleStandard") },
  ];

  /**
   * A failure, as a catalog message. Never a zod, driver or Better Auth string
   * -- the action returns a key precisely so a German UI cannot be handed an
   * English validator message.
   *
   * `min` is interpolated unconditionally: `passwordTooShort` needs it, every
   * other key ignores it, and a key whose placeholder went unfilled would
   * render an error in place of the sentence.
   */
  function failed(errorKey: UsersKey | undefined): void {
    toast.error(errorKey ? t(errorKey, { min: MIN_PASSWORD_LENGTH }) : t("saveFailed"));
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    /**
     * Refused here as well as in the action, and this copy is not redundant: a
     * round trip to be told the password is six characters long is a round trip
     * the operator can be spared. The action still applies the bound -- a
     * caller cannot forget what it never had to remember -- and `minLength` on
     * the input alone would not, since the field is only present on create.
     */
    if (!user && password.length < MIN_PASSWORD_LENGTH) {
      failed("passwordTooShort");
      return;
    }

    const values = { email, firstName, lastName, role };

    start(async () => {
      // attempt(), never a bare await: an action that fails *without returning*
      // rejects inside this transition and escalates to the (app) error
      // boundary, replacing the half-filled form with "Something went wrong".
      if (user) {
        const result = await attempt(() => updateUser(user.id, values));
        if (!result.ok) return failed(result.errorKey);
        toast.success(t("form.saved"));
        // The action revalidated; this is what repaints the row and the
        // breadcrumb with what was just written.
        router.refresh();
        return;
      }

      const result = await attempt(() => createUser({ ...values, password }));
      if (!result.ok) return failed(result.errorKey);
      toast.success(t("form.created"));
      /**
       * To the created account's own page, and `replace` rather than `push`:
       * the new-user form is spent, and Back landing on it invites a second
       * submission of the address that was just taken. The id is what
       * `createUser()` reports it for; the fallback cannot be reached on a
       * successful create and exists because the field is optional in the type.
       */
      router.replace(result.id ? `/users/${result.id}` : "/users");
    });
  }

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-6">
      <div className="grid gap-2">
        <Label htmlFor="user-email">{t("form.email")}</Label>
        <Input
          id="user-email"
          type="email"
          required
          autoComplete="off"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          disabled={busy}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="user-first-name">{t("form.firstName")}</Label>
          <Input
            id="user-first-name"
            autoComplete="off"
            value={firstName}
            onChange={(event) => setFirstName(event.target.value)}
            disabled={busy}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="user-last-name">{t("form.lastName")}</Label>
          <Input
            id="user-last-name"
            autoComplete="off"
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
            disabled={busy}
          />
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="user-role">{t("form.role")}</Label>
        <Select
          items={roleItems}
          value={roleOption}
          disabled={busy}
          onValueChange={(value) => {
            // Base UI reports `null` for a clearable selection, which this one
            // never is -- the guard satisfies the wider type.
            if (value === null) return;
            setChosenRole(value);
          }}
        >
          <SelectTrigger id="user-role" className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roleItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-sm text-muted-foreground">{t("form.roleHelp")}</p>
      </div>

      {user ? (
        <p className="text-sm text-muted-foreground">{t("form.passwordFixed")}</p>
      ) : (
        <div className="grid gap-2">
          <Label htmlFor="user-password">{t("form.password")}</Label>
          <Input
            id="user-password"
            type="password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={MAX_PASSWORD_LENGTH}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
          <p className="text-sm text-muted-foreground">
            {t("form.passwordHelp", { min: MIN_PASSWORD_LENGTH })}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="submit" disabled={busy} className="w-full sm:w-auto">
          {user ? t("form.save") : t("form.create")}
        </Button>
        {/* buttonVariants on a <Link>, not `<Button render={<Link/>}>`: the Base
            UI button primitive renders a native <button> unless told otherwise,
            and the class is the whole contract here. Same form as the CRUD
            kit's pagination links. */}
        <Link
          href="/users"
          className={cn(buttonVariants({ variant: "outline" }), "w-full sm:w-auto")}
        >
          {t("form.cancel")}
        </Link>
      </div>
    </form>
  );
}
