# Phase 1: Scaffold — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `yana-next/` as a Next.js + TypeScript + shadcn + Drizzle project with a CI pipeline and container build whose behavior matches the current Django pipeline's exactly.

**Architecture:** A fresh App Router project in a subdirectory of the existing repository. Drizzle talks to SQLite through `better-sqlite3`, with the tuned PRAGMAs from the current custom Django backend applied on every connection. The Docker image uses Next's `standalone` output. CI keeps the current job graph — checks, then parallel AMD64 and ARM64 builds, then a multi-arch manifest, then the Portainer redeploy — with only the commands inside the checks job changing.

**Tech Stack:** Next.js (App Router), TypeScript strict, Tailwind, shadcn/ui, Drizzle ORM, better-sqlite3, Vitest, ESLint, Prettier, Docker.

## Global Constraints

- Project root is **`yana-next/`**. Nothing in this phase touches Django code.
- **Node LTS**, pinned in `.nvmrc`, `package.json` `engines`, and the Dockerfile — all three identical.
- **All dependency versions pinned exactly** — no `^` or `~`. The current `pyproject.toml` pins deliberately and the lockfile reproduces it; `package-lock.json` plus exact pins is the equivalent.
- `tsconfig.json` runs **`strict: true`**. No `any` without a comment naming why.
- CI must keep the existing job graph and job names: `test` → `build-amd64` + `build-arm64` → `publish-manifest` → `deploy`. Registry `docker.io`, image `${{ secrets.DOCKERHUB_USERNAME }}/yana`, arch suffixes `-linux-amd64` / `-linux-arm64`, and the same tag rules (`type=ref,event=branch`, `type=semver` major.minor and version, `type=sha`, `latest` on the default branch only). Pushes happen on `push` events only, never on pull requests.
- SQLite PRAGMAs are **exactly** those in `core/db/backends/sqlite3/base.py`: `journal_mode=WAL`, `synchronous=NORMAL`, `cache_size=-64000`, `mmap_size=268435456`, `temp_store=MEMORY`, `busy_timeout=30000`, `foreign_keys=ON`, `page_size=4096`. Plus `BEGIN IMMEDIATE` for write transactions.
- Line length 100, double quotes — matching the repository's existing Python conventions so the two trees read alike during the overlap.

---

## File Structure

| Path | Responsibility |
|---|---|
| `yana-next/package.json` | Pinned deps, scripts, `engines` |
| `yana-next/.nvmrc` | Node version, single source for local + CI |
| `yana-next/tsconfig.json` | Strict TS config |
| `yana-next/next.config.ts` | `standalone` output, native-module externals |
| `yana-next/eslint.config.mjs` | Flat ESLint config |
| `yana-next/.prettierrc` | Format rules |
| `yana-next/vitest.config.ts` | Test config, path aliases |
| `yana-next/components.json` | shadcn/ui configuration |
| `yana-next/src/lib/db/client.ts` | Drizzle client + PRAGMA application — the only place a connection is opened |
| `yana-next/src/lib/db/schema.ts` | Re-export barrel; tables land in phase 2 |
| `yana-next/drizzle.config.ts` | Migration generation config |
| `yana-next/Dockerfile` | Multi-stage build |
| `yana-next/docker-entrypoint.sh` | Migrate, then exec the server |
| `.github/workflows/ci-next.yml` | Parallel pipeline; replaces `ci.yml` in phase 14 |

---

### Task 1: Create the project and pin the toolchain

**Files:**
- Create: `yana-next/` (via `create-next-app`)
- Create: `yana-next/.nvmrc`, `yana-next/.prettierrc`, `yana-next/.prettierignore`
- Modify: `yana-next/package.json`, `yana-next/tsconfig.json`, `yana-next/next.config.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: npm scripts `lint`, `format`, `format:check`, `typecheck`, `test`, `dev`, `build`, `start`. Every later phase and the CI workflow call these names.

- [ ] **Step 1: Determine and record the versions**

```bash
node --version
npm view next version
npm view drizzle-orm version
npm view better-sqlite3 version
```

Write the exact outputs into the pins below. Do not substitute a remembered version — the point of pinning is that the recorded value is the one that was tested.

- [ ] **Step 2: Scaffold**

```bash
cd /Users/skrug/PycharmProjects/yana-server
npx create-next-app@latest yana-next \
  --typescript --tailwind --eslint --app --src-dir \
  --import-alias "@/*" --no-turbopack --use-npm
