# Aggregators

This directory contains the aggregator implementations for different feed types.

## Overview

The aggregator system follows a modular architecture:

- **Base Aggregator** ([base.py](base.py)) - Abstract base class that all aggregators inherit from
- **Implementations** ([implementations.py](implementations.py)) - Concrete aggregator classes for each feed type
- **Registry** ([registry.py](registry.py)) - Maps feed types to aggregator classes

## Available Aggregators

### Custom Aggregators
- `FullWebsiteAggregator` - Generic web scraper
- `FeedContentAggregator` - RSS/Atom feed parser

### Managed Aggregators (Site-Specific)
- `HeiseAggregator` - Heise news site
- `MerkurAggregator` - Merkur news site
- `TagesschauAggregator` - Tagesschau news site
- `ExplosmAggregator` - Explosm web comics
- `DarkLegacyAggregator` - Dark Legacy Comics
- `CaschysBlogAggregator` - Caschy's Blog
- `MactechnewsAggregator` - MacTechNews
- `OglafAggregator` - Oglaf web comics
- `MeinMmoAggregator` - Mein-MMO gaming site

### Social Aggregators
- `YoutubeAggregator` - YouTube channels
- `RedditAggregator` - Reddit subreddits
- `PodcastAggregator` - Podcast feeds

## Usage

### Using the Service

The `AggregatorService` provides methods to trigger aggregators:

```python
from core.services import AggregatorService

# Trigger a specific feed by ID
result = AggregatorService.trigger_by_feed_id(1)

# Trigger all feeds of a specific type
results = AggregatorService.trigger_by_aggregator_type('youtube')

# Trigger all enabled feeds
results = AggregatorService.trigger_all()

# Trigger with a limit
results = AggregatorService.trigger_all(limit=10)
```

### Using the Management Command

```bash
# Trigger a specific feed
python3 manage.py trigger_aggregator --feed-id 1

# Trigger all feeds of a specific type
python3 manage.py trigger_aggregator --aggregator-type youtube

# Trigger all enabled feeds
python3 manage.py trigger_aggregator --all

# Trigger with a limit
python3 manage.py trigger_aggregator --all --limit 10
```

### Programmatic Usage

```python
from core.models import Feed
from core.aggregators import get_aggregator

# Get a feed
feed = Feed.objects.get(id=1)

# Get the aggregator instance
aggregator = get_aggregator(feed)

# Run aggregation
articles = aggregator.aggregate()
```

## Testing and Debugging

**Use `python3 manage.py test_aggregator` for all debugging work.** This command is the primary debugging tool for aggregators.

### Quick Debug Commands

```bash
# Test by feed ID
python3 manage.py test_aggregator 5

# Test by aggregator type + identifier
python3 manage.py test_aggregator heise "https://www.heise.de/"

# Show detailed output for first article
python3 manage.py test_aggregator 5 --first 1 -v

# Test without saving to database
python3 manage.py test_aggregator 5 --dry-run

# Debug CSS selectors (FullWebsiteAggregator)
python3 manage.py test_aggregator 5 --selector-debug

# Limit articles for fast iteration
python3 manage.py test_aggregator 5 --limit 2
```

### Command Output

The command displays:

1. **Feed Configuration** - How the feed is set up
2. **Aggregator Class Info** - Implementation details
3. **Aggregation Run** - Execution time and article count
4. **Article Summaries** - Quick overview of articles
5. **Article Details** - Deep dive with raw/processed HTML (verbose mode)
6. **Validation** - Data quality checks (missing fields, empty content, etc.)
7. **Database Save** - Creation/update/failure counts

### Debugging Workflow

1. **Fast check:** `python3 manage.py test_aggregator <ID> --limit 2`
2. **Debug issues:** `python3 manage.py test_aggregator <ID> --first 1 -v`
3. **Check selectors:** `python3 manage.py test_aggregator <ID> --selector-debug`
4. **Full test:** `python3 manage.py test_aggregator <ID>`

See **CLAUDE.md** > **Aggregator Debugging Guide** for comprehensive documentation.

## Content Selection

