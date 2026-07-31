# Phase 14: Folder Swap & Documentation — Implementation Plan

> **Status: done, and reworked from the plan below.** Executed out of order —
> ahead of phases 2–13 — so that all remaining work happens at the repository
> root instead of in a subdirectory. **The plan's central decision was reversed:
> `old/` is kept, not deleted.** See "What actually happened" for the delta.

**Goal:** Move the Django project into `old/`, promote `yana-next/` to the
repository root, and rewrite every document that describes the old stack.

**Architecture:** One mechanical move plus one substantial documentation rewrite.
The move uses `git mv` throughout so history follows the files.

**Tech Stack:** git, and prose.

---

## What actually happened

Executed early, on `claude/post-spec5-fixes`, with the Next.js app still a bare
scaffold (phase 1 only: no schema, no UI, no aggregators).

**Reversed decision — `old/` stays.** The plan argued git history is the archive
and a dead directory in the tree buys nothing. That holds when the port is
finished; it does not hold when phases 2–13 are still ahead. Every one of them
reads Python to port it, and reading `old/core/aggregators/heise/aggregator.py`
in the working tree beats resurrecting it from a tag on every question.
Consequences accepted:

- `old/` is read-only reference. Nothing builds, lints, typechecks, tests,
  containerizes or deploys it, and nobody edits it — see the top of `CLAUDE.md`.
- It cannot run as-is: its paths, compose files and CI workflow all assume the
  repository root. That is expected, not a bug.
- Its Django-era `CLAUDE.md` was **deleted**, not moved. Tools auto-load a
  `CLAUDE.md` next to the files you open, and one describing `manage.py`,
  ruff/mypy/pytest and `/admin/` would be read as instructions for this
  repository. `old/README.md` still describes the Django setup, as history.
- Deleting `old/` is a later, separate decision — once nothing needs to read
  Python any more.

**Wider move than the plan's table.** Everything Django-shaped went to `old/`,
not just the delete list: `README.md`, both compose files, `.env.example`,
`.dockerignore`, `exports/`, and the untracked `.venv/` and tool caches. Its
`CLAUDE.md` was deleted rather than moved (see above). `parity/`, `docs/`,
`LICENSE`, `.gitignore` and `.github/` stayed at the root as planned.

**`data/` and `media/` stayed, their contents did not.** The plan kept both at the
root, which is right — `DATABASE_PATH` defaults to `./data/yana.db` and the image
mounts `/app/data` and `/app/media`. But what was *in* them was Django's:
`db.sqlite3` (40 MB) and 212 MB of Django-era article images and logos. Those moved
to `old/data/` and `old/media/`, so the root pair starts empty, matching the
greenfield-data decision. Both are gitignored, so this is a local-tree change only.

**Task 1 (pre-flight) was skipped deliberately.** No tag, no recorded image
digest, no live comparison. Nothing was deleted, so there is nothing to recover;
and the live comparison gate exists to catch site drift before Python disappears
— Python has not disappeared.

**Task 5 (deploy) was not done, and the pipeline changed shape.** The Django
`ci.yml` moved to `old/ci.yml`, where GitHub does not look for workflows, so it
no longer runs. `ci-next.yml` became the only `ci.yml`: `working-directory` and
`context: ./yana-next` dropped, `push` to `main` added, and **still no
`publish-manifest` or `deploy` jobs**. Publishing `:latest` from a scaffold and
redeploying the shared Portainer stack would replace a working aggregator with an
empty app. Restoring them (copy from `old/ci.yml`) is the last step before this
app can serve production. Until then **production keeps running the last
Django image and receives no updates from CI** — an accepted consequence, not an
oversight.

**Root config the swap made necessary** (none of it in the plan, all of it real):

- `.prettierignore` and `eslint.config.mjs` gained `old/`, `docs/`, `parity/`,
  `data/`, `media/` (and `.superpowers/` for prettier). `prettier --check .` and
  `eslint .` run from the root now, and without these they walk the Django tree —
  including `old/.venv`'s thousands of vendored JS files and ~2000 fixture JSON
  files.