```

- [ ] **Step 3: Pin Node**

```bash
cd yana-next
node --version | sed 's/^v//' > .nvmrc
```

Then add to `package.json`, using the same major:

```json
  "engines": {
    "node": ">=22.0.0 <23"
  }
```

- [ ] **Step 4: Add Prettier and the scripts**

```bash
npm install --save-exact --save-dev prettier eslint-config-prettier
```

`.prettierrc`:

```json
{
  "printWidth": 100,
  "singleQuote": false,
  "semi": true,
  "trailingComma": "all",
  "plugins": []
}
```

`.prettierignore`:

```
.next
node_modules
drizzle/
*.golden.json
```

Goldens are generated artifacts with their own formatting contract — reformatting them would produce a spurious diff against phase 0's records.

`package.json` scripts:

```json
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
```

- [ ] **Step 5: Wire Prettier into ESLint and confirm strict TS**

`eslint.config.mjs` — append `eslint-config-prettier` last so it wins on formatting rules:

```js
import { FlatCompat } from "@eslint/eslintrc";
import prettier from "eslint-config-prettier";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

export default [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  prettier,
  { ignores: [".next/**", "node_modules/**", "drizzle/**"] },
];
```

Confirm `tsconfig.json` has `"strict": true` — `create-next-app` sets it, but verify rather than assume.

- [ ] **Step 6: Configure Next for a native module and standalone output**

`next.config.ts`:

```ts
import type { NextConfig } from "next";

const config: NextConfig = {
  // The Docker image copies .next/standalone; without this the image would
  // need the full node_modules tree.
  output: "standalone",
  // better-sqlite3 is a native addon. Bundling it breaks the .node binding
  // resolution, so it must stay external and be require()d at runtime.
  serverExternalPackages: ["better-sqlite3"],
};

export default config;
```

- [ ] **Step 7: Verify the toolchain runs**

```bash
npm run lint && npm run format:check && npm run typecheck && npm run build
```

Expected: all four pass. If `format:check` fails on scaffolded files, run `npm run format` once and re-check.

- [ ] **Step 8: Commit**

```bash
cd ..
git add yana-next
git commit -m "feat(next): Scaffold the Next.js project

Versions are pinned exactly rather than with ranges, matching how pyproject.toml
pins: the recorded version is the one that was tested. Node is pinned in .nvmrc,
engines, and later the Dockerfile, all three the same value.