`FullWebsiteAggregator` resolves the article body from a *list* of CSS selectors. Every selector is
applied and all surviving containers are concatenated in document order, so a body split across
sibling containers is not truncated. A match nested inside another match is dropped (outermost
wins), and duplicates are collapsed.

| Hook | Where | Purpose |
|---|---|---|
| `content_selectors: list[str]` | aggregator class | Places to look for the body. Default: `article`, `.article-content`, `.entry-content`, `main` |
| `selectors_to_remove: list[str]` | aggregator class | Scraper-specific removals, always applied |
| `uses_first_content_match: bool` | aggregator class | `True` for scrapers with one known container — keeps only the first match instead of unioning |
| `content_selectors` | `Feed.options` | Per-feed override of the class list. Absent → class default; present-but-empty → deliberately empty |
| `ignore_selectors` | `Feed.options` | Per-feed override of the removals. Absent → the shared defaults (`.advertisement`, `.ad`, `.ads`, `[class*='advert']`, `[class*='sponsor']`, `.social-share`, `.newsletter`, `.related-articles`); present-but-empty → no per-feed removals beyond the class `selectors_to_remove` and the mandatory set |

A present-but-empty `content_selectors: []` is a surprising one: it means *nothing* matches, so
extraction falls through to the whole `<body>` rather than any narrower container — the same
outcome as when no selector matches at all.

`DEFAULT_IGNORE_SELECTORS` is applied on top of every managed scraper's own `selectors_to_remove`,
not just `FullWebsiteAggregator`'s. Before this branch, a scraper that overrode `selectors_to_remove`
with its own list got none of the base ad/newsletter selectors — this is deliberate iOS parity, not
an oversight.

`ignore_selectors` entries are matched *within* each selected content container, not against the
document as a whole — so an `ignore_selectors` entry identical to a `content_selectors` entry is a
no-op and cannot be used to remove the container itself.

Sanitization of `script`, `style`, `noscript` and `template` is applied before selection and cannot
be disabled by any option. Iframes are an aggregator-level policy: `FullWebsiteAggregator` carries
`IFRAME_SANITIZE_SELECTOR` (everything but YouTube) in its `selectors_to_remove`, and a scraper that
supports more embed hosts — Caschy's Blog allows Twitter/X — overrides that list and filters iframes
itself in `process_content`.

Two lower-level building blocks in `core/aggregators/utils/content_extractor.py`, available for a
scraper to wire into its own `extract_content` / `enrich_articles` override. Neither is called
automatically by `FullWebsiteAggregator` or any shipped scraper today — `extract_content` currently
calls plain `extract_main_content` — so this is opt-in plumbing, not live behavior:

- `extract_main_content_if_present(...)` returns `None` instead of falling back to `<body>`, so a
  paywall or gate page cannot surface site navigation as the article.
- `generic_content_if_present(raw_html, article)` retries with the *generic* default selectors and
  requires at least 80 characters of real text — for syndicated pages on other domains that carry
  none of the scraper's markup.

For a scraper that does opt in, the intended resolution order is: dedicated container → generic
extraction (≥80 chars) → RSS summary. Wiring these into a specific scraper is out of scope here —
see `docs/superpowers/specs/2026-07-29-aggregator-parity-2-scrapers-and-types-design.md`.

## Feed authoring

Feeds can be created from a bare homepage URL instead of the feed URL itself, and pick up a logo
without any manual work.

### Resolving a pasted URL

`BaseAggregator.resolves_feed_url()` is `True` only for the free-form URL identifier types —
`full_website`, `feed_content`, and `podcast`. Managed scrapers pick their identifier from a fixed
`identifier_choices` list, and Reddit/YouTube hold a subreddit name or channel id, so neither kind
is ever normalized or resolved as a URL.

For a resolving aggregator, `FeedAdminForm.clean_identifier()` runs the pasted value through
`core/aggregators/utils/feed_url_resolver.py`:

- `normalize()` trims the string, prepends `https://` when no scheme is present, and rewrites a
  `feed://` scheme to `https://`.
