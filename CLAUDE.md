# CLAUDE.md

This file provides guidance for AI assistants working on the Yana codebase.

## Project Overview

**Yana** is a self-hosted Django 6.0 RSS aggregator. It aggregates content from multiple sources (RSS, YouTube, Reddit, Podcasts, specialized website scrapers) into a SQLite store, inspected and managed through the Django admin. A tailored HTTP API for the first-party iOS/macOS client is in design; the server currently exposes no article API.

**Key characteristics:**
- Python 3.13+ / Django 6.0
- SQLite only, via a tuned custom backend (no other engine is supported)
- Background task processing with django-q2 (ORM broker, no Redis required)
- 16 pluggable aggregator implementations
- Comprehensive test suite with pytest

## Quick Reference

```bash
# Dependencies are managed with uv. First-time setup:
uv sync --all-groups

# Prefix commands with `uv run` -- no venv activation needed.
# (`uv run python manage.py …` for Django, `uv run pytest` for tests.)

# Development
uv run python manage.py runserver              # Dev server at http://localhost:8000
uv run python manage.py test                   # Run all tests
uv run pytest                                   # Run tests with coverage
uv run pytest core/tests/test_models.py         # Run specific test file
uv run pytest -k "youtube"                      # Run tests matching keyword

# Database
uv run python manage.py makemigrations && uv run python manage.py migrate
uv run python manage.py createsuperuser

# Linting & Formatting
uv run ruff check core/                         # Lint check
uv run ruff check core/ --fix                   # Lint with auto-fix
uv run ruff format core/                        # Format code

# Type checking
uv run mypy core/

# Aggregator debugging (PRIMARY TOOL)
uv run python manage.py test_aggregator 5                    # By feed ID
uv run python manage.py test_aggregator tagesschau           # By type (uses default)
uv run python manage.py test_aggregator 5 --verbose          # Detailed output
uv run python manage.py test_aggregator 5 --dry-run          # Test without saving
uv run python manage.py test_aggregator 5 --limit 3          # Limit articles
uv run python manage.py test_aggregator 5 --first 2          # Show first N details

# SQLite maintenance
uv run python manage.py verify_sqlite_optimizations
uv run python manage.py optimize_sqlite --analyze

# Docker
docker-compose up
curl http://localhost:8000/health/
```

**URLs:**
- Admin: `http://localhost:8000/admin/`
- Health: `http://localhost:8000/health/`

## Project Structure

```
Yana/
├── yana/                          # Django project settings
│   ├── settings.py               # Configuration (env-based)
│   ├── urls.py                   # Root URL routing
│   └── wsgi.py / asgi.py
│
├── core/                          # Main application
│   ├── models.py                 # FeedGroup, Feed, Article, UserSettings
│   ├── admin.py                  # Django admin with DjangoQL, bulk actions
│   ├── choices.py                # AGGREGATOR_CHOICES (16 types)
│   ├── forms.py                  # FeedAdminForm, UserSettingsAdminForm
│   ├── ai_client.py              # AI integration (OpenAI, Anthropic, Gemini)
│   │
│   ├── aggregators/              # Content fetching (CORE MODULE)
│   │   ├── base.py              # BaseAggregator (Template Method pattern)
│   │   ├── registry.py          # AggregatorRegistry factory
│   │   ├── rss.py               # RssAggregator base
│   │   ├── website.py           # FullWebsiteAggregator
│   │   ├── youtube/             # YouTube channel aggregator
│   │   ├── reddit/              # Reddit subreddit aggregator
│   │   ├── podcast/             # Podcast feed aggregator
│   │   ├── heise/               # Heise.de news
│   │   ├── tagesschau/          # ARD Tagesschau
│   │   ├── merkur/              # Merkur.de
│   │   ├── mein_mmo/            # MeinMMO (reference implementation)
│   │   ├── caschys_blog/        # Caschys Blog
│   │   ├── mactechnews/         # MacTechNews
│   │   ├── explosm/             # Cyanide & Happiness
│   │   ├── dark_legacy/         # Dark Legacy Comics
│   │   ├── oglaf/               # Oglaf comics
│   │   └── utils/               # Shared utilities
│   │       ├── html_fetcher.py      # HTTP with retries
│   │       ├── content_extractor.py # HTML extraction
│   │       ├── html_cleaner.py      # Sanitization
│   │       ├── rss_parser.py        # RSS/Atom parsing
│   │       └── youtube_client.py    # YouTube API
│   │
│   ├── services/                 # Business logic layer
│   │   ├── aggregator_service.py    # Feed aggregation
│   │   ├── article_service.py       # Article operations
│   │   ├── email_service.py         # Email notifications
│   │   └── maintenance_service.py   # DB maintenance
│   │
│   ├── views/
│   │   └── default.py               # Health, YouTube proxy, Dailymotion proxy
│   │
│   ├── urls/
│   │   └── default.py               # Health, proxy routes
│   │
│   ├── db/backends/sqlite3/         # Optimized SQLite backend
│   │
│   ├── management/commands/         # CLI commands
│   │   ├── test_aggregator.py       # Primary debugging tool
│   │   ├── trigger_aggregator.py    # Manual feed trigger
│   │   ├── optimize_sqlite.py       # DB optimization
│   │   └── verify_sqlite_optimizations.py
│   │
│   └── tests/                       # Test suite (34+ test files)
│       ├── conftest.py              # Pytest fixtures
│       ├── test_*.py                # Test modules
│       └── fixtures/                # Test data
│
├── pyproject.toml                   # Dependencies + tool config (ruff, mypy, pytest)
├── uv.lock                          # Locked dependency versions
├── Dockerfile                       # Multi-stage build
├── docker-compose.yml               # Dev environment
└── .pre-commit-config.yaml          # Pre-commit hooks
```

