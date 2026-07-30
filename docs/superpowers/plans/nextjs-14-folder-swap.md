# Phase 14: Folder Swap & Documentation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Django project out, promote `yana-next/` to the repository root, delete the Python tree, and rewrite every document that describes the old stack.

**Architecture:** One mechanical move plus one substantial documentation rewrite. The move uses `git mv` throughout so history follows the files. The deletion is irreversible in working-tree terms but not in history terms — which is the reason `old/` does not need to survive the phase.

**Tech Stack:** git, and prose.

## Global Constraints

- **`old/` is created and deleted within this phase.** This repository already ran this manoeuvre: `c19d137` created `old/`, `8fde9be` deleted it 428 files later. Git history is the archive; a dead directory sitting across commits bought nothing then and buys nothing now.
- Use `git mv`, never `mv` plus `git add`. History following the file is the difference between a reviewable diff and 400 apparent deletions and creations.
- **`parity/` stays at the repository root, untouched.** It is the frozen oracle. Phase 0 built it specifically to outlive this deletion.
- The CI pipeline must be **green before the swap and green after it**, with the deploy job unchanged in behaviour. This is the one phase that can break production deployment.
- Documentation must describe what the code *is*, not what it was. Every command, path and framework reference gets verified by running it, not by reading it.
- `CLAUDE.md` is a working instruction file for AI assistants. A stale one actively misleads, which is worse than an absent one.

---

## Files to move, delete and rewrite

| Action | Paths |
|---|---|
| Delete | `core/`, `yana/`, `manage.py`, `pyproject.toml`, `uv.lock`, `supervisord.conf`, `docker-entrypoint.sh`, `Dockerfile`, `.pre-commit-config.yaml` |
| Delete | `.github/workflows/ci.yml` |
| Promote | `yana-next/*` → repository root |
| Keep | `parity/`, `docs/`, `LICENSE`, `.gitignore` (rewritten), `data/`, `media/` |
| Rewrite | `README.md`, `CLAUDE.md`, `docker-compose.yml`, `docker-compose.production.yml`, `.env.example`, `.dockerignore` |

---

### Task 1: Pre-flight

- [ ] Confirm phase 11c Task 16's live comparison has been done. **This is the last moment Python exists**; after this phase, the only oracle is the frozen corpus, which cannot detect site drift. If it was skipped, do it now, before anything is deleted.
- [ ] Confirm CI is green on both workflows.
- [ ] Confirm the Next.js app runs the full loop end to end against a real feed: create it, aggregate it, read the article, see its blocks and images.
- [ ] Tag the current state so the pre-swap tree is trivially reachable:

```bash
git tag pre-nextjs-swap && git push origin pre-nextjs-swap
```

- [ ] Record the Docker image digest currently deployed, so a rollback target exists that does not depend on rebuilding.

---

### Task 2: The swap

- [ ] Stage the Django tree into `old/`:

```bash
mkdir old
for path in core yana manage.py pyproject.toml uv.lock supervisord.conf \
            docker-entrypoint.sh Dockerfile .pre-commit-config.yaml; do
  git mv "$path" "old/$path"
done
git mv .github/workflows/ci.yml old/ci.yml
git commit -m "refactor: Stage the Django project into old/ for the swap"
```

- [ ] Promote the Next.js tree, including dotfiles — `.nvmrc`, `.prettierrc`, `.dockerignore` and `eslint.config.mjs` are easy to leave behind and each breaks something quietly:

```bash
git mv yana-next/* .
git mv yana-next/.nvmrc yana-next/.prettierrc yana-next/.prettierignore \
       yana-next/.dockerignore .
rmdir yana-next
```

- [ ] Verify nothing was left behind:

```bash
ls -a yana-next 2>/dev/null && echo "STOP: files remain in yana-next"
```