- `resolve_feed_url()` normalizes, then tries to parse the result as a feed. If that fails, it
  fetches the page and looks for an advertised feed link (`feed_discovery.py`'s
  `feed_url_in_html()` / `discover_feed_url()`, RSS preferred over Atom when a page advertises
  both). It never raises — a dead site, an unreachable host, or a page with no feed link all just
  return the normalized input, so a bad paste never blocks saving the feed.

Pasting `golem.de` into a `full_website` feed's identifier and saving therefore stores the
resolved feed URL, not the homepage. `FeedAdmin`'s **Resolve & test** action runs the same
resolution and reports the entry count without saving anything, so it is safe on a feed you are
still configuring.

### RSS discovery fallback (not cached)

`RssAggregator.fetch_source_data()` carries the same fallback independently of the admin form: if
the stored identifier does not parse as a feed, it tries discovering one from the page and
refetches. This runs on every aggregation pass — discovery is **not cached** — so a site that
changes its advertised feed URL is picked up on the next run without a manual edit. The cost is
that every fetch of a homepage-identifier feed makes one extra request when the identifier itself
never parses as a feed.

### Feed logos

`Feed.logo` / `Feed.logo_source_url` resolve through three tiers, implemented by
`core/aggregators/feed_logo.py`'s `resolve_feed_logo_url()`:

1. `BaseAggregator.logo_image_url()` — an API-provided image. `None` by default; overridden by
   Reddit (subreddit icon) and YouTube (channel avatar).
2. `BaseAggregator.brand_site_url` — for the nine fixed-brand scrapers (Heise, Merkur, Tagesschau,
   Explosm, Dark Legacy Comics, Caschy's Blog, MacTechNews, Oglaf, Mein-MMO), the brand's own
   favicon rather than whatever feed URL the identifier happens to be.
3. The feed identifier's own origin, for everything else.

Only the site's own domain is ever contacted — there is no third-party favicon service, which
would otherwise leak every subscribed URL to it. Favicon selection (`utils/favicon.py`) prefers an
`apple-touch-icon`, then the largest declared `sizes`, then falls back to `/favicon.ico`
unverified. A downloaded logo with a flood-fillable white border (`utils/logo_background.py`, the
same 240 / 0.85 thresholds as the iOS client) gets that background stripped to transparent; a logo
that isn't white-backed is stored as downloaded.

Logos resolve on save — when the identifier or aggregator changed, or none is stored yet — never
on every aggregation run. `FeedAdmin`'s **Refresh feed logo** action re-runs resolution manually.

### AI selector suggestions

`core/services/selector_suggester.py` asks the user's configured AI provider to propose either
`content_selectors` or `ignore_selectors` (never both at once) for a feed, from a size-capped
markup digest of one article page. `FeedAdmin` exposes this as two actions, **Suggest content
selectors** and **Suggest ignore selectors** — both hidden entirely from the action list (not just
disabled) when `has_ai_provider()` reports no AI provider configured for the user, matching the
iOS client's behavior.

## Creating a New Aggregator

To add a new aggregator type:

1. Add the choice to `AGGREGATOR_CHOICES` in [core/choices.py](../choices.py)

2. Create the aggregator class in [implementations.py](implementations.py):

```python
class MyNewAggregator(BaseAggregator):
    """Aggregator for My New Source."""

    def aggregate(self) -> List[Dict[str, Any]]:
        print(f"[MyNewAggregator] Triggered for feed '{self.feed.name}' (ID: {self.feed.id})")
        print(f"  - Identifier: {self.identifier}")
        print(f"  - Daily limit: {self.daily_limit}")

        articles = []

        return articles
```

3. Register it in [registry.py](registry.py):

```python
from .implementations import MyNewAggregator

class AggregatorRegistry:
    _registry: Dict[str, Type[BaseAggregator]] = {
        # ... existing entries ...
        'my_new_source': MyNewAggregator,
    }
```

4. Create a migration if you added a new choice:

```bash
python3 manage.py makemigrations
python3 manage.py migrate
```

## Testing

Run the test script to see all aggregators in action:

```bash
python3 test_aggregators.py
```

This will create test feeds for different aggregator types and trigger them.