better-sqlite3 is declared external -- it is a native addon and bundling breaks
its .node binding resolution."
```

---

### Task 2: Initialize shadcn/ui

**Files:**
- Create: `yana-next/components.json`, `yana-next/src/lib/utils.ts`, `yana-next/src/components/ui/*`
- Modify: `yana-next/src/app/globals.css`

**Interfaces:**
- Consumes: Task 1's Tailwind setup.
- Produces: the `cn()` helper at `@/lib/utils`, and `@/components/ui/*` primitives. Phase 3 onward imports from these paths.

- [ ] **Step 1: Run the initializer**

```bash
cd yana-next
npx shadcn@latest init
```

Choose the neutral base colour and CSS variables — phase 3's theme switching depends on variables rather than hardcoded classes.

- [ ] **Step 2: Add the primitives phases 3–10 need**

```bash
npx shadcn@latest add button input label card table dialog dropdown-menu \
  form select checkbox switch tabs sonner skeleton breadcrumb sidebar \
  avatar badge separator sheet tooltip alert-dialog textarea
```

`skeleton`, `breadcrumb`, `sidebar` and `sonner` are the four phase 3 specifically requires. `alert-dialog` is what phase 5's delete confirmation uses.

- [ ] **Step 3: Verify it builds and lints**

```bash
npm run lint && npm run typecheck && npm run build
```

Expected: pass. shadcn writes generated components that occasionally trip a lint rule; fix by adjusting the component, not by disabling the rule globally.

- [ ] **Step 4: Commit**

```bash
cd ..
git add yana-next
git commit -m "feat(next): Add shadcn/ui with the primitives phases 3-10 need

CSS variables rather than hardcoded colours, because phase 3's theme switch
depends on them."
```

---

### Task 3: Wire Drizzle to SQLite with the tuned PRAGMAs

The current custom Django backend exists because default SQLite settings are wrong for this workload. Those settings do not survive a framework change on their own — they have to be reapplied deliberately.

**Files:**
- Create: `yana-next/src/lib/db/client.ts`, `yana-next/src/lib/db/schema.ts`, `yana-next/drizzle.config.ts`
- Test: `yana-next/src/lib/db/client.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `getDb(): BetterSQLite3Database<typeof schema>` — the singleton client. Every later phase imports this and nothing else opens a connection.
  - `applyPragmas(connection: Database.Database): void` — exported for the test.
  - `DB_PATH: string` — resolved from `DATABASE_PATH`, defaulting to `./data/yana.db`.

- [ ] **Step 1: Install**

```bash
cd yana-next
npm install --save-exact drizzle-orm better-sqlite3
npm install --save-exact --save-dev drizzle-kit @types/better-sqlite3 vitest
```

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/db/client.test.ts
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { applyPragmas } from "./client";

function read(connection: Database.Database, pragma: string): unknown {
  const row = connection.pragma(pragma, { simple: true });
  return row;
}

describe("applyPragmas", () => {
  it("applies every setting the Django backend applied", () => {
    const connection = new Database(":memory:");
    applyPragmas(connection);

    // An in-memory database cannot use WAL, so journal_mode is asserted
    // separately against a file database below.
    expect(read(connection, "synchronous")).toBe(1); // NORMAL
    expect(read(connection, "cache_size")).toBe(-64000);
    expect(read(connection, "mmap_size")).toBe(268435456);
    expect(read(connection, "temp_store")).toBe(2); // MEMORY
    expect(read(connection, "foreign_keys")).toBe(1);
    connection.close();
  });

  it("enables WAL on a file database", () => {
    const path = `/tmp/yana-pragma-${process.pid}.db`;
    const connection = new Database(path);
    applyPragmas(connection);

    expect(read(connection, "journal_mode")).toBe("wal");
    connection.close();
  });

  it("enforces foreign keys, which better-sqlite3 leaves off by default", () => {
    const connection = new Database(":memory:");
    applyPragmas(connection);
    connection.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
    connection.exec(
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))",
    );

    expect(() => connection.exec("INSERT INTO child (parent_id) VALUES (999)")).toThrow(
      /FOREIGN KEY constraint failed/,
    );
    connection.close();
  });
});
```

- [ ] **Step 3: Add the Vitest config, then run the test to confirm it fails**

`vitest.config.ts`:

```ts
import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"] },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "./src") } },
});
```

```bash
npm test
```

Expected: FAIL — `applyPragmas` is not exported from a module that does not exist.

- [ ] **Step 4: Write the client**

```ts
// src/lib/db/client.ts
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema";

export const DB_PATH = process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "yana.db");

/**
 * The PRAGMA set from the retired Django backend
 * (core/db/backends/sqlite3/base.py). These are not defaults and do not
 * survive a framework change on their own.
 */
export function applyPragmas(connection: Database.Database): void {
  // Concurrency: readers do not block the writer.
  connection.pragma("journal_mode = WAL");
  // Balanced durability -- survives process crash, not OS crash.
  connection.pragma("synchronous = NORMAL");
  // Negative means KiB, so this is 64 MB.
  connection.pragma("cache_size = -64000");
  // 256 MB memory-mapped I/O; should be >= cache_size.
  connection.pragma("mmap_size = 268435456");
  connection.pragma("temp_store = MEMORY");
  connection.pragma("page_size = 4096");
  // better-sqlite3 leaves this OFF by default. Django turned it on, and the
  // schema's cascade behavior depends on it.
  connection.pragma("foreign_keys = ON");
  // 30s. Necessary but NOT sufficient on its own -- see the transaction note.
  connection.pragma("busy_timeout = 30000");
}

