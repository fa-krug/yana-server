# Error notification emails

Date: 2026-08-05

## Problem

The current app has no way to tell anyone when something goes wrong in the
background. Three failure modes are currently silent outside the server log:

- The in-process job worker's loop crashes (`runWorkerLoop(...).catch(...)` in
  `src/lib/jobs/worker.ts`) -- nothing restarts it, so every job stops
  processing until the process itself restarts.
- The scheduler tick that enqueues feed-update jobs throws
  (`src/lib/jobs/scheduler.ts`, two `console.error` sites).
- A job exhausts its retries and terminally fails (`fail()` in
  `src/lib/jobs/queue.ts`, the `job.attempts >= job.maxAttempts` branch) --
  e.g. a feed's URL breaks and every scheduled aggregation for it fails
  forever, invisibly.

The retired Django app had SMTP settings and sent admin email on unhandled
exceptions (`ADMIN_EMAIL`, `EMAIL_HOST*` in `old/`). This design adds an
equivalent for the current app, routed to the right audience and bundled so a
recurring failure does not spam anyone.

## Scope

Two independent notification channels:

1. **System errors -> every admin.** Worker-loop crashes, scheduler-tick
   errors, and job failures with no resolvable owner (currently only
   `retention`, which runs once per boot across every user and owns no
   individual job).
2. **Job failures -> the job's owning user.** A terminally failed job (not a
   retry -- see `fail()`'s two branches) emails whoever owns it, resolved the
   same way `resolveJobUserId()` already resolves it for the SSE job event
   (`src/lib/jobs/queue.ts`): via `runs.userId` for jobs enqueued through
   `enqueueRun()`, or via the article's feed owner for `article.reload`.

Both channels debounce: the first error into a channel starts a timer: if
more errors land on that channel before the timer fires, they are appended to
the same pending batch; when the timer fires, one email is sent per
recipient listing everything collected, and the batch clears. A channel that
stays quiet sends nothing. Nothing here touches the existing SSE job/run
event stream, the `runs`/`jobs` UI, or `console.error` logging -- those are
unchanged; this only adds an additional side effect alongside them.

Out of scope: the fatal startup failure path in `src/instrumentation.ts`.
At that point migrations may not have run, so there is no way to read
`user_settings` (needed for recipient language) or even guarantee `users`
exists to find an admin -- and the process is about to `exit(1)` regardless,
where a hung SMTP call would delay the very restart that fixes things. That
failure is already loud on stdout/stderr, which is what container log
monitoring is for.

## Existing infrastructure this reuses

- `resolveJobUserId(job)` (`src/lib/jobs/queue.ts`, private to the module) --
  the exact ownership resolution needed for the job-failure channel. `fail()`
  already calls the equivalent logic via `publishJobOutcome()`; the new hook
  sits in `fail()` itself where `job` and the terminal outcome are already in
  scope, so no new export is needed.
- `isAdminRole()` / `ADMIN_ROLE` (`src/lib/auth/roles.ts`) -- the only
  correct way to ask "is this user an admin" (comma-list-aware). Used to
  build the admin recipient list.
- `users` + `userSettings` schema (`src/lib/db/schema/users.ts`) -- `email`
  and `role` on `users`, `language` on `userSettings`, joined by `userId`.
- The dynamic catalog import pattern in `src/i18n/request.ts`
  (`(await import(\`../../messages/${locale}.json\`)).default`) -- reused
  as-is, since this code has no request to call `getRequestConfig()` from.