- `tsconfig.json` `exclude` gained the same directories.
- `.dockerignore` gained `old`, `parity`, `docs`, `media`, `.github`, `.claude`,
  `.superpowers` — the build context is the repository root now, so without them
  the image build ships hundreds of MB of reference material.
- `.gitignore` merged the Next entries in (`.next/`, `out/`, `.vercel`,
  `next-env.d.ts`) and kept the Python ones, which now only apply under `old/`.

**Docs rewritten:** root `README.md` (Next.js setup, mid-migration status,
uid-1001 bind-mount caveat), root `CLAUDE.md` (the full contributor guide, and the
repository's **only** agent-instruction file — the scaffold's `AGENTS.md` was
folded into it and deleted, along with `old/CLAUDE.md`), `.env.example`
(grep-derived: only
`DATABASE_PATH` is read by application code), both compose files, `parity/README.md`
(regeneration now needs the tree in `old/`), the direction record's status, and
phases 03–10's `cd yana-next` / `git add yana-next` snippets. Phases 01 and 02
were **not** rewritten — they were written pre-swap and carry a path note
instead. Verified by running all four checks plus the build from the new root.

**Not done, deliberately:** `package.json` is still named `yana-next` (renaming
it forces a lockfile regeneration for no benefit), and phase 15's npm-package
work is untouched.

---

## Original plan (for reference)

### Global Constraints

- **`old/` is created and deleted within this phase.** ~~This repository already
  ran this manoeuvre: `c19d137` created `old/`, `8fde9be` deleted it 428 files
  later. Git history is the archive.~~ **Reversed — see above.**
- Use `git mv`, never `mv` plus `git add`. History following the file is the
  difference between a reviewable diff and 400 apparent deletions and creations.
- **`parity/` stays at the repository root, untouched.** It is the frozen oracle.
  Phase 0 built it specifically to outlive this deletion.
- The CI pipeline must be **green before the swap and green after it**, with the
  deploy job unchanged in behaviour. ~~This is the one phase that can break
  production deployment.~~ **Partly deferred — the deploy job is gone until this
  app can replace production.**
- Documentation must describe what the code *is*, not what it was. Every command,
  path and framework reference gets verified by running it, not by reading it.
- `CLAUDE.md` is a working instruction file for AI assistants. A stale one
  actively misleads, which is worse than an absent one.

### Files to move, delete and rewrite

| Action | Paths |
|---|---|
| ~~Delete~~ → move to `old/` | `core/`, `yana/`, `manage.py`, `pyproject.toml`, `uv.lock`, `supervisord.conf`, `docker-entrypoint.sh`, `Dockerfile`, `.pre-commit-config.yaml` |
| ~~Delete~~ → `old/ci.yml` | `.github/workflows/ci.yml` |
| Promote | `yana-next/*` → repository root |
| Keep | `parity/`, `docs/`, `LICENSE`, `.gitignore` (rewritten), `data/`, `media/` |
| Rewrite | `README.md`, `CLAUDE.md`, `docker-compose.yml`, `docker-compose.production.yml`, `.env.example`, `.dockerignore` |

### Task 1: Pre-flight — **skipped, see above**

- [ ] Confirm phase 11c Task 16's live comparison has been done. **This is the
      last moment Python exists.** *(Not applicable: Python was not deleted.)*
- [ ] Confirm CI is green on both workflows.
- [ ] Confirm the Next.js app runs the full loop end to end against a real feed.
      *(Not applicable at phase 1 — there is no loop yet.)*
- [ ] Tag the current state, and record the deployed Docker image digest.
      *(Not applicable: nothing was deleted, nothing was deployed.)*

### Task 2: The swap — **done**

- [x] Stage the Django tree into `old/` with `git mv`, plus
      `.github/workflows/ci.yml` → `old/ci.yml`.