let cached: BetterSQLite3Database<typeof schema> | undefined;

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (cached) return cached;

  const connection = new Database(DB_PATH);
  applyPragmas(connection);
  cached = drizzle(connection, { schema });
  return cached;
}
```

- [ ] **Step 5: Add the immediate-transaction helper**

`busy_timeout` alone does not prevent the WAL read-to-write lock-upgrade deadlock — that is why the Django settings also set `transaction_mode="IMMEDIATE"`. Append to `client.ts`:

```ts
/**
 * Run `work` inside a BEGIN IMMEDIATE transaction.
 *
 * SQLite's default DEFERRED mode takes a read lock first and upgrades on the
 * first write. Two concurrent upgraders deadlock, and busy_timeout cannot help
 * because neither can proceed. IMMEDIATE takes the write lock up front, so one
 * waits instead. Every write path uses this.
 */
export function writeTransaction<T>(work: (tx: BetterSQLite3Database<typeof schema>) => T): T {
  const db = getDb();
  const connection = (db as unknown as { $client: Database.Database }).$client;
  connection.exec("BEGIN IMMEDIATE");
  try {
    const result = work(db);
    connection.exec("COMMIT");
    return result;
  } catch (error) {
    connection.exec("ROLLBACK");
    throw error;
  }
}
```

- [ ] **Step 6: Create the empty schema barrel and Drizzle config**

`src/lib/db/schema.ts`:

```ts
// Tables land in phase 2. This barrel exists now so client.ts can type against it.
export {};
```

`drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_PATH ?? "./data/yana.db" },
  strict: true,
  verbose: true,
});
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm test
```

Expected: PASS, all three. The foreign-key test is the one that matters most — it fails loudly if the PRAGMA is ever dropped.

- [ ] **Step 8: Verify the native module has prebuilds for both CI architectures**

Phase 15 depends on `npm install yana` working without a compiler. Establish that now rather than discovering it at the end.

```bash
npm view better-sqlite3 versions --json | tail -5
ls node_modules/better-sqlite3/prebuilds 2>/dev/null || \
  echo "no prebuilds dir - build-from-source required, note this for phase 15"
```

Record the finding in the commit message. If prebuilds are absent for linux/arm64, the Dockerfile in Task 5 needs build tooling in its builder stage, and phase 15 needs a strategy.

- [ ] **Step 9: Commit**

```bash
cd ..
git add yana-next
git commit -m "feat(next): Wire Drizzle to SQLite with the tuned PRAGMAs

Ports the PRAGMA set from the retired custom Django backend verbatim. These are
not SQLite defaults and do not survive a framework change on their own.

Two are easy to lose and expensive to lose:
- foreign_keys=ON, which better-sqlite3 leaves off by default while Django turned
  it on, so the schema's cascades depend on it. A test asserts a violation throws.
- BEGIN IMMEDIATE for writes. busy_timeout does not cover the WAL
  read-to-write lock-upgrade deadlock, which is why the Django settings set
  transaction_mode=IMMEDIATE alongside it."
```

---

### Task 4: Containerize

**Files:**
- Create: `yana-next/Dockerfile`, `yana-next/docker-entrypoint.sh`, `yana-next/.dockerignore`

**Interfaces:**
- Consumes: Task 1's `standalone` output and `build` script.
- Produces: an image exposing port 3000 with a `/health` expectation (the route itself lands in phase 3), and `DATABASE_PATH` as the data location.

- [ ] **Step 1: Write `.dockerignore`**

```
node_modules
.next
.git
*.md
drizzle/meta
data
```

- [ ] **Step 2: Write the Dockerfile**

Mirrors the current Dockerfile's shape: a builder stage with compilers, a slim runtime stage, tini as PID 1, a non-root user.

```dockerfile
# syntax=docker/dockerfile:1

