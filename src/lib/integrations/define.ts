import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { z } from "zod";

import type { NoticeResult } from "@/lib/attempt";
import { currentUserId } from "@/lib/auth/session";
import { getDb, writeTransaction } from "@/lib/db/client";
import { userSettings } from "@/lib/db/schema";
import { resolveSecret } from "@/lib/secrets";

import type { ProbeResult } from "./probe";

/**
 * One declaration per credential provider, and the save/test/remove actions that
 * fall out of it.
 *
 * **Why this exists.** Phase 6 shipped two providers as two near-twin sequences
 * -- parse, load the row, resolve each secret, guard the empty case, probe, log,
 * judge -- and phase 7 adds three more. Five copies is not a length problem, it
 * is a *drift* problem, and the drift lands where no test looks: one provider's
 * resolve rules or empty-credential guard diverging from the next's is invisible
 * in a review of either function. So the sequence is written once here and every
 * per-provider difference is data in a declaration, where a table of five is
 * readable at a glance.
 *
 * **Not part of `./actions`, deliberately** -- the same reason `attempt` lives in
 * `./result`: that module carries `"use server"`, so every one of its exports has
 * to be an async function Next can expose as an endpoint. A factory cannot live
 * there at all.
 *
 * **This module is bound to a catalog namespace by its caller, not by itself.**
 * `defineIntegrationIn<Key>()` mirrors `attemptIn()` in `@/lib/attempt` and
 * `reportOutcomeIn()` in `@/components/section-kit`: the four keys that belong to
 * the *page* rather than to a provider are spelled out once at the binding site,
 * where the namespace is a literal and the compiler checks them against the real
 * catalogs. TypeScript cannot prove a literal is a member of
 * `NamespaceKey<Namespace>` while `Namespace` is still a type parameter, which is
 * why they are arguments rather than derived -- the same reasoning, in the same
 * words, as `attemptIn`'s two.
 */

/** Every column of `user_settings`, as a write accepts them. */
type SettingsValues = typeof userSettings.$inferInsert;

type ColumnsHolding<Value> = {
  [Column in keyof SettingsValues]-?: NonNullable<SettingsValues[Column]> extends Value
    ? Column
    : never;
}[keyof SettingsValues];

/**
 * A column a credential or a plain provider field can be written to.
 *
 * Derived from the schema rather than listed, so a column renamed in
 * `schema/users.ts` fails `npm run typecheck` at the declaration that names it.
 * It is wider than "a credential column" -- `theme` and `language` are text too,
 * and nothing in the schema distinguishes them -- but it does rule out the
 * mistake worth ruling out, which is naming a boolean flag here.
 */
export type TextColumn = ColumnsHolding<string>;

/** The `*_enabled` side of the same derivation. */
export type FlagColumn = ColumnsHolding<boolean>;

/**
 * One submitted field, and what it means.
 *
 * `secret` is one bit with two consequences, and both are the whole point of the
 * split:
 *
 * - **`true`** -- an unchanged submission resolves it against the stored row
 *   (`resolveSecret()`), it must be non-empty before anything is probed, and
 *   Remove wipes it.
 * - **`false`** -- it is submitted in full every time, never resolved against the
 *   row, and Remove leaves it alone. Reddit's `userAgent` is the case that
 *   demanded it: it is not a credential, it is sent to Reddit on every request to
 *   identify this installation publicly, and throwing away a correctly-written one
 *   on the path to re-entering a client id is a small cruelty. Phase 7's `model`
 *   and `apiUrl` are the same kind of field.
 */
export type IntegrationField = {
  column: TextColumn;
  secret: boolean;
};

/** One field with the name it was declared under. */
type NamedField<Field extends string> = IntegrationField & { name: Field };

/**
 * The declaration, as the rest of this module walks it.
 *
 * `Object.keys()` is typed `string[]` on purpose -- a `Record<K, V>` does not
 * promise it has *only* those keys, so TypeScript will not narrow them. Here it
 * is sound and this is the only assertion in the module: the record is a
 * descriptor's own object literal, and the compiler has already pinned its key
 * set to exactly `Field` in both directions -- a missing key fails
 * `Record<Field, IntegrationField>` and an extra one fails `schema`, both proved
 * against the real declarations rather than assumed.
 */
