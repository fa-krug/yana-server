# syntax=docker/dockerfile:1

# ---------- deps: install with build tooling available ----------
# Node 25 to match .nvmrc (25.6.1) and package.json's engines.node (>=25.0.0
# <26) -- all three must name the same line, not the "Node LTS" the original
# plan text suggested.
FROM node:25-alpine AS deps
WORKDIR /build

# better-sqlite3@13.0.2 ships N-API prebuilds for all 8 platform/arch targets,
# including linux musl (see prebuilds/linuxmusl-{x64,arm64}.node), so `npm ci`
# does not actually compile it from source here -- this is probably dead
# weight today. Kept anyway: it is confined to this stage, never reaches the
# runtime image, and is cheap insurance against a future dependency that does
# need a compiler.
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
# `npm ci` fails if the lockfile is stale rather than silently resolving
# something else -- the equivalent of `uv sync --frozen`.
RUN npm ci

# ---------- builder: compile the app ----------
FROM node:25-alpine AS builder
WORKDIR /build
COPY --from=deps /build/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- runtime ----------
FROM node:25-alpine AS runtime
WORKDIR /app

LABEL org.opencontainers.image.title="Yana" \
      org.opencontainers.image.description="Self-hosted RSS aggregator" \
      org.opencontainers.image.source="https://github.com/fa-krug/yana-server"

# HOSTNAME: Next 16's generated standalone server.js does
# `const hostname = process.env.HOSTNAME || '0.0.0.0'`, and Docker sets
# HOSTNAME to the container's short ID in every container. Left unset, the
# server would bind only that container-ID hostname's interface -- not
# 127.0.0.1 -- so a HEALTHCHECK or `docker exec` hitting localhost:3000 would
# fail, and a hostname that fails to resolve can make listen() throw at
# startup. Pin it to 0.0.0.0 so the server binds all interfaces, same as the
# official Next Docker template does for this exact reason. (Derived by
# reading Next's emitted template and Docker's documented HOSTNAME behavior --
# not observed, since this image has never been run.)
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_PATH=/app/data/yana.db

RUN apk add --no-cache tini vips && \
    addgroup -g 1001 -S nodejs && \
    adduser -u 1001 -S nextjs -G nodejs

# `standalone` emits a self-contained server plus a minimal node_modules.
COPY --from=builder --chown=nextjs:nodejs /build/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /build/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /build/public ./public

# Redundant with file tracing, and kept on purpose -- read before deleting.
#
# This COPY used to exist for docker-entrypoint.sh, which applied migrations
# with a bare `node -e` that require()d better-sqlite3 and drizzle-orm from
# /app, outside Next's module graph. That script is gone: the app migrates
# itself at startup (src/instrumentation.ts -> src/lib/startup.ts), so the only
# resolution that matters now is Next's own.
#
# What tracing produces, re-verified by inspecting .next/standalone/node_modules
# after `npm run build` on 16.2.12:
#
#   better-sqlite3  PRESENT -- a native .node binding, so `serverExternalPackages`
#                   keeps it external and Next copies the package (lib/ + all 8
#                   prebuilds).
#   drizzle-orm     ABSENT  -- pure JS, so webpack inlines what the app uses,
#                   the migrator included, into the server chunks.
#
# The drizzle-orm COPY was therefore deleted rather than kept: it is genuinely
# unnecessary now, proven by running the standalone server against a tree with
# no drizzle-orm directory at all -- it migrated an empty data dir and served
# /health 200. This one stays because a native addon is the single thing a
# tracing regression could break with no runtime recovery, and re-copying a
# package Next already placed there is a byte-identical no-op.
#
# Verified: better-sqlite3's runtime require() graph (lib/*.js) is
# self-contained -- it only reaches into its own package (lib/, prebuilds/),
# never into a sibling node_modules package -- so copying this one directory
# needs no transitive closure.
COPY --from=builder --chown=nextjs:nodejs \
    /build/node_modules/better-sqlite3 ./node_modules/better-sqlite3

# drizzle/ must sit at the working directory, because that is where the app
# looks for it: MIGRATIONS_FOLDER in src/lib/db/migrate.ts is
# `path.join(process.cwd(), "drizzle")`, and the standalone server runs with
# cwd = /app. Verified by running .next/standalone/server.js against this exact
# layout, not inferred.
#
# drizzle/ is committed with a placeholder meta/_journal.json
# (version "7", dialect "sqlite", entries: []) so this source directory
# genuinely exists both today (no real migrations yet) and once drizzle-kit
# starts writing real ones in phase 2 -- drizzle-kit only *creates*
# meta/_journal.json when the meta/ folder is absent, and otherwise reads and
# appends to whatever is already there, so this placeholder is the same shape
# drizzle-kit itself would generate and will not conflict with it. Without
# this file, drizzle-orm's migrator throws "Can't find meta/_journal.json"
# instead of treating an empty folder as "no migrations" -- .dockerignore
# must not exclude drizzle/meta (see .dockerignore) or this file never
# reaches the build context in the first place.
COPY --from=builder --chown=nextjs:nodejs /build/drizzle ./drizzle

RUN mkdir -p /app/data /app/media && chown -R nextjs:nodejs /app/data /app/media

USER nextjs
EXPOSE 3000
# A Docker-managed volume (named or anonymous) inherits ownership from what's
# already at this path in the image -- nextjs:nodejs (1001:1001), chowned
# above -- so it's writable out of the box. A bind mount does NOT get chowned
# by Docker; a freshly created host directory is commonly root:root, and
# SQLite needs write permission on the *directory* (for -wal/-shm siblings),
# not just the db file. If bind-mounting (as this image's own dev-run example
# does), run `chown -R 1001:1001 ./data` on the host before first start, or
# use a named volume instead. This is a new requirement versus the Django
# image, which ran as root with no USER directive.
VOLUME ["/app/data", "/app/media"]

# tini only, no wrapper script: docker-entrypoint.sh existed solely to apply
# migrations before `node server.js`, and the app now does that itself at
# startup for every way it runs (dev, npm start, this image) rather than in a
# shell step only the container executed. tini stays as PID 1 so signals and
# zombie reaping behave.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
