# Installation & Usage Guide

Yana is a self-hosted RSS aggregator built with Next.js, React, TypeScript, and SQLite.

You can run Yana via **npm** or **Docker**.

---

## Method 1: Global npm Package (Recommended)

### Prerequisites
- **Node.js**: v25.x (see `.nvmrc`)

### Installation
Install the package globally:

```bash
npm install -g @fa-krug/yana
```

### Running Yana

Start Yana with the default settings (port `3000`, data directory `~/.yana`):

```bash
yana
```

Or using `npx`:

```bash
npx @fa-krug/yana
```

### Options & Configuration

You can customize the listening port and data directory using command-line flags or environment variables:

```bash
yana --port 3001 --data-dir /var/lib/yana
```

#### CLI Flags
- `-p, --port <number>`: Port to listen on (default: `3000`, or `$PORT`).
- `-d, --data-dir <path>`: Path to store SQLite database & media (default: `~/.yana`, or `$YANA_DATA_DIR`).
- `-v, --version`: Display installed Yana version.
- `-h, --help`: Display help message.

#### Environment Variables
- `PORT`: Server port (e.g. `PORT=8080`).
- `YANA_DATA_DIR`: Base directory for SQLite database file (`yana.db`).
- `DATABASE_PATH`: Explicit path to the SQLite database file (overrides `$YANA_DATA_DIR/yana.db`).

---

## Method 2: Docker Container

Run Yana using Docker Compose:

```bash
docker compose up --build -d
```

Or using `docker run`:

```bash
docker run -d \
  -p 3000:3000 \
  -v /var/lib/yana/data:/app/data \
  -v /var/lib/yana/media:/app/media \
  --name yana \
  ghcr.io/fa-krug/yana:latest
```

---

## Default Admin Credentials & Initial Setup

On the first boot against a fresh database, Yana automatically applies database migrations and bootstraps an initial administrator account if no admin exists:

- **Default Email**: `admin@localhost`
- **Default Password**: `adminpassword`

> [!IMPORTANT]
> Log in immediately at `http://localhost:3000/login` and change the default password under **Account Settings** (`/account`).

---

## Upgrades

### Upgrading npm Package
To upgrade to the latest version:

```bash
npm install -g @fa-krug/yana@latest
```

All SQLite migrations run automatically on startup. Existing database data in `~/.yana` (or your custom `--data-dir`) is preserved and migrated in place.

---

## Data & Storage Location

- **Database File**: `<data-dir>/yana.db`
- **Article Images & Logos**: `<data-dir>/media/`
