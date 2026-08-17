"use client";

import { Suspense, use } from "react";

import { SetBreadcrumbTitle } from "@/components/breadcrumb-title";
import { RecordNotFound } from "@/components/record-not-found";
import { Separator } from "@/components/ui/separator";
import { displayNameFor } from "@/lib/avatar";
import { DeleteUserSection } from "./delete-user-section";
import { UserForm, type EditableUser } from "./user-form";

/**
 * The columns rendered here, never the `User` row `getUser()` resolves to --
 * the row also carries `emailVerified`, the three ban columns and the
 * timestamps, and this promise is serialized whole into this page's RSC
 * payload the moment it crosses into this Client Component (see CLAUDE.md's
 * "a component gets the columns it renders, never the row" rule, and the
 * `openaiApiUrl`/`users.image` bullets for what "serialized whole" has cost
 * elsewhere in this repo). `getUser()` itself still returns the whole `User`
 * -- the projection happens in `/users/[id]/page.tsx`, before the promise is
 * handed down here, not in this component after the fact.
 */
export type UserRecord = EditableUser & {
  email: string;
};

/**
 * Calls `use()` on the one promise `/users/[id]/page.tsx` hands down; suspends
 * until it settles; renders either the real form or the not-found state.
 *
 * `userPromise` resolves to `null` for a nonexistent id **and** for any id at
 * all when the caller is not an admin -- `getUser()` carries its own
 * `requireAdmin()` gate (see its doc comment in `src/lib/users/queries.ts`),
 * which **throws** `notFound()` rather than returning a falsy value.
 * `/users/[id]/page.tsx`'s own promise chain catches that specific rejection
 * (`isNotFoundError()` in `@/lib/auth/session`) and folds it into the same
 * `null` a missing id already produces, so this component never has to tell
 * the two apart: a non-admin sees the same `RecordNotFound` a missing id
 * produces, never a distinguishing message (the same "every refusal is the
 * same empty 404" reasoning `requireAdmin()` itself documents).
 */
function EditUserResolved({ userPromise }: { userPromise: Promise<UserRecord | null> }) {
  const user = use(userPromise);

  if (!user) {
    return <RecordNotFound />;
  }

  return (
    <>
      <SetBreadcrumbTitle title={displayNameFor(user)} />

      <UserForm user={user} />

      <Separator />

      <DeleteUserSection user={user} />
    </>
  );
}

/**
 * What `/users/[id]/page.tsx` renders. There is no page `<h1>` -- the
 * breadcrumb (fed by `SetBreadcrumbTitle` above) already names the record --
 * so the fallback only needs the real `<UserForm pending />` chassis,
 * disabled -- `<DeleteUserSection>` has no equivalent (its
 * confirmation names the user and targets their id, neither of which exists
 * yet), so it is simply absent while pending rather than a placeholder card,
 * the same way `ArticleFormSection`'s own fallback omits `<ContentSection>`.
 * This replaces `/users/[id]/loading.tsx`, deleted along with this component:
 * the page body that renders this awaits nothing, so that route-level
 * fallback is unreachable now (see `src/app/(app)/settings/page.tsx`'s doc
 * comment for the migration this belongs to).
 */
export function EditUserSection({ userPromise }: { userPromise: Promise<UserRecord | null> }) {
  return (
    <Suspense fallback={<UserForm pending />}>
      <EditUserResolved userPromise={userPromise} />
    </Suspense>
  );
}