- `console.error` catch-and-continue convention used throughout
  `src/lib/jobs/*` (`log-bus.ts`, `queue.ts`'s `publishJobOutcome`) -- a
  notification failure must never be allowed to break the job/worker/scheduler
  code path that triggered it.

## New files

### `src/lib/email/client.ts` -- the SMTP transport

```ts
import nodemailer from "nodemailer";

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
let configured = false;

function getTransport() {
  if (configured) return transport;
  configured = true;

  const host = process.env.SMTP_HOST;
  if (!host) return null; // feature disabled: no SMTP configured

  transport = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });
  return transport;
}

export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const t = getTransport();
  if (!t) {
    console.log(`[email] SMTP not configured; would have sent to ${to}: ${subject}`);
    return;
  }
  try {
    await t.sendMail({ from: process.env.EMAIL_FROM || "yana@localhost", to, subject, text });
  } catch (err) {
    console.error(`[email] failed to send to ${to}:`, err);
  }
}
```

Lazy singleton, matching `getDb()`'s shape: built once, from env vars read at
first use rather than at module load, so tests can set `process.env` before
first calling it. `sendMail()` never throws -- same "never allowed to break
the caller" contract as `publishJobOutcome()` and `log-bus.ts`.

### `src/lib/email/error-notifications.ts` -- the bundling engine

```ts
export interface ErrorEntry {
  category: "worker" | "scheduler" | "job";
  message: string;
  occurredAt: Date;
  jobKind?: string;
}

const DEBOUNCE_MS = Number(process.env.ERROR_EMAIL_DEBOUNCE_MS) || 120_000;
const ADMIN_KEY = "__admin__";

interface Bucket {
  entries: ErrorEntry[];
  timer: ReturnType<typeof setTimeout>;
}

const buckets = new Map<string, Bucket>();

/** Queues `entry` under `key`, starting a `DEBOUNCE_MS` timer only when `key`
 * has no pending batch yet; a batch already in flight just grows. */
function schedule(key: string, entry: ErrorEntry, flush: (entries: ErrorEntry[]) => Promise<void>): void {
  const existing = buckets.get(key);
  if (existing) {
    existing.entries.push(entry);
    return;
  }
  const bucket: Bucket = {
    entries: [entry],
    timer: setTimeout(() => {
      buckets.delete(key);
      void flush(bucket.entries);
    }, DEBOUNCE_MS),
  };
  buckets.set(key, bucket);
}

export function notifyAdmins(entry: ErrorEntry): void {
  schedule(ADMIN_KEY, entry, flushAdmins);
}

export function notifyJobFailure(userId: string | null, entry: ErrorEntry): void {
  if (!userId) {
    notifyAdmins(entry);
    return;
  }
  schedule(userId, entry, (entries) => flushUser(userId, entries));
}
```

`flushAdmins(entries)` queries every admin's `email` + `language`
(`users` join `userSettings`, filtered with `isAdminRole(role)` in
application code since the column is a comma-list `isAdminRole()` already
knows how to read -- not filterable as a plain SQL equality), renders one
translated digest per admin, and calls `sendMail()` for each. `flushUser(userId,
entries)` does the same for the single owning user's row.

Both flush functions render through a small `renderDigest(locale, entries)`
helper that builds the subject/body via `createTranslator` (see Localization
below) and are the only two places `sendMail()` is called from -- kept as
plain exported functions (not wrapped further) so tests can call them
directly with a fake bucket instead of waiting out `DEBOUNCE_MS`.

State is process-local (module-scope `Map`/variable, no `globalThis` symbol
needed since -- unlike `worker.ts` -- this module isn't guarding against
Next's dev-mode module re-evaluation causing a *second worker loop*; at worst
a HMR reload here just drops a pending unset batch, which is the same
acceptable loss as a process restart).

## Hook sites

- `src/lib/jobs/worker.ts`, inside `startWorker()`'s
  `runWorkerLoop(options).catch((err) => { ... })`: add
  `notifyAdmins({ category: "worker", message: String(err), occurredAt: new Date() })`
  alongside the existing `console.error`.
- `src/lib/jobs/scheduler.ts`, both existing `console.error` catch blocks:
  same addition with `category: "scheduler"`.
- `src/lib/jobs/queue.ts`, inside `fail()`, only in the branch that sets
  `status: "failed"` (`job.attempts >= job.maxAttempts`), after the
  transaction commits (same point `publishJobOutcome` is already called from):
  resolve the owner via the same logic `resolveJobUserId(job)` already
  provides and call
  `notifyJobFailure(ownerId, { category: "job", message: errMsg, occurredAt: now, jobKind: job.kind })`.
  The `outcome === "retry"` branch is untouched -- a job still retrying is not
  a failure worth an email yet.

None of these hooks can throw into their caller: `notifyAdmins` /
`notifyJobFailure` only ever schedule a `setTimeout` or push to an array --
the actual I/O (the DB read for recipients, the SMTP send) happens inside the
timer callback, already wrapped by `sendMail()`'s own try/catch. A query
failure while resolving recipients is caught in the flush function itself and
logged, never allowed to become an unhandled rejection inside a `setTimeout`
callback.

## Configuration (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `SMTP_HOST` | unset | Enables the feature when set; unset means every `sendMail()` call is a no-op log line. |
| `SMTP_PORT` | `587` | |
| `SMTP_SECURE` | `false` | `true` for implicit TLS (port 465). |
| `SMTP_USER` | unset | Omit for an unauthenticated relay. |
| `SMTP_PASSWORD` | unset | |
| `EMAIL_FROM` | `yana@localhost` | The `From:` address. |
| `ERROR_EMAIL_DEBOUNCE_MS` | `120000` (2 min) | Bundle window per channel. |

`nodemailer` is added as a new, exactly-pinned dependency (no `^`/`~`, per
the repo convention) -- check the latest stable version at implementation
time and pin that exact string in both `package.json` and
`package-lock.json` (`npm install nodemailer@<version> --save-exact`).

## Localization

Each recipient gets the digest in their own `userSettings.language`. There is
no request in a worker/scheduler/queue callback, so `getTranslations()` (which
needs `next-intl`'s request-scoped config) does not apply; this uses
`createTranslator` from `next-intl` directly with a manually loaded catalog --
the same JSON files `src/i18n/request.ts` already loads via
`(await import(\`../../messages/${locale}.json\`)).default`, and the same
pattern next-intl's own docs describe for rendering translations outside of a
component tree (e.g. emails). **Implementation-time check:** confirm the
exact import path (`next-intl` vs. `next-intl/core`) against the installed
`next-intl` version's own type declarations before writing this, per this
repo's "read the docs before writing code" rule for framework packages one
level down (Next itself); next-intl ships its own `.d.ts` that settles this
in seconds.

New `email` namespace, added to both `messages/en.json` and
`messages/de.json` (parity enforced by `src/i18n/messages.test.ts`):

- `email.subject`: `"Yana: {count, plural, one {1 error} other {# errors}}"`
- `email.workerEntry` / `email.schedulerEntry` / `email.jobEntry`: one line
  per entry kind, each taking `{time}` and `{message}` (and `{jobKind}` for
  the job case) as ICU placeholders.
- `email.intro`: a one-line preamble before the list.

`jobKind` itself (`"aggregate"`, `"article.reload"`, etc.) stays an
untranslated raw slug in the body, matching how `jobs-table.tsx` and the job
detail page already render `job.kind` verbatim.

When admins have different `language` settings, `flushAdmins` renders and
sends one email per admin rather than one email to a recipient list, since
each render is locale-specific. This is one extra `sendMail()` call per admin
rather than per admin *language* (not grouped by locale) -- simpler, and the
number of admins on a self-hosted instance is small enough that this is not
worth the extra grouping logic.

## Error handling / edge cases

- **SMTP unconfigured** (`SMTP_HOST` unset): every `sendMail()` call logs and
  returns; no queued state or bundling logic changes -- the debounce/bundle
  machinery still runs, it just ends in a log line instead of a real send.
  This keeps dev/test environments from needing SMTP configured at all.
- **SMTP send fails** (bad credentials, host unreachable, timeout):
  caught inside `sendMail()`, logged, and the bucket has already been cleared
  before the send was attempted -- a failed send does not retry and does not
  re-queue the entries. A permanently broken SMTP config degrades to "silent
  again", which is the same failure mode as today; it does not compound into
  a growing unbounded queue.
  A future improvement (not in this pass) could re-queue on send failure, but
  that risks build-up during an extended outage -- worth its own thought if
  it turns out this matters in practice.
- **No admin exists** (should not happen given `ensureAdminExists()`, but a
  timing edge is not impossible): `flushAdmins` with zero recipients simply
  sends nothing and logs that fact.
- **Ownerless job failure** (`retention`): `resolveJobUserId()` returns `null`
  for it today (no `runId`, kind is not `article.reload`), so
  `notifyJobFailure(null, entry)` routes straight to `notifyAdmins`, per
  the null check at the top of `notifyJobFailure`.
- **A job's owner is deleted between enqueue and failure**: the recipient
  lookup at flush time finds no matching user row; `flushUser` for a
  vanished id logs and sends nothing, rather than throwing.
- **Debounce window spanning a process restart**: a pending in-memory batch
  is lost if the process restarts before the timer fires. Accepted -- these
  are best-effort notifications, not a record of truth (the `jobs`/`runs`
  tables and the server log remain the durable record either way).
- **Same user has both a bundled job failure and would separately be an
  admin recipient of a system error in the same window**: two independent
  emails, one per channel -- channels are never merged, since a system error
  digest and a personal job-failure digest are different pieces of
  information that could confuse being combined into one message.

## Testing

- `src/lib/email/client.test.ts`: `sendMail()` with no `SMTP_HOST` logs and
  resolves without throwing; with a fake/mock transport injected, a rejected
  send is caught and logged rather than propagating. (`nodemailer` itself is
  not exercised against a live server -- inject or mock at the transport
  boundary, the same arm's-length treatment the AI/integration probes use for
  their outbound `fetch` calls.)
- `src/lib/email/error-notifications.test.ts`: using `vi.useFakeTimers()` --
  a single entry flushes after `DEBOUNCE_MS` and not before; a second entry
  arriving mid-window is included in the same flush and does not reset or
  duplicate the timer; two different users' job-failure entries flush
  independently; a `null`-owner job failure lands in the admin bucket, not a
  user bucket. Real-database reads for recipients (admin list, a specific
  user's email+language), per this repo's no-mocked-DB convention for
  `src/lib/**` tests.
- `src/lib/jobs/queue.test.ts` (extended): a terminally failed job with a
  resolvable owner calls `notifyJobFailure` with that owner's id; a
  terminally failed `retention`-style ownerless job calls it with `null`; a
  `retry`-outcome failure calls neither.
- `src/lib/jobs/worker.test.ts` / `scheduler.test.ts` (extended, if such
  files exist -- otherwise new): a thrown error from the loop/tick reaches
  `notifyAdmins` alongside the existing `console.error`.
- Not covered by an automated test: an actual SMTP round trip. Verified by
  hand once against a real mail server before this ships, the same "one
  manual pass" caveat the AI provider probes carry for their own live calls.