function fieldList<Field extends string>(
  fields: Record<Field, IntegrationField>,
): NamedField<Field>[] {
  return (Object.keys(fields) as Field[]).map((name) => ({ name, ...fields[name] }));
}

/**
 * What differs per provider beyond its columns: two catalog keys, and one fact
 * about the provider itself. Everything else a probe can report means the same
 * thing whoever answered it.
 */
export type ProviderKeys<Key extends string> = {
  /** The provider refused the credential. */
  rejected: Key;
  /** The provider answered "too many requests", whichever arm that lands in. */
  quota: Key;
  /**
   * **Does a rate-limit answer prove the credential was accepted?**
   *
   * This is a per-provider fact, and it is a **required** field so that adding a
   * provider forces someone to decide it rather than inheriting YouTube's answer
   * by copying a branch. The two providers already disagree:
   *
   * - **YouTube: `true`.** Google validates the API key *before* it accounts for
   *   quota, so a 403 carrying `quotaExceeded`/`dailyLimitExceeded` (or
   *   `RESOURCE_EXHAUSTED`) is only reachable *with* a key it accepted. The
   *   credential is verified and only today's budget is gone, so refusing the
   *   save would send an operator back to re-enter a key that was fine.
   * - **Reddit: `false`.** A 429 from `/api/v1/access_token` is IP/edge-level
   *   load shedding, returned *without* looking at the Basic auth header -- and
   *   datacentre ranges, which is where a self-hosted aggregator lives, get
   *   throttled routinely. Treating it as a pass meant a first-ever save of
   *   *wrong* credentials from a throttled host stored them, set
   *   `reddit_enabled = 1`, and said "the credentials are valid". They may not
   *   be. That breaks the rule the flag exists for: phase 9 would then offer
   *   Reddit feeds that come back empty, with a badge saying Active.
   *
   * `false` sends the answer to the `unknown` arm, which is exactly right: an
   * answer that was produced without checking the credential is not a verdict
   * about it, so nothing is written and the operator is told to try again.
   */
  quotaMeansVerified: boolean;
};

/**
 * Everything one provider is.
 *
 * **`Field` is inferred from `schema` and from `fields` together, and the two
 * have to agree exactly.** A field the schema parses but the declaration does not
 * name would be validated, handed to the probe, and then silently never written
 * to any column; a field named here but absent from the schema would resolve to
 * `undefined`. Both are compile errors, in both directions -- checked by
 * temporarily removing `userAgent` from each half, not asserted here.
 */
export type IntegrationDescriptor<Field extends string, Key extends string> = {
  /** The provider's name in a log line. Never rendered. */
  provider: string;
  schema: z.ZodType<Record<Field, string>>;
  /** Every submitted field, keyed by the name the schema parses it under. */
  fields: Record<Field, IntegrationField>;
  flagColumn: FlagColumn;
  /** Reported when a secret is neither submitted nor stored. */
  requiredKey: Key;
  /**
   * Which submitted field failed and how, as a catalog key; anything unlisted
   * falls through to the generic failure. Optional because a provider whose
   * fields are all plain secrets has nothing useful to say beyond it.
   *
   * Keyed on `field:code` rather than on the field alone, because one field can
   * fail two ways that want different advice: Reddit's empty User-Agent is
   * `too_small` ("a user agent is required") and one with a newline in it is
   * `invalid_format` ("printable ASCII only"). Telling an operator who pasted a
   * two-line string that the field is empty is worse than the generic message.
   * A blank field reports both issues, `too_small` first, so it still lands on
   * the required key.
   */
  fieldErrorKeys?: Record<string, Key>;
  probe: (credential: Record<Field, string>) => Promise<ProbeResult>;
  keys: ProviderKeys<Key>;
};

/** What `remove` resolves to -- `ActionResult`, without naming a namespace. */
type RemoveResult<Key extends string> = { ok: boolean; errorKey?: Key };

/** The three actions one declaration produces. */
export type IntegrationActions<Key extends string> = {
  save: (input: unknown) => Promise<NoticeResult<Key>>;
  test: (input: unknown) => Promise<NoticeResult<Key>>;
  remove: () => Promise<RemoveResult<Key>>;
};

