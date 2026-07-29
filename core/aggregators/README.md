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
| `ignore_selectors` | `Feed.options` | Per-feed removals. Absent → the shared defaults (`.advertisement`, `.ad`, `.ads`, `[class*='advert']`, `[class*='sponsor']`, `.social-share`, `.newsletter`, `.related-articles`) |

Sanitization of `script`, `style`, `noscript` and `template` is applied before selection and cannot
be disabled by any option. Iframes are an aggregator-level policy: `FullWebsiteAggregator` carries
`IFRAME_SANITIZE_SELECTOR` (everything but YouTube) in its `selectors_to_remove`, and a scraper that
supports more embed hosts — Caschy's Blog allows Twitter/X — overrides that list and filters iframes
itself in `process_content`.

Two escape hatches for scrapers with a dedicated container:

- `extract_main_content_if_present(...)` returns `None` instead of falling back to `<body>`, so a
  paywall or gate page cannot surface site navigation as the article.
- `generic_content_if_present(raw_html, article)` retries with the *generic* default selectors and
  requires at least 80 characters of real text — for syndicated pages on other domains that carry
  none of the scraper's markup.

Resolution order for such a scraper: dedicated container → generic extraction (≥80 chars) → RSS
summary.

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

## Current Status

All aggregators are currently **dummy implementations** that only print debug information. They need to be ported from the TypeScript implementation in `old/src/server/aggregators/`.

## Next Steps

1. Port aggregator logic from TypeScript to Python
2. Implement actual content fetching and parsing
3. Add error handling and retries
4. Implement article deduplication
5. Add rate limiting
6. Implement caching
7. Add comprehensive tests

## Testing

Run the test script to see all aggregators in action:

```bash
python3 test_aggregators.py
```

This will create test feeds for different aggregator types and trigger them.