# ---------- deps: install with build tooling available ----------
FROM node:22-alpine AS deps
WORKDIR /build

# better-sqlite3 compiles from source when no prebuild matches the platform.
# Kept out of the runtime stage entirely.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
# `npm ci` fails if the lockfile is stale rather than silently resolving
# something else -- the equivalent of `uv sync --frozen`.
RUN npm ci

# ---------- builder: compile the app ----------
FROM node:22-alpine AS builder
WORKDIR /build
COPY --from=deps /build/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app

LABEL org.opencontainers.image.title="Yana" \
      org.opencontainers.image.description="Self-hosted RSS aggregator" \
      org.opencontainers.image.source="https://github.com/fa-krug/yana-server"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    DATABASE_PATH=/app/data/yana.db

RUN apk add --no-cache tini vips && \
    addgroup -g 1001 -S nodejs && \
    adduser -u 1001 -S nextjs -G nodejs

# `standalone` emits a self-contained server plus a minimal node_modules.
COPY --from=builder --chown=nextjs:nodejs /build/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /build/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /build/public ./public
COPY --from=builder --chown=nextjs:nodejs /build/drizzle ./drizzle
COPY --chown=nextjs:nodejs docker-entrypoint.sh /usr/local/bin/

RUN chmod +x /usr/local/bin/docker-entrypoint.sh && \
    mkdir -p /app/data /app/media && chown -R nextjs:nodejs /app/data /app/media

USER nextjs
EXPOSE 3000
VOLUME ["/app/data", "/app/media"]

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
```

`vips` is installed because `sharp` needs libvips at runtime; phase 11a starts using it, and having it here from the start avoids a surprise image rebuild mid-port.

- [ ] **Step 3: Write the entrypoint**

Mirrors `docker-entrypoint.sh`'s current behavior — migrate, then exec — minus the superuser block, which phase 4 replaces with the admin bootstrap.

```bash
#!/bin/sh
set -e

echo "=== Yana startup ==="

# No database wait: SQLite is a local file, so nothing has to become reachable.
echo "Applying migrations..."
node -e "
const Database = require('better-sqlite3');
const { drizzle } = require('drizzle-orm/better-sqlite3');
const { migrate } = require('drizzle-orm/better-sqlite3/migrator');
const db = drizzle(new Database(process.env.DATABASE_PATH));
migrate(db, { migrationsFolder: './drizzle' });
console.log('Migrations applied.');
" || { echo 'ERROR: migration failed'; exit 1; }

echo "Starting: $@"
exec "$@"
```

- [ ] **Step 4: Build and run the image**

```bash
cd yana-next
docker build -t yana-next:dev .
docker run --rm -p 3000:3000 -v "$(pwd)/data:/app/data" yana-next:dev
```

Expected: migrations report success (there are none yet, which is not an error), the server starts, and `http://localhost:3000` serves the default Next page.

- [ ] **Step 5: Commit**

```bash
cd ..
git add yana-next/Dockerfile yana-next/docker-entrypoint.sh yana-next/.dockerignore
git commit -m "feat(next): Containerize with a multi-stage build

Mirrors the current image's shape: compilers confined to a builder stage, tini as
PID 1, non-root user, volumes for data and media. npm ci rather than npm install
so a stale lockfile fails the build instead of silently resolving something that
was never tested -- the equivalent of uv sync --frozen.

libvips is installed now although sharp only arrives in 11a, so the port does not
stall on an image rebuild."
```

---

### Task 5: Port the CI pipeline

**Files:**
- Create: `.github/workflows/ci-next.yml`

**Interfaces:**
- Consumes: Task 1's npm scripts, Task 4's Dockerfile.
- Produces: a workflow with the same job graph and names as `ci.yml`. It runs in parallel with `ci.yml` until phase 14 removes the latter.

- [ ] **Step 1: Read the existing workflow end to end**

