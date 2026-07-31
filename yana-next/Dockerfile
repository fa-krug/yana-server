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

# Next's file tracing only bundles a module into .next/standalone/node_modules
# if some traced page/route actually imports it. No route imports the DB
# client yet (Task 3 built the client and its tests, but nothing under src/app
# references it -- that lands with the API in a later phase), so the pruned
# tree above does NOT contain better-sqlite3 or drizzle-orm. docker-entrypoint.sh
# requires() both directly to run migrations, independent of the traced app.
# Copy them explicitly from the builder's full (untraced) node_modules so the
# entrypoint resolves them regardless of what the app itself references.
# Verified: better-sqlite3's runtime require() graph (lib/*.js) is
# self-contained -- it only reaches into its own package (lib/, prebuilds/),
# never into a sibling node_modules package -- and drizzle-orm ships no
# runtime "dependencies" of its own (only optional driver peerDependencies),
# so copying just these two package directories is sufficient; no transitive
# closure is needed.
COPY --from=builder --chown=nextjs:nodejs /build/node_modules/better-sqlite3 ./node_modules/
COPY --from=builder --chown=nextjs:nodejs /build/node_modules/drizzle-orm ./node_modules/

# yana-next/drizzle/ is committed with a placeholder meta/_journal.json
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
COPY --chown=nextjs:nodejs docker-entrypoint.sh /usr/local/bin/

RUN chmod +x /usr/local/bin/docker-entrypoint.sh && \
    mkdir -p /app/data /app/media && chown -R nextjs:nodejs /app/data /app/media

USER nextjs
EXPOSE 3000
VOLUME ["/app/data", "/app/media"]

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server.js"]