/**
 * What a probe's verdict means for the row.
 *
 * Three outcomes rather than two, and the third one is the interesting one:
 *
 * - **`good`** -- the credential works. Store it, switch the integration on. A
 *   quota answer lands here with a `noticeKey` **when the provider validates the
 *   credential before accounting for quota** (`quotaMeansVerified` above): the
 *   key is valid and only today's budget is gone, so refusing the save would be
 *   wrong (see `SaveResult` in `./result`). Where it does not -- Reddit -- the
 *   same `cause` lands in `unknown` instead.
 * - **`bad`** -- the provider refused it. **Store it anyway**, and switch the
 *   integration off, so the badge agrees with the toast and a typo is visible
 *   rather than silently producing empty feeds.
 * - **`unknown`** -- a network failure, a timeout, a status no probe recognises,
 *   or a rate limit from a provider that sheds load before it authenticates.
 *   **Nothing is written at all.** With no answer there is nothing
 *   to derive the flag from, and both alternatives are worse: a momentary outage
 *   would either disable a working integration, or leave `*Enabled = true` --
 *   earned by a *different* credential -- vouching for one that has never been
 *   tested. The operator is told nothing changed and can retry.
 *
 * **The asymmetry between those last two is deliberate, and it was argued.** A
 * `bad` verdict overwrites a stored credential that was working, and the field
 * only ever showed eight bullets -- so one bad paste destroys a key that cannot
 * be read back out of this UI. That cost was put to the human explicitly, next
 * to the option of refusing the write, and storing was chosen: Save's contract
 * is "what you typed is now what is stored", and the alternative leaves an
 * operator reasoning about which of two invisible values the server decided to
 * keep, with a badge that cannot tell them apart. **Test** is what makes that
 * safe -- it writes nothing, so a replacement can be proved before it replaces
 * anything -- and **Remove** is the deliberate path back to "not configured".
 *
 * So do not "fix" `bad` into a no-write arm for consistency with `unknown`: they
 * differ because a refusal **is** a verdict about the credential that was
 * submitted, while an unanswered probe is no verdict at all. Collapsing them
 * would make a save silently discard what an operator typed whenever a provider
 * happened to say no, which is the failure this whole page exists to make
 * visible.
 */
type Judgement<Key extends string> =
  | { outcome: "good"; noticeKey?: Key }
  | { outcome: "bad"; errorKey: Key }
  | { outcome: "unknown"; errorKey: Key };

/**
 * What a submission resolved to, once the provider has answered about it.
 *
 * `refused` carries the finished result rather than a reason, because every
 * refusal before the probe (a malformed body, a missing settings row, a field
 * that is empty on both sides) is already the caller's whole answer -- there is
 * nothing left for a save to add to it.
 */
type Verified<Field extends string, Key extends string> =
  | { status: "refused"; result: NoticeResult<Key> }
  | {
      status: "verified";
      credential: Record<Field, string>;
      judgement: Judgement<Key>;
    };

/**
 * The one wording of "this account has no settings row".
 *
 * Written once because it is the same provisioning bug wherever it is noticed
 * (see `getSettings()`, which throws for it and must not self-heal), and five
 * copies of a log line are five chances for one of them to say something
 * different about the same state.
 */
function logMissingRow(userId: string): void {
  console.error(`[integrations] no user_settings row for user "${userId}"`);
}

/**
 * The one place a `detail` is allowed to go.
 *
 * `console.warn` rather than `console.error`: a rejected key is an ordinary
 * operator mistake, not a fault in this server. The line is what an operator
 * reads when the translated toast is not specific enough -- which is the whole
 * reason `detail` exists.
 */
function logProbe(provider: string, probe: ProbeResult): void {
  if (probe.ok) return;
  console.warn(`[integrations] ${provider} probe failed (${probe.cause}): ${probe.detail}`);
}

/** The stored row an unchanged submission resolves against. */
function storedSettings(userId: string) {
  // The whole row rather than a computed column list: a descriptor names its
  // columns as strings, and indexing the typed row with one keeps the read
  // checked against the schema. Nothing here crosses the wire -- the projection
  // that does is `getIntegrationStatus()` in `./queries`, which masks.
  return getDb().select().from(userSettings).where(eq(userSettings.userId, userId)).get();
}