```bash
cat .github/workflows/ci.yml
```

The `deploy` job's Portainer step was truncated in earlier reading — read it fully and copy it verbatim. Getting the deploy wrong is the one failure here with production consequences.

- [ ] **Step 2: Write the workflow**

```yaml
name: CI/CD (Next)

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  REGISTRY: docker.io
  IMAGE_NAME: ${{ secrets.DOCKERHUB_USERNAME }}/yana

defaults:
  run:
    working-directory: yana-next

jobs:
  test:
    name: Lint & Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: yana-next/.nvmrc
          cache: npm
          cache-dependency-path: yana-next/package-lock.json

      # Fails on a stale lockfile rather than resolving something untested.
      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Format check
        run: npm run format:check

      - name: Type check
        run: npm run typecheck

      - name: Test
        run: npm test
```

Then append `build-amd64`, `build-arm64`, `publish-manifest` and `deploy`, copied from `ci.yml` with three changes only: `context: ./yana-next`, `needs: [test]` unchanged, and no `working-directory` on the docker jobs (they use `context` instead).

- [ ] **Step 3: Validate the YAML**

```bash
cd .. && uv run python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci-next.yml')); print('valid')"
```

- [ ] **Step 4: Confirm the job graph matches**

```bash
grep -E "^  [a-z-]+:|needs:|name:" .github/workflows/ci.yml
grep -E "^  [a-z-]+:|needs:|name:" .github/workflows/ci-next.yml
```

Compare by eye. Job names, `needs:` edges, and the `if:` conditions on `deploy` must correspond exactly. A divergence here means the two pipelines are not actually equivalent, which is the thing this task exists to guarantee.

- [ ] **Step 5: Commit and verify on a branch**

```bash
git add .github/workflows/ci-next.yml
git commit -m "ci(next): Add the Next.js pipeline alongside the Django one

Same job graph, names, tag rules, arch suffixes and Portainer deploy as ci.yml --
only the commands inside the checks job differ. Both run until phase 14 removes
ci.yml, so a regression in either is visible."
git push -u origin HEAD
```

Then confirm in the Actions tab that `test` passes and the build jobs run. Do **not** merge to `main` until the build jobs are green: `main` triggers the deploy.

---

## Self-Review

**Spec coverage.** Against the direction record's stack table and bullet 1:

| Requirement | Task |
|---|---|
| Next.js App Router + TypeScript strict | 1 |
| shadcn/ui + Tailwind | 2 |
| Drizzle + better-sqlite3 | 3 |
| PRAGMAs ported exactly | 3 |
| ESLint + Prettier | 1 |
| Vitest | 3 Step 3 |
| Container build | 4 |
| Pipeline with existing behavior | 5 |
| `better-sqlite3` prebuild coverage verified in phase 1, not 15 | 3 Step 8 |

`sonner`, `next-intl` and Better Auth are **not** installed here — they belong to the phases that first use them (3, 3, and 4). Installing them now would put unused dependencies in the lockfile.

**Placeholder scan.** No TBDs. Task 1 Step 1 and Task 5 Step 1 direct the engineer to read actual values rather than trusting this document — deliberate: exact versions and the Portainer deploy step were not resolved while writing this plan, and inventing either would be worse than looking.

**Type consistency.** `getDb()`, `applyPragmas()`, `writeTransaction()` and `DB_PATH` are defined in Task 3 Steps 4–5 and referenced consistently. The schema barrel path `@/lib/db/schema` matches `drizzle.config.ts`'s `./src/lib/db/schema.ts` and phase 2's expectation. Script names in Task 1 Step 4 match those the workflow calls in Task 5 Step 2.

**One open risk.** Task 3 Step 5 reaches through `db.$client` to get the underlying connection for `BEGIN IMMEDIATE`. That is an internal of the Drizzle adapter and could change across versions. If it breaks, the fallback is to keep the `Database` instance in a module-level variable alongside `cached` and use it directly — functionally identical, marginally less tidy. Worth a comment in the code either way.