- [x] Promote the Next.js tree, including the dotfiles that are easy to leave
      behind: `.nvmrc`, `.prettierrc`, `.prettierignore`, `.dockerignore`,
      `eslint.config.mjs`.
- [x] Verify nothing was left behind in `yana-next/`.
- [x] Update the workflow: drop `working-directory: yana-next`, `context: .`,
      fix `node-version-file` and `cache-dependency-path`, rename to `ci.yml`.
- [x] Run every check from the new root:
      `npm run lint && npm run format:check && npm run typecheck && npm test && npm run build`.
- [ ] ~~Delete `old/` in its own commit.~~ **Reversed.**

### Task 3: Container and compose — **partly done**

- [x] Rewrite `docker-compose.yml` and `docker-compose.production.yml`: one
      service on port 3000, volumes for `/app/data` and `/app/media`, the
      environment variables the app actually reads. **No `qcluster` service** —
      phase 12's worker runs in-process, so a second container would run every
      job twice.
- [x] Rewrite `.env.example` from the variables the code reads, found by grep:
      `grep -rhoE "process\.env\.[A-Z_]+" src/ | sort -u`. Today that is
      `DATABASE_PATH` only, plus the `PORT` / `HOSTNAME` /
      `NEXT_TELEMETRY_DISABLED` that Next's own server reads.
- [ ] Build and run the image from the new root, hit `/health`, and confirm
      aggregation runs. *(Deferred: there is no `/health` route and no
      aggregation until phases 3–13.)*

### Task 4: Documentation — **done**

- [x] **`README.md`** — rewritten. Setup is `npm install` and `npm run dev`.
      No Django admin references.
- [x] **`CLAUDE.md`** — rewritten, and it is the only agent-instruction file in
      the repository (no `AGENTS.md`, no per-directory `CLAUDE.md`). It carries:
      the Next.js structure, the `npm` commands, the Drizzle schema and where
      PRAGMAs are applied, the block format and `parity/` as the frozen oracle,
      and the `old/`-is-reference-only rules. The aggregator how-to and the
      jobs-table notes land as phases 9/11/12 build them.
- [x] **`docs/superpowers/specs/`** — history not rewritten. Each superseded
      Django-era spec gained a status line pointing at the Next.js direction
      record.
- [x] Verify every command in both files by running it.
- [x] Update the direction record's status to note the swap is complete.

### Task 5: Deploy — **not done, see above**

- [ ] Merge to `main` and watch the pipeline.
- [ ] After deploy: hit `/health`, log in, confirm feeds aggregate, images serve,
      the worker processes jobs.
- [ ] If broken, redeploy the recorded digest rather than debugging in production.

---

## Self-Review

**Spec coverage.** Against bullet 14: create `old/` and move current files into
it (Task 2), move Next.js files to root (Task 2), update all docs (Task 4). Plus
the container, compose and env work the bullet implies but does not name, and the
deploy verification the CI pipeline makes necessary.

**Placeholder scan.** Task 4's `CLAUDE.md` rewrite was specified as a content
checklist rather than drafted prose — appropriate, since the accurate content
depends on what the phases actually build. Executed early, that cuts both ways:
the parts describing phases 2–13 could not be written yet and are named as
pending rather than invented.

**Type consistency.** Not applicable; this phase moves files and writes prose.

**Two risks.**

1. ~~Task 5 can break production.~~ Superseded: nothing publishes or deploys, so
   the live risk is now the opposite one — **production silently stops receiving
   updates**, and the pipeline's publish/deploy jobs have to be restored
   deliberately (from `old/ci.yml`) before this app can serve it.
2. **`old/` outstays its usefulness.** The original plan's argument against
   keeping it was not wrong, only early. Once phase 13 lands and nothing reads
   Python, delete it — the reason to keep it will be gone, while the cost (a
   stale `CLAUDE.md`, five ignore-list entries, an ambiguous repository) will not.
