# =============================================================================
# Optimized Dockerfile for Yana - Django RSS Aggregator
# Strategy: Multi-stage build with Alpine base for minimal footprint
# =============================================================================

# Build stage - resolve and install dependencies with uv
FROM python:3.13-alpine AS builder

WORKDIR /build

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    # Copy packages into the venv instead of hardlinking to uv's cache, so the
    # venv stays self-contained when copied into the runtime stage.
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv

# uv ships as a static binary -- no Python bootstrap needed.
COPY --from=ghcr.io/astral-sh/uv:0.11.15 /uv /usr/local/bin/uv

# Build dependencies for native modules (Pillow needs jpeg/zlib headers).
RUN apk add --no-cache \
    gcc \
    g++ \
    musl-dev \
    python3-dev \
    jpeg-dev \
    zlib-dev \
    linux-headers

# Lockfile + manifest only, for layer caching: dependencies are reinstalled
# only when these two files change, not on every source edit.
COPY pyproject.toml uv.lock ./

# --frozen fails the build if uv.lock is stale rather than silently resolving
# something different from what was tested. --no-dev keeps test/lint tooling
# out of the production image.
RUN uv sync --frozen --no-dev --no-install-project

# =============================================================================
# Runtime Stage - Minimal production image (Alpine)
# =============================================================================
FROM python:3.13-alpine AS runtime

WORKDIR /app

# OCI Labels
LABEL org.opencontainers.image.title="Yana" \
      org.opencontainers.image.description="Django RSS aggregator and feed management system" \
      org.opencontainers.image.source="https://github.com/fa-krug/yana-server"

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:$PATH" \
    DJANGO_SETTINGS_MODULE=yana.settings

# Install runtime dependencies and tini.
# libxml2/libxslt are intentionally absent: they existed only for lxml, which
# is no longer a dependency (every BeautifulSoup call uses stdlib html.parser).
RUN apk add --no-cache \
    tini \
    bash \
    libpq \
    libjpeg-turbo \
    curl \
    && mkdir -p /app/data /app/media /app/staticfiles

# Copy virtual environment from builder
COPY --from=builder /opt/venv /opt/venv

# Copy application code
COPY . .

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Collect static files during build (reduces startup time)
RUN python manage.py collectstatic --noinput --clear || true

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:8000/health/ || exit 1

# Use tini as init system for proper signal handling
ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]

# Default command (supervisord manages gunicorn and qcluster)
CMD ["supervisord", "-c", "/app/supervisord.conf"]
