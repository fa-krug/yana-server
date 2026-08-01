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
 */
export function UserForm({ user }: { user?: EditableUser }) {
  const t = useTranslations("users");
  const router = useRouter();
  const [email, setEmail] = useState(user?.email ?? "");
  const [firstName, setFirstName] = useState(user?.firstName ?? "");
  const [lastName, setLastName] = useState(user?.lastName ?? "");
  /**
   * **The select offers two roles, and a stored comma list collapses onto them
   * through `isAdminRole()`** -- the same predicate the sidebar, the badge and
   * Better Auth's own `hasPermission()` use, so the control cannot claim
   * something the application disagrees with. The consequence is visible before
   * it is saved: a user whose column reads `"user,admin"` shows
   * "Administrator", and saving rewrites the column to plain `"admin"`. That is
   * not lossy in any way this application can observe -- `ROLE_VALUES` in
   * `@/lib/users/actions` accepts nothing but `admin` and `user` either, so
   * there is no third role for the list to have carried.
   */
  const [role, setRole] = useState(
    user ? (isAdminRole(user.role) ? ADMIN_ROLE : STANDARD_ROLE) : STANDARD_ROLE,
  );
  const [password, setPassword] = useState("");
  const [pending, start] = useTransition();

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
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="user-last-name">{t("form.lastName")}</Label>
          <Input
            id="user-last-name"
            autoComplete="off"
            value={lastName}
            onChange={(event) => setLastName(event.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="user-role">{t("form.role")}</Label>
        <Select
          items={roleItems}
          value={role}
          disabled={pending}
          onValueChange={(value) => {
            // Base UI reports `null` for a clearable selection, which this one
            // never is -- the guard satisfies the wider type.
            if (value === null) return;
            setRole(value);
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
          />
          <p className="text-sm text-muted-foreground">
            {t("form.passwordHelp", { min: MIN_PASSWORD_LENGTH })}
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {user ? t("form.save") : t("form.create")}
        </Button>
        {/* buttonVariants on a <Link>, not `<Button render={<Link/>}>`: the Base
            UI button primitive renders a native <button> unless told otherwise,
            and the class is the whole contract here. Same form as the CRUD
            kit's pagination links. */}
        <Link href="/users" className={buttonVariants({ variant: "outline" })}>
          {t("form.cancel")}
        </Link>
      </div>
    </form>
  );
}
