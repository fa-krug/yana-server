# Yana — a self-hosted RSS aggregator

Yana pulls content from RSS and Atom feeds, YouTube channels, subreddits,
podcasts and a set of site-specific scrapers into one place, and serves it
through a clean web UI (with dark mode and English/German localization) and an
HTTP API for the first-party iOS/macOS client. Everything runs as a single
container: there's no separate database server, no Redis, no worker process to
babysit.

More about the project: **<https://yana.fa-krug.de/server.html>**

- **Self-hosted** — your feeds, your server, your data. Nothing phones home.
- **Multiple source types** — RSS/Atom feeds, YouTube channels, subreddits,
  podcasts, and dedicated scrapers for a handful of sites that don't publish a
  usable feed.
- **Multi-user** — every user has their own feeds, tags and reading state; an
  admin manages accounts from the web UI.
- **Passkey-first sign-in** — log in with a passkey (Face ID, Touch ID, a
  security key, Windows Hello) or a password.
- **iOS/macOS app** — the same server also powers a native Apple client over a
  documented HTTP API.
- **One container, one process** — SQLite for storage, an in-process job
  worker for scheduling and aggregation. No extra services to run or monitor.

This README covers everything you need to **run** Yana. If you want to build
or contribute to it instead, see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Quick start

### Option 1: Docker (recommended)

This is the easiest way to run Yana and keep it updated.

```bash
mkdir -p data media && chown -R 1001:1001 data media
docker compose up --build -d
```

Then open <http://localhost:3000>.

The bundled `docker-compose.yml` builds the image locally. If you'd rather
pull the published image instead of building it yourself:

```bash
docker run -d \
  --name yana \
  -p 3000:3000 \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -v yana-data:/app/data \
  -v yana-media:/app/media \
  sascha384/yana:latest
```

Named volumes (`yana-data`/`yana-media` above) are the simplest option because
they inherit the image's file ownership automatically. If you'd rather use
bind mounts to a host directory so the files are easy to browse and back up
(as `docker-compose.yml` does), remember that Docker does **not** change their
ownership for you — the container runs as uid 1001, so run
`chown -R 1001:1001 ./data ./media` on the host before the first start, or
SQLite and the media handler won't be able to write to them.

### Option 2: npm (global install)

Requires **Node.js 25** (see [`.nvmrc`](.nvmrc)).

```bash
npm install -g @fa-krug/yana
yana
```

or run it without installing anything permanently:

```bash
npx @fa-krug/yana
```

By default Yana listens on port `3000` and stores its database and media
under `~/.yana`. Both are configurable:

```bash
yana --port 3001 --data-dir /var/lib/yana
```

| Flag                    | Environment variable | Default   | Meaning                                        |
| ----------------------- | -------------------- | --------- | ---------------------------------------------- |
| `-p, --port <number>`   | `PORT`               | `3000`    | Port to listen on                              |
| `-d, --data-dir <path>` | `YANA_DATA_DIR`      | `~/.yana` | Where the SQLite database and media are stored |
| `-v, --version`         |                      |           | Print the installed version                    |
| `-h, --help`            |                      |           | Print usage                                    |

The SQLite file lands at `<data-dir>/yana.db` and article images / feed logos
at `<data-dir>/media/`. Migrations run automatically on every start — there is
no separate migration command to remember, for Docker or npm alike.

## First login

The first start (Docker or npm, against a fresh/empty database) bootstraps an
administrator account and prints its credentials to the log:

- **Email:** `admin@admin.com`
- **Password:** `admin`

Sign in at `/login` and **change the password immediately** — until you do,
anyone who can reach the server is an administrator. A few things worth
knowing about this account:

- **Every later start checks "does any admin exist," not "does this address
  exist."** So if you rename the account (change its email), it never comes
  back on a later start — that's how you make it yours.
- If you delete it and it was the only admin, the next start creates it again
  with the same published password: an instance is never left with no
  administrator at all. Promote another user to admin first, then delete it,
  if you want it gone for good.
- If you demote or ban it while it's the only admin, the next start restores
  its role (and says so in the log) rather than leaving the instance with no
  way in. Its password is untouched. Promoting someone else first avoids this
  entirely.

There is no public sign-up — every account is created by an administrator,
from the "Users" page in the web UI.

## Configuration

Yana reads its configuration from environment variables. Nearly everything has
a sane default; the one you actually need to set is the auth secret.

**Set `BETTER_AUTH_SECRET` before deploying anywhere reachable by anyone but
you.** It signs session cookies. Without it, Better Auth falls back to a
well-known development secret — which anyone could use to forge a session —
and refuses to start at all once `NODE_ENV=production` is set, so nobody can
sign in.

```bash
openssl rand -base64 32
```

Changing it later signs everyone out.

[`.env.example`](.env.example) is the full reference — copy it to `.env` (or
set the same variables in your compose file / hosting platform) and adjust as
needed. The variables you're most likely to touch:

| Variable                         | Purpose                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`             | Signs session cookies. **Set this.**                                            |
| `DATABASE_PATH` / `MEDIA_PATH`   | Where the database and uploaded media live                                      |
| `PASSKEY_RP_ID` / `PUBLIC_URL`   | The domain/origin passkeys are bound to — required if you're not on `localhost` |
| `TZ`                             | Time zone used to format dates in the UI                                        |
| `SMTP_HOST` (+ related `SMTP_*`) | Enables error-notification email; unset disables the feature entirely           |

`PASSKEY_RP_ID`/`PUBLIC_URL` deserve special attention if you're running Yana
behind a real domain: a mismatch between these and the domain your browser
shows is the most common passkey problem, and it fails with a generic browser
error that doesn't name the cause.

## Data & backups

| Path                             | Contents                                                |
| -------------------------------- | ------------------------------------------------------- |
| `data/yana.db` (+ `-wal`/`-shm`) | The SQLite database — users, feeds, articles, settings  |
| `media/`                         | Hosted article images and feed logos, content-addressed |

Both live under the data directory (`./data`/`./media` for Docker Compose,
`--data-dir` for npm) and both start empty. **Back up that directory before
upgrading** — migrations run automatically and unattended against a live
database, and nothing here takes a backup for you. Stopping the server and
copying the directory is enough.

## Upgrading

- **Docker:** pull the new image (or rebuild) and restart the container.
  Migrations apply automatically on the next start.
- **npm:** `npm install -g @fa-krug/yana@latest`, then start it again. Your
  existing data in `~/.yana` (or your custom `--data-dir`) is preserved and
  migrated in place.

## Getting help

Something not working? Open an issue with what you tried, what you expected,
and what you got instead — logs and your `docker-compose.yml`/CLI invocation
help a lot.

Want to build or contribute? See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

See [`LICENSE`](LICENSE).
