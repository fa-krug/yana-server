# Contributing to Yana

This is about building Yana from source and working on it. If you just want to run it, see [README.md](README.md) instead.

It's built with Next.js 16, React 19, TypeScript and SQLite (Drizzle + better-sqlite3). One language, one toolchain, one process: the job worker runs in-process, so there's no Redis and no separate worker container to stand up.

## Running from source

Requires Node 25 (see [.nvmrc](.nvmrc); `nvm use` will pick it up for you).

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>. The SQLite file is created at `./data/yana.db` on first start and migrated automatically; you can override the path with `DATABASE_PATH`. There's no separate migration step to remember anywhere. The server applies every pending migration before it serves its first request, no matter how it's run.

The image runs as uid 1001 and Docker doesn't chown bind mounts for you, so before running the container build (`docker compose up --build`):

```bash
mkdir -p data media && chown -R 1001:1001 data media
```

(Or switch `docker-compose.yml` to named volumes, which inherit the image's ownership on their own.) SQLite needs write permission on the directory itself, not just the file, for its `-wal` and `-shm` siblings.

`docker-compose.production.yml` is the target production shape: a single service behind Traefik with named volumes.

One thing that catches people out: switching branches upgrades your local database. If you start the dev server on a branch with newer migrations, they get applied to `./data/yana.db` right then, and switching back doesn't undo it. You're left with a file that's ahead of the schema the older branch expects. Copy `./data/` before trying a branch you want to be able to leave cleanly, or point `DATABASE_PATH` at a throwaway file per branch.

The first start also creates an administrator, `admin@admin.com` / `admin`. See the README's "First login" section for the full behavior of that account.

## Development commands

```bash
npm run dev            # dev server
npm run lint           # eslint
npm run format         # prettier --write
npm run format:check   # prettier --check (what CI checks)
npm run typecheck      # tsc --noEmit
npm test               # vitest
npm run build          # production build
```

Run the same four checks CI runs before you commit:

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
```

Database schema changes go through Drizzle:

```bash
npx drizzle-kit generate   # write a migration into drizzle/ from src/lib/db/schema.ts
```

Applying them isn't a separate step. The server runs every pending migration at startup (`src/instrumentation.ts` calling into `src/lib/startup.ts`), which covers `npm run dev`, `npm start` and the container the same way.

Back up `data/` before upgrading. That startup step applies schema changes to a live SQLite file unattended, and nothing here takes a backup for you on its own. Copying the directory while the server is stopped is enough.

## Commit messages

```
<type>(<scope>): <description>

Types: feat, fix, docs, style, refactor, test, chore
Examples:
  feat(db): Add the feeds and articles tables
  fix(aggregator): Correct duplicate article detection
  test(db): Cover nested writeTransaction rollback
```

## Architecture, conventions and project history

[CLAUDE.md](CLAUDE.md) is the full contributor and AI-assistant guide: directory layout, coding conventions, the database access rules, testing setup, and where each part of the app was designed and built (`docs/superpowers/`). It's worth reading before making non-trivial changes, since it captures a lot of hard-won detail (and the reasoning behind it) that isn't obvious from the code alone.