## Code Standards

### Style & Formatting

| Rule | Standard |
|------|----------|
| Line length | 100 characters (configured in pyproject.toml) |
| Quotes | Double quotes for strings |
| Formatting | `ruff format` (PEP 8 compliant) |
| Imports | Sorted with isort (Django-aware sections) |
| Type hints | Encouraged, checked with mypy |

### Linting Rules (Ruff)

Enabled rule sets: `E`, `F`, `W`, `I`, `B`, `SIM`, `C4`, `DJ`
- **E/W**: pycodestyle errors and warnings
- **F**: Pyflakes
- **I**: isort import ordering
- **B**: flake8-bugbear
- **SIM**: flake8-simplify
- **C4**: flake8-comprehensions
- **DJ**: Django best practices

### Django Conventions

```python
# Models: Always include __str__ and Meta
class Article(models.Model):
    name = models.CharField(max_length=500)
    # ... fields

    class Meta:
        ordering = ["-date"]
        indexes = [models.Index(fields=["feed", "-date"])]

    def __str__(self):
        return self.name

# Views: Thin views, logic in services
def my_view(request, feed_id):
    feed = get_object_or_404(Feed, id=feed_id)
    result = my_service.process(feed)
    return JsonResponse(result)

# Queries: Always optimize
Article.objects.select_related("feed").filter(...)
Feed.objects.prefetch_related("article_set").all()

# AVOID N+1 queries:
# Bad: for article in Article.objects.all(): print(article.feed.name)
# Good: for article in Article.objects.select_related("feed").all(): ...
```

### Testing Conventions

- Framework: pytest with pytest-django
- Coverage target: >80%
- Test location: `core/tests/test_*.py`
- Use fixtures from `core/tests/conftest.py`

```python
import pytest
from core.models import Feed

@pytest.mark.django_db
def test_feed_creation(user):
    feed = Feed.objects.create(
        name="Test Feed",
        aggregator="rss",
        identifier="https://example.com/feed.xml",
        user=user,
    )
    assert feed.name == "Test Feed"
```

**Available fixtures:** `user`, `user_with_settings`, `rss_feed`, `reddit_feed`, `youtube_feed`, `feed_group`, `article`, `articles_batch`

## Key Models

| Model | Key Fields | Notes |
|-------|-----------|-------|
| `FeedGroup` | name, user | Unique per (name, user) |
| `Feed` | name, aggregator, identifier, user, group, enabled, daily_limit | 16 aggregator types |
| `Article` | name, identifier, content, raw_content, date, read, starred, feed | Use `select_related("feed")` |
| `UserSettings` | user, youtube_api_key, reddit_*, openai_* | API credentials |
| `RedditSubreddit` | name, user | Reddit feed reference |
| `YouTubeChannel` | channel_id, channel_name, user | YouTube feed reference |

**Article dates:** `Article.date` is the feed's real publish time — aggregation never rewrites it.
Use `created_at` (indexed with `id` as tie-breaker) for stable, append-only ordering such as sync
cursors, and for retention (`ArticleService.delete_old_articles`) — `date` is for display only.
Keying retention off `date` would delete articles almost immediately after import whenever their
publish date is already close to the retention cutoff.

## Aggregator System

### Pattern: Template Method

All aggregators inherit from `BaseAggregator` and follow this flow:
1. `validate()` - Check configuration
2. `fetch_source_data()` - Get raw data
3. `parse_to_raw_articles()` - Extract article list
4. `filter_articles()` - Remove duplicates/old
5. `enrich_articles()` - Fetch full content
6. `finalize_articles()` - Clean and format

### Creating a New Aggregator

1. **Add to choices** (`core/choices.py`):
   ```python
   AGGREGATOR_CHOICES = [
       # ...
       ("my_site", "My Site"),
   ]
   ```

2. **Register** (`core/aggregators/registry.py`):
   ```python
   from .my_site.aggregator import MySiteAggregator
   _registry = {
       # ...
       "my_site": MySiteAggregator,
   }
   ```

