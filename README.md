# Yana, a self-hosted RSS aggregator

Yana pulls content from RSS and Atom feeds, YouTube channels, subreddits, podcasts and a handful of site-specific scrapers into one place, and serves it through a web UI (dark mode, English/German) plus an HTTP API for the first-party iOS/macOS client. It runs as a single container: no separate database server, no Redis, no worker process to babysit.

More about the project: <https://yana.fa-krug.de/server.html>

A few things worth knowing up front. It's self-hosted, so your feeds and your data stay on your server and nothing phones home. It pulls from more than plain RSS/Atom: YouTube channels, subreddits, podcasts, and a few sites that don't publish a usable feed of their own. It's multi-user, with each person keeping their own feeds, tags and read state, and an admin managing accounts from the web UI. Signing in prefers a passkey (Face ID, Touch ID, a security key, Windows Hello), with a password as the fallback. The same server also powers a native Apple app over a documented HTTP API. And it's genuinely one container, one process: SQLite for storage and an in-process job worker for scheduling and aggregation, so there's nothing extra to run or monitor.

This README covers running Yana. If you want to build it from source or contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## Quick start

### Docker (recommended)

This is the easiest way to run Yana and keep it updated.

```bash
mkdir -p data media && chown -R 1001:1001 data media
docker compose up --build -d
```

Then open <http://localhost:3000>.

The bundled `docker-compose.yml` builds the image locally. If you'd rather pull the published image than build it yourself:

```bash
docker run -d \
  --name yana \
  -p 3000:3000 \
  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  -v yana-data:/app/data \
  -v yana-media:/app/media \
  sascha384/yana:latest
```

Named volumes like `yana-data`/`yana-media` above are the simplest option because they inherit the image's file ownership automatically. If you'd rather bind-mount a host directory so the files are easy to browse and back up, the way `docker-compose.yml` does, keep in mind Docker won't change their ownership for you. The container runs as uid 1001, so run `chown -R 1001:1001 ./data ./media` on the host before the first start, or SQLite and the media handler won't be able to write to them.

### npm (global install)

Requires Node.js 25 (see [.nvmrc](.nvmrc)).

```bash
npm install -g @fa-krug/yana
yana
```

or run it without installing anything permanently:

```bash
npx @fa-krug/yana
```

By default Yana listens on port 3000 and stores its database and media under `~/.yana`. Both are configurable:

```bash
yana --port 3001 --data-dir /var/lib/yana
```

| Flag                    | Environment variable | Default   | Meaning                                        |
| ----------------------- | -------------------- | --------- | ---------------------------------------------- |
| `-p, --port <number>`   | `PORT`               | `3000`    | Port to listen on                              |
| `-d, --data-dir <path>` | `YANA_DATA_DIR`      | `~/.yana` | Where the SQLite database and media are stored |
| `-v, --version`         |                      |           | Print the installed version                    |
| `-h, --help`            |                      |           | Print usage                                    |

The SQLite file lands at `<data-dir>/yana.db`, article images and feed logos at `<data-dir>/media/`. Migrations run automatically on every start, whether you're on Docker or npm, so there's no separate migration command to remember.

## First login

The first start against a fresh, empty database bootstraps an administrator account and prints its credentials to the log: `admin@admin.com` / `admin`. Sign in at `/login` and change the password right away. Until you do, anyone who can reach the server is an administrator.

A few things about this account are worth knowing. Every later start checks whether _any_ admin exists, not whether this particular address exists, so if you rename the account (change its email) it never comes back on a later start; that's how you make it yours for good. If you delete it while it's the only admin, the next start creates it again with the same published password, because an instance should never be left with no administrator at all. Promote someone else to admin first if you actually want it gone. And if you demote or ban it while it's the only admin, the next start restores its role (and logs that it did) rather than locking you out, though its password is left untouched either way. Promoting another user first avoids all of this.

There's no public sign-up. Every account is created by an administrator from the Users page in the web UI.

## Configuration

Yana reads its configuration from environment variables. Almost everything has a sane default; the one you actually need to set is the auth secret.

Set `BETTER_AUTH_SECRET` before deploying anywhere reachable by anyone but you. It signs session cookies, and without it Better Auth falls back to a well-known development secret that anyone could use to forge a session. It also refuses to start at all once `NODE_ENV=production` is set, so nobody can sign in either way.

```bash
openssl rand -base64 32
```

Changing the secret later signs everyone out.

[.env.example](.env.example) has the full list. Copy it to `.env` (or set the same variables in your compose file or hosting platform) and adjust as needed. The ones you're most likely to touch:

| Variable                         | Purpose                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`             | Signs session cookies. Set this.                                               |
| `DATABASE_PATH` / `MEDIA_PATH`   | Where the database and uploaded media live                                     |
| `PASSKEY_RP_ID` / `PUBLIC_URL`   | The domain/origin passkeys are bound to; required if you're not on `localhost` |
| `TZ`                             | Time zone used to format dates in the UI                                       |
| `SMTP_HOST` (+ related `SMTP_*`) | Turns on error-notification email; leave it unset to disable the feature       |

If you're running Yana behind a real domain, pay attention to `PASSKEY_RP_ID`/`PUBLIC_URL`. A mismatch between these and the domain your browser actually shows is the most common passkey problem, and browsers report it with a generic error that doesn't name the cause.

## Data & backups

| Path                             | Contents                                                |
| -------------------------------- | ------------------------------------------------------- |
| `data/yana.db` (+ `-wal`/`-shm`) | The SQLite database: users, feeds, articles, settings   |
| `media/`                         | Hosted article images and feed logos, content-addressed |

Both live under the data directory (`./data`/`./media` for Docker Compose, or wherever `--data-dir` points for npm) and both start out empty. Back up that directory before upgrading. Migrations run automatically and unattended against a live database, and nothing here takes a backup for you. Stopping the server and copying the directory is enough.

## Upgrading

With Docker, pull the new image (or rebuild) and restart the container. Migrations apply on the next start. With npm, run `npm install -g @fa-krug/yana@latest` and start it again. Your existing data in `~/.yana` (or your custom `--data-dir`) is preserved and migrated in place.

## Getting help

Something not working? Open an issue with what you tried, what you expected, and what actually happened. Logs and your `docker-compose.yml` or CLI invocation help a lot.

Want to build or contribute instead? See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

See [LICENSE](LICENSE).
