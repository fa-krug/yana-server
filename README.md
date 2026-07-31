# Yana — RSS Aggregator

A modern, self-hosted RSS aggregator. Yana pulls content from RSS and Atom
feeds, YouTube channels, subreddits, podcasts and a set of site-specific
scrapers into a local SQLite database, and serves it through a web UI and an
HTTP API for the first-party iOS/macOS client.

**Built with Next.js 16, React 19, TypeScript and SQLite (Drizzle +
better-sqlite3).** One language, one toolchain, one process — the job worker
runs in-process, so there is no Redis and no separate worker container.

> **Status: mid-migration.** Yana was a Django application; it is being rewritten
> in TypeScript. What is in place today is the scaffold, the tuned SQLite client
> and the container build. The schema, UI, auth, aggregators, scheduler and
> client API are being ported phase by phase. The retired Django implementation
> is kept in [`old/`](old/) as a read-only behavior reference, and the frozen
> golden corpus in [`parity/`](parity/) is what proves each ported aggregator
> matches it. See
> [`docs/superpowers/specs/2026-07-30-nextjs-migration-direction.md`](docs/superpowers/specs/2026-07-30-nextjs-migration-direction.md).
>
> **Existing installs:** the deployed Docker image is still the Django one, and
> no data migrates. Do not upgrade a running instance to an image built from this
> tree yet.

## Running it

### With Docker

```bash
docker compose up --build
```

Then open <http://localhost:3000>.

The image runs as uid 1001 and Docker does not chown bind mounts, so before the
first start:

```bash
mkdir -p data media && chown -R 1001:1001 data media
```

(Or switch `docker-compose.yml` to named volumes, which inherit the image's
ownership.) SQLite needs write permission on the _directory_, not just the file,
for its `-wal` and `-shm` siblings.

`docker-compose.production.yml` is the target production shape — a single service
behind Traefik with named volumes. It is not what is deployed today.

### From source

Requires **Node 25** (see [`.nvmrc`](.nvmrc); `nvm use` picks it up).

```bash
npm install
npm run dev
```

Then open <http://localhost:3000>. The SQLite file is created at `./data/yana.db`
on first connection; override with `DATABASE_PATH`.

## Configuration

Copy [`.env.example`](.env.example) to `.env`. Every variable it documents is one
the code actually reads — today that is `DATABASE_PATH` plus the `PORT` /
`HOSTNAME` / `NEXT_TELEMETRY_DISABLED` that Next's own server reads.

## Data on disk

| Path     | Contents                                                           |
| -------- | ------------------------------------------------------------------ |
| `data/`  | The SQLite database (`yana.db`), plus its `-wal` / `-shm` siblings |
| `media/` | Hosted article images and feed logos, content-addressed            |

Both are gitignored, both are volumes in the container, and both start empty — the
Django-era database and images were moved to `old/data/` and `old/media/`, and
nothing here reads them. No data migrates.

## Development

```bash
npm run dev            # dev server
npm run lint           # eslint
npm run format         # prettier --write
npm run format:check   # prettier --check (what CI checks)
npm run typecheck      # tsc --noEmit
npm test               # vitest
npm run build          # production build
```

Run the four checks CI runs before you commit:

```bash
npm run lint && npm run format:check && npm run typecheck && npm test
```

Database schema changes go through Drizzle:

```bash
npx drizzle-kit generate   # write a migration into drizzle/ from src/lib/db/schema.ts
```

Migrations are applied by `docker-entrypoint.sh` at container start.

[`CLAUDE.md`](CLAUDE.md) has the full contributor and AI-assistant guide:
conventions, the database access rules, how `old/` and `parity/` are used, and
where each migration phase is planned.

## License

See [`LICENSE`](LICENSE).