3. **Implement** (`core/aggregators/my_site/aggregator.py`):
   ```python
   from ..website import FullWebsiteAggregator

   class MySiteAggregator(FullWebsiteAggregator):
       content_selectors = ["div.article-body"]
       selectors_to_remove = ["div.ads", ".social-buttons"]
       uses_first_content_match = True  # body lives in one known container

       def get_source_url(self):
           return "https://mysite.com/rss"
   ```

4. **Migrate**:
   ```bash
   uv run python manage.py makemigrations && uv run python manage.py migrate
   ```

5. **Test**:
   ```bash
   uv run python manage.py test_aggregator my_site --dry-run --verbose
   ```

**Reference implementation:** `core/aggregators/mein_mmo/` (multipage, embeds, custom extraction)

## HTTP Surface

The server has no article API. What is reachable:

| Path | Purpose |
|---|---|
| `/admin/` | Django admin — the verification surface for the current phase |
| `/health/` | Health check |
| `/media/…` | Media files |
| `/static/…` | Static assets (admin CSS/JS) — Django serves them in `DEBUG`, whitenoise in production |
| `/api/youtube-proxy`, `/api/dailymotion-proxy` | Embed proxies (interim) |
| `/*` | Catch-all redirect to admin |

The Google Reader API was removed (see
`docs/superpowers/specs/2026-07-29-remove-greader-api-design.md`). Aggregation
runs via django-q2 scheduled tasks and the `test_aggregator` /
`trigger_aggregator` management commands — none of which touch HTTP.

## SQLite Optimizations

Custom backend at `core/db/backends/sqlite3/` with performance PRAGMAs:

| Setting | Value | Purpose |
|---------|-------|---------|
| journal_mode | WAL | Better concurrency |
| cache_size | 64MB | Larger cache |
| mmap_size | 256MB | Memory-mapped I/O |
| synchronous | NORMAL | Balanced safety/speed |
| temp_store | MEMORY | Faster temp operations |
| busy_timeout | 30000ms | Prevent lock errors |

Plus the `transaction_mode="IMMEDIATE"` connection OPTION (in `settings.py`,
not a PRAGMA) — required to avoid "database is locked" (`SQLITE_BUSY`) errors
under concurrent writers, since `busy_timeout` alone does not cover the WAL
read-to-write lock-upgrade deadlock.

Verify with: `uv run python manage.py verify_sqlite_optimizations`

## Development Workflow

### TDD Approach

1. **Red:** Write failing test first
2. **Green:** Implement minimum code to pass
3. **Refactor:** Clean up with tests as safety net

### Before Committing

```bash
# Run all checks
uv run ruff check core/ --fix
uv run ruff format core/
uv run mypy core/
uv run pytest

# Or use pre-commit hooks
uv run pre-commit run --all-files
```

### Commit Message Format

```
<type>(<scope>): <description>

Types: feat, fix, docs, style, refactor, test, chore
Examples:
  feat(aggregator): Add support for new comic site
  fix(aggregator): Correct duplicate article detection
  test(youtube): Add aggregator integration tests
```

## Environment Variables

```bash
# Required
SECRET_KEY=your-secret-key
ALLOWED_HOSTS=localhost,127.0.0.1

# Optional
DEBUG=True
TIME_ZONE=Europe/Berlin

# Superuser (Docker auto-creation)
SUPERUSER_USERNAME=admin
SUPERUSER_EMAIL=admin@example.com
SUPERUSER_PASSWORD=password

# AI Integration (optional)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
```

## Common Tasks

### Add a new feed type

1. Add choice to `core/choices.py`
2. Create aggregator in `core/aggregators/`
3. Register in `core/aggregators/registry.py`
4. Run migrations
5. Write tests in `core/tests/test_<name>_aggregator.py`

### Debug article content issues

```bash
# See raw vs processed content
uv run python manage.py test_aggregator <id> --first 1 --verbose

# Debug CSS selectors
uv run python manage.py test_aggregator <id> --selector-debug
```

### Fix failing tests

```bash
# Run specific failing test
uv run pytest core/tests/test_models.py::test_article_creation -v

# Run with print statements visible
uv run pytest -s core/tests/test_models.py

# Run last failed only
uv run pytest --lf
```

### Check database performance

```bash
uv run python manage.py verify_sqlite_optimizations
uv run python manage.py optimize_sqlite --analyze
```

## Important Files for AI Assistants

When working on specific features, these files are most relevant:

| Task | Key Files |
|------|-----------|
| New aggregator | `core/choices.py`, `core/aggregators/registry.py`, `core/aggregators/<name>/` |
| HTTP views | `core/views/default.py`, `core/urls/default.py` |
| Models/DB | `core/models.py`, `core/admin.py`, `core/forms.py` |
| Testing | `core/tests/conftest.py`, `core/tests/test_*.py` |
| Configuration | `yana/settings.py`, `pyproject.toml`, `.env.example` |

## References

- `README.md` - User documentation and setup guide
- `core/aggregators/README.md` - Aggregator implementation guide
- `core/db/README.md` - SQLite optimization documentation
