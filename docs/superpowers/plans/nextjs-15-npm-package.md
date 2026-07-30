# Phase 15: Installable npm Package — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm install -g yana` followed by `yana` starts a production-ready server.

**Architecture:** The published package carries Next's `standalone` build output plus a thin CLI entry point. The CLI resolves a data directory, applies migrations, and starts the server — the same three steps `docker-entrypoint.sh` performs, so the container and the npm install share one code path rather than drifting apart.

**Tech Stack:** npm publish, Next standalone output, better-sqlite3 prebuilds, GitHub Actions.

## Global Constraints

- **`npm install` must not require a compiler.** This is the phase's whole point, and `better-sqlite3` is the only obstacle. Phase 1 Task 3 Step 8 recorded its prebuild coverage — if a target platform lacks one, resolve it here with a documented decision, not by silently requiring build tools.
- The published tarball contains **only** what running needs. `src/`, tests, `parity/` and fixtures are excluded; `parity/` in particular is megabytes of HTML with no runtime purpose.
- Data must **not** live inside the package directory. A global install is read-only in many setups and gets replaced on upgrade. Default to `~/.yana/`, overridable by `--data-dir` or `YANA_DATA_DIR`.
- Migrations run on start and must be **idempotent** — an existing database upgrades in place, never re-initialises.
- The CLI reports the URL it is listening on, and fails with an actionable message on a port conflict rather than a stack trace.
- Version numbers come from `package.json` and are set by the release workflow, never edited by hand in a release commit.

---

## File Structure

| Path | Responsibility |
|---|---|
| `bin/yana.js` | CLI entry — shebang, arg parsing, start |
| `src/lib/startup.ts` | `resolveDataDir`, `applyMigrations`, `startServer` — shared with the container |
| `.npmignore` | Publish exclusions |
| `.github/workflows/release.yml` | Tag-driven publish |
| `docs/INSTALL.md` | Install and upgrade instructions |

---

### Task 1: Settle the package name and the native dependency

Both can invalidate the approach, so both are resolved before any packaging work.

- [ ] Check availability:

```bash
npm view yana version 2>&1 | head -3
```

If taken, the fallback is a scoped name (`@fa-krug/yana`), which changes the install command in every document this phase writes — so decide now, not after.

- [ ] Verify `better-sqlite3` prebuilds cover the platforms the install must work on: linux x64, linux arm64, darwin arm64, darwin x64, win32 x64.

```bash
npm view better-sqlite3 dist.tarball
node -e "console.log(process.platform, process.arch)"
ls node_modules/better-sqlite3/prebuilds 2>/dev/null || echo "none present"
```

- [ ] If coverage is incomplete, choose explicitly and document it: `node:sqlite` (built in, no native install, but needs a Drizzle driver swap and a re-verification of every PRAGMA from phase 1), or requiring build tools on the uncovered platforms (documented as a prerequisite, not discovered by the user). **Record the decision and its reasoning in the commit message** — a future maintainer will need to know why.

---

### Task 2: Extract shared startup

- [ ] Move the entrypoint's logic into `src/lib/startup.ts`:
  - `resolveDataDir(explicit?: string): string` — `--data-dir`, then `YANA_DATA_DIR`, then `~/.yana`; created recursively if absent.
  - `applyMigrations(dataDir: string): void` — Drizzle's migrator against the bundled `drizzle/` folder.
  - `startServer(options: { port: number; dataDir: string }): Promise<void>`.
- [ ] Rewrite `docker-entrypoint.sh` to call the same module. The container and the npm install must not have two implementations of "start the app" — that is how they diverge and how one of them breaks unnoticed.
- [ ] Test: `resolveDataDir` honours precedence; `applyMigrations` on an already-migrated database is a no-op; `applyMigrations` on an empty directory creates the schema.

---

### Task 3: The CLI

- [ ] Write `bin/yana.js` with `#!/usr/bin/env node`, supporting `--port` (default 3000), `--data-dir`, `--version`, `--help`.
- [ ] Print the listening URL and the resolved data directory on start. A user who cannot tell which database is in use has no way to diagnose anything.
- [ ] Catch `EADDRINUSE` and report `Port 3000 is already in use. Try: yana --port 3001` rather than an unhandled rejection.
- [ ] On first run, after the admin bootstrap from phase 4, print the default credentials and a warning to change them. The container logs this; a terminal user has no logs to read.
- [ ] Add to `package.json`:

```json
  "bin": { "yana": "./bin/yana.js" },
  "files": ["bin", ".next/standalone", ".next/static", "public", "drizzle"]
```

An explicit `files` allowlist beats `.npmignore`'s denylist here — a new test directory is then excluded by default rather than published by accident.

---

### Task 4: Verify the packaged artifact, not the working tree

- [ ] Pack and inspect:

```bash
npm run build && npm pack --dry-run
```

Confirm no `src/`, no tests, no `parity/`. Check the reported size; a tarball far larger than expected usually means fixtures leaked in.

- [ ] Install the tarball into a clean directory outside the repository and run it:

```bash
npm pack
mkdir -p /tmp/yana-install && cd /tmp/yana-install
npm install --omit=dev "$OLDPWD"/yana-*.tgz
npx yana --port 3123 --data-dir /tmp/yana-install/data
```

- [ ] Confirm end to end from that install: `/health` responds, login with the bootstrapped admin works, a feed can be created and aggregated, and images serve. Testing the working tree instead of the tarball is the classic way to ship a package missing a file.
- [ ] Confirm the upgrade path: stop, install a newer version over it, restart, and verify the existing database still opens with its data intact.

---

### Task 5: Release automation

- [ ] Add `.github/workflows/release.yml` triggered on `v*` tags: checkout, install, run every check, build, `npm publish --provenance`, and create a GitHub release.
- [ ] Publishing requires `NPM_TOKEN` as a repository secret. Note in the workflow that the token must be an automation token — a granular token scoped to the wrong package fails at publish time with a misleading permissions error.
- [ ] The existing Docker jobs stay. The npm package is an addition, not a replacement — the container remains the primary deployment.
- [ ] Write `docs/INSTALL.md`: npm install, Docker, upgrading, where data lives, how to change the default admin password.
- [ ] Dry-run the publish before tagging:

```bash
npm publish --dry-run
```

---

## Self-Review

**Spec coverage.** Against bullet 15: pipeline extended to produce an installable package (Task 5), `npm install yana` then `yana` starting a production-ready server (Tasks 2–4). Complete.

**Placeholder scan.** Task 1 deliberately resolves two unknowns before any packaging work rather than assuming them — the package name may be taken, and the native dependency may not have the prebuild coverage the whole approach rests on. Both would invalidate later tasks, so both are gated first. Every other task carries concrete commands.

**Type consistency.** `resolveDataDir`, `applyMigrations` and `startServer` are declared in Task 2 and consumed by Task 3's CLI and by the rewritten container entrypoint. `DATABASE_PATH` from phase 1 is now derived from the resolved data directory rather than read independently — a single source, so the container and the CLI cannot disagree about where the database is.

**Two risks.**

1. **`better-sqlite3` prebuild coverage is the phase's load-bearing assumption.** Phase 1 recorded the finding precisely so this phase does not discover it late. If coverage is inadequate, the `node:sqlite` fallback means re-verifying every PRAGMA from phase 1 Task 3 — including `foreign_keys=ON`, which the schema's cascades depend on and which is easy to lose in a driver swap.
2. **A global install's data directory is the most likely support problem.** Defaulting inside the package directory would appear to work and then lose data on the first upgrade, which is why Task 2 resolves it to `~/.yana` and Task 3 prints the resolved path on every start.