- [ ] Update `.github/workflows/ci-next.yml`: drop `working-directory: yana-next`, change `context: ./yana-next` to `context: .`, and fix the `node-version-file` and `cache-dependency-path` values. Rename it to `ci.yml`.
- [ ] Run every check from the new root:

```bash
npm ci && npm run lint && npm run format:check && npm run typecheck && npm test && npm run build
```

- [ ] Commit, then delete `old/` in its own commit so the diff of each is reviewable:

```bash
git commit -m "refactor: Promote the Next.js project to the repository root"
git rm -r old && git commit -m "refactor: Remove the Django project

Git history is the archive -- pre-nextjs-swap tags the last commit containing it.
Keeping old/ in the tree would repeat what 8fde9be already had to undo."
```

---

### Task 3: Container and compose

- [ ] Rewrite `docker-compose.yml` and `docker-compose.production.yml`: one service on port 3000, volumes for `/app/data` and `/app/media`, and the environment variables the Next.js app actually reads. **Delete the `qcluster` service** — phase 12's worker runs in-process, so a second container would run every job twice.
- [ ] Rewrite `.env.example` from the variables the code reads, found by grep rather than by memory:

```bash
grep -rhoE "process\.env\.[A-Z_]+" src/ | sort -u
```

Every hit gets an entry with a comment. Anything in the old `.env.example` with no hit gets deleted — a documented variable that does nothing is worse than an undocumented one.

- [ ] Build and run the image from the new root, hit `/health`, and confirm aggregation runs.

---

### Task 4: Documentation

- [ ] **`README.md`** — rewrite. Setup is `npm install` and `npm run dev`, not `uv sync`. Remove every Django admin reference; the web UI replaced it.
- [ ] **`CLAUDE.md`** — rewrite. This file currently describes Django models, the aggregator Template Method in Python, `manage.py` commands, the custom SQLite backend, ruff/mypy/pytest, and a `/admin/` verification surface. Every one of those is now wrong. It needs:
  - The Next.js structure and where things live
  - `npm` commands, including `npm run aggregator:<key>`
  - The Drizzle schema and where PRAGMAs are applied
  - The block format and that `parity/` is the frozen oracle
  - How to add an aggregator: registry entry, option spec, golden case
  - That the jobs table is the broker and the worker is in-process
- [ ] **`docs/superpowers/specs/`** — do **not** rewrite history. Add a status line to each superseded Django-era spec pointing at the Next.js direction record. They are records of decisions that were correct at the time.
- [ ] Verify every command in both files by running it. A README command that fails is the first thing a new contributor hits.
- [ ] Update the direction record's status to note the swap is complete.

---

### Task 5: Deploy

- [ ] Merge to `main` and watch the pipeline. **The deploy job is the risk in this phase.**
- [ ] After deploy: hit `/health`, log in, confirm feeds aggregate, confirm images serve, confirm the worker is processing jobs.
- [ ] If broken, redeploy the digest recorded in Task 1 rather than debugging in production.

---

## Self-Review

**Spec coverage.** Against bullet 14: create `old/` and move current files into it (Task 2), move Next.js files to root (Task 2), update all docs (Task 4). Plus the container, compose and env work the bullet implies but does not name, and the deploy verification the CI pipeline makes necessary.

**Placeholder scan.** Task 4's `CLAUDE.md` rewrite is specified as a content checklist rather than drafted prose — appropriate, since the accurate content depends on what phases 1–12 actually built, and drafting it now would describe a plan rather than a codebase.

**Type consistency.** Not applicable; this phase moves files and writes prose.

**Two risks.**

1. **Task 5 can break production.** Mitigations: the tag and image digest from Task 1, deletion split across reviewable commits, and a rollback that redeploys a known-good digest instead of debugging live.
2. **Task 1's live-comparison gate is easy to skip under momentum** — everything works, the tests are green, and deleting Python feels safe. It is the last moment a live divergence can be detected against the real implementation, and after this phase the frozen corpus cannot find one by construction.