/**
 * Write the given columns, and report whether anything actually persisted.
 *
 * `changes === 0` means `WHERE user_id = ?` matched nothing, so the row is
 * missing -- a provisioning bug (see `getSettings()`, which throws for the same
 * state and must not self-heal). Reporting `ok: true` there would show "saved"
 * over a change a reload silently reverts.
 *
 * `updatedAt` is deliberately not set: the schema's `$onUpdate(() => new Date())`
 * stamps it on every Drizzle write, and a second place to set it is a second
 * place for it to drift.
 */
function persist(userId: string, values: Partial<SettingsValues>): boolean {
  try {
    const changes = writeTransaction(
      (tx) =>
        tx.update(userSettings).set(values).where(eq(userSettings.userId, userId)).run().changes,
    );
    if (changes === 0) {
      logMissingRow(userId);
      return false;
    }
    return true;
  } catch (error) {
    // Logged, not returned: a driver message is not a catalog key either.
    console.error("[integrations] failed to write credentials", error);
    return false;
  }
}

function errorKeyFor<Key extends string>(
  issues: z.core.$ZodIssue[],
  table: Record<string, Key> | undefined,
): Key | undefined {
  const issue = issues[0];
  const field = issue?.path[0];
  return typeof field === "string" ? table?.[`${field}:${issue.code}`] : undefined;
}

/**
 * Bind the descriptor to one catalog namespace and one page.
 *
 * The four keys here belong to the page rather than to any provider -- three of
 * them say "the probe was not answered" and the fourth "the wipe did not
 * happen" -- so they are supplied once instead of five times. Spelled out at the
 * binding site for the reason `attemptIn`'s two are: with the namespace a
 * literal, the compiler checks them against `messages/en.json` and
 * `messages/de.json` for free.
 *
 * ```ts
 * // src/lib/integrations/actions.ts
 * const defineIntegration = defineIntegrationIn<IntegrationsKey>({
 *   path: "/integrations",
 *   unverifiable: { network: "unreachable", timeout: "timedOut", unexpected: "unexpected" },
 *   removeFailed: "removeFailed",
 * });
 * ```
 */
export function defineIntegrationIn<Key extends string>(binding: {
  /** Revalidated after every write, and never after a Test. */
  path: string;
  /** The causes that mean "the question was not answered", not "the answer is no". */
  unverifiable: Record<"network" | "timeout" | "unexpected", Key>;
  removeFailed: Key;
}) {
  return function defineIntegration<Field extends string>(
    descriptor: IntegrationDescriptor<Field, Key>,
  ): IntegrationActions<Key> {
    const fields = fieldList(descriptor.fields);
    const secrets = fields.filter((field) => field.secret);

    function judge(probe: ProbeResult): Judgement<Key> {
      if (probe.ok) return { outcome: "good" };
      switch (probe.cause) {
        case "quota":
          return descriptor.keys.quotaMeansVerified
            ? { outcome: "good", noticeKey: descriptor.keys.quota }
            : { outcome: "unknown", errorKey: descriptor.keys.quota };
        case "unauthorized":
          return { outcome: "bad", errorKey: descriptor.keys.rejected };
        default:
          return { outcome: "unknown", errorKey: binding.unverifiable[probe.cause] };
      }
    }

    /**
     * Resolve a submission against the stored row, probe the result, and judge it.
     *
     * **Save and Test share this, and the sharing is the feature.** The Test
     * button is worth nothing unless it validates *exactly* what a Save would
     * store, and that agreement used to be nine byte-identical lines in each of
     * two functions: a change to the resolve rules or to the empty-credential
     * guard applied to one copy and not the other yields a Test that passes
     * against one credential while a Save stores a different one, with a green
     * toast over both. Nothing about that failure is visible in a review of
     * either function alone, so the two paths are made to be the same code
     * instead of being kept in agreement by hand -- and now that the code is one
     * factory, the same holds *between* providers, which is where the risk moved
     * once there were more than two. `actions.test.ts` pins the property
     * directly as well: it runs both entry points on one submission and compares
     * the requests they made.
     *
     * `logProbe()` lives here for the same reason: which `detail` is logged is
     * part of what the two paths must agree on.
     */
    async function verify(userId: string, input: unknown): Promise<Verified<Field, Key>> {
      const parsed = descriptor.schema.safeParse(input);
      if (!parsed.success) {
        return {
          status: "refused",
          result: {
            ok: false,
            errorKey: errorKeyFor(parsed.error.issues, descriptor.fieldErrorKeys),
          },
        };
      }

      const stored = storedSettings(userId);
      if (!stored) {
        logMissingRow(userId);
        return { status: "refused", result: { ok: false } };
      }

      // A plain field is submitted in full and never resolved against the row;
      // a secret one falls back to what is stored when the field was left
      // untouched, which is the only way an unchanged secret can survive never
      // having been sent to the browser.
      const credential: Record<Field, string> = { ...parsed.data };
      for (const field of secrets) {
        credential[field.name] = resolveSecret(parsed.data[field.name], stored[field.column]);
      }

      // Nothing submitted and nothing stored: probing "" would come back
      // "unauthorized" and blame a credential that was never entered. Every
      // secret has to be present, which is what makes one guard serve a provider
      // with one and a provider with two.
      if (secrets.some((field) => credential[field.name] === "")) {
        return { status: "refused", result: { ok: false, errorKey: descriptor.requiredKey } };
      }

      const probe = await descriptor.probe(credential);
      logProbe(descriptor.provider, probe);
      return { status: "verified", credential, judgement: judge(probe) };
    }

    /** A judgement, turned into what the section renders. */
    function report(judgement: Judgement<Key>): NoticeResult<Key> {
      if (judgement.outcome === "good") {
        return judgement.noticeKey ? { ok: true, noticeKey: judgement.noticeKey } : { ok: true };
      }
      return { ok: false, errorKey: judgement.errorKey };
    }

    return {
      async save(input: unknown): Promise<NoticeResult<Key>> {
        const userId = await currentUserId();
        const verified = await verify(userId, input);
        if (verified.status === "refused") return verified.result;
        const { credential, judgement } = verified;

        // No verdict, so nothing to derive a flag from -- see Judgement.
        if (judgement.outcome === "unknown") return report(judgement);

        const values: Partial<SettingsValues> = {};
        for (const field of fields) {
          values[field.column] = credential[field.name];
        }
        values[descriptor.flagColumn] = judgement.outcome === "good";

        if (!persist(userId, values)) return { ok: false };
        revalidatePath(binding.path);
        return report(judgement);
      },

      /**
       * Try the submitted credentials without persisting anything.
       *
       * The point of the button: an operator validates a key *before* it replaces
       * one that works -- which is also what makes an `unauthorized` save's
       * overwrite an accepted cost rather than a trap (see `Judgement`). So this
       * writes nothing, not even the `*Enabled` flag, and does not revalidate.
       *
       * It differs from `save` in exactly that: the resolution and the probe are
       * the same call.
       */
      async test(input: unknown): Promise<NoticeResult<Key>> {
        const userId = await currentUserId();
        const verified = await verify(userId, input);
        return verified.status === "refused" ? verified.result : report(verified.judgement);
      },

      /**
       * The way back to "not configured", and the reason it needs an action of
       * its own.
       *
       * An empty submission means *keep* the stored secret and the enabled flag
       * is probe-derived, so without this there is no path from a configured
       * integration to an unconfigured one -- an operator who revoked a key at
       * the provider could not remove it here. Wiping each column to `""` rather
       * than NULL keeps the `notNull()` contract the schema declares.
       *
       * **Only the secrets are wiped.** A field declared `secret: false` --
       * Reddit's `userAgent`, phase 7's model and base URL -- is not a
       * credential, and throwing away a correctly-written one is a small cruelty
       * on the path to re-entering the client id.
       */
      async remove(): Promise<RemoveResult<Key>> {
        const userId = await currentUserId();

        const values: Partial<SettingsValues> = {};
        for (const field of secrets) {
          values[field.column] = "";
        }
        values[descriptor.flagColumn] = false;

        if (!persist(userId, values)) return { ok: false, errorKey: binding.removeFailed };
        revalidatePath(binding.path);
        return { ok: true };
      },
    };
  };
}
