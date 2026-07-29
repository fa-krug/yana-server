"""Management command to test and debug aggregators comprehensively."""

import logging
import time
import traceback

from django.core.management.base import BaseCommand
from django.utils import timezone

from core.aggregators import get_aggregator
from core.models import Article, Feed


class DebugHandler(logging.Handler):
    """Custom logging handler to capture logs during aggregation."""

    def __init__(self):
        super().__init__()
        self.logs = []

    def emit(self, record):
        self.logs.append(self.format(record))


class Command(BaseCommand):
    help = "Comprehensive aggregator debugging tool - shows all details needed to debug aggregators"

    def add_arguments(self, parser):
        parser.add_argument(
            "target",
            type=str,
            help="Feed ID (numeric) or Aggregator type (e.g., 'tagesschau')",
        )
        parser.add_argument(
            "identifier",
            type=str,
            nargs="?",
            help="Feed identifier (URL/ID) - required if target is an aggregator type",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Don't save articles to database",
        )
        parser.add_argument(
            "--verbose",
            action="store_true",
            help="Show full HTML, tracebacks, and debug logs",
        )
        parser.add_argument(
            "--first",
            type=int,
            default=1,
            help="Number of articles to show full details for (default: 1)",
        )
        parser.add_argument(
            "--limit",
            type=int,
            help="Limit articles aggregated (overrides feed daily_limit)",
        )
        parser.add_argument(
            "--selector-debug",
            action="store_true",
            help="Show CSS selector debugging for content extraction",
        )

    def handle(self, *args, **options):
        target = options.get("target")
        identifier = options.get("identifier")
        dry_run = options.get("dry_run", False)
        verbose = options.get("verbose", False)
        num_first = options.get("first", 1)
        limit = options.get("limit")
        selector_debug = options.get("selector_debug", False)

        # Set up debug logging
        debug_handler = DebugHandler()
        debug_handler.setLevel(logging.DEBUG)
        logging.root.addHandler(debug_handler)
        logging.root.setLevel(logging.DEBUG if verbose else logging.INFO)

        try:
            # Load or create feed
            feed = self._get_or_create_feed(target, identifier, limit)
            if not feed:
                return

            self._print_section("FEED CONFIGURATION")
            self._print_field("Aggregator type", feed.aggregator)
            self._print_field("Identifier", feed.identifier)
            self._print_field("Daily limit", feed.daily_limit)
            self._print_field("Enabled", feed.enabled)
            self._print_field("Feed name", feed.name)
            self._print_field("Feed ID", feed.id if feed.id else "(not saved)")

            # Get aggregator class info
            self._print_section("AGGREGATOR CLASS INFO")
            aggregator = get_aggregator(feed)
            aggregator_class = aggregator.__class__
            self._print_field("Class", f"{aggregator_class.__module__}.{aggregator_class.__name__}")
            self._print_field(
                "Base classes", ", ".join([c.__name__ for c in aggregator_class.__bases__])
            )

            if hasattr(aggregator, "get_source_url"):
                self._print_field("Source URL", aggregator.get_source_url())

            if selector_debug and hasattr(aggregator, "content_selectors"):
                self._print_field("Content selectors", ", ".join(aggregator.content_selectors))
            if selector_debug and hasattr(aggregator, "selectors_to_remove"):
                self._print_field("Selectors to remove", ", ".join(aggregator.selectors_to_remove))

            # Run aggregation with timing
            self._print_section("AGGREGATION RUN")
            start_time = time.time()
            articles_data = aggregator.aggregate()
            elapsed = time.time() - start_time

            self._print_field("Time elapsed", f"{elapsed:.2f}s")
            self._print_field("Articles returned", len(articles_data))

            if len(articles_data) == 0:
                self.stdout.write(self.style.WARNING("⚠ No articles returned!"))
                if debug_handler.logs:
                    self._print_section("DEBUG LOGS")
                    for log in debug_handler.logs:
                        self.stdout.write(f"  {log}")
                return

            # Show article details
            self._print_section("ARTICLE SUMMARIES (first 10)")
            self._print_articles_summary(articles_data[:10])

            # Show detailed info for first N articles
            self._print_section(f"ARTICLE DETAILS (first {num_first})")
            for idx, article_data in enumerate(articles_data[:num_first], 1):
                self._print_article_detail(idx, article_data, verbose)

            # Show validation results
            self._print_section("VALIDATION")
            self._validate_articles(articles_data)

            # Show debug logs if in verbose mode
            if verbose and debug_handler.logs:
                self._print_section("DEBUG LOGS")
                for log in debug_handler.logs[-20:]:  # Last 20 logs
                    self.stdout.write(f"  {log}")

            # Save to database
            if not dry_run:
                self._print_section("DATABASE SAVE")
                self._save_articles(feed, articles_data)
            else:
                self.stdout.write(
                    self.style.WARNING("(Dry-run mode: articles NOT saved to database)")
                )

        except Feed.DoesNotExist:
            self.stdout.write(self.style.ERROR(f"✗ Feed with ID {target} does not exist"))
        except Exception as e:
            self._print_section("ERROR")
            self.stdout.write(self.style.ERROR(f"✗ {type(e).__name__}: {e}"))
            if verbose:
                self.stdout.write("\n" + traceback.format_exc())
        finally:
            logging.root.removeHandler(debug_handler)

    def _get_default_identifier(self, aggregator_type):
        """Get default identifier for known aggregators."""
        try:
            from core.aggregators.registry import AggregatorRegistry

            aggregator_class = AggregatorRegistry.get(aggregator_type)
            if hasattr(aggregator_class, "get_default_identifier"):
                default = aggregator_class.get_default_identifier()
                if default:
                    return default
        except (KeyError, ImportError):
            pass

        # Fallback for aggregators not yet fully migrated or in registry
        defaults = {
            "tagesschau": "https://www.tagesschau.de/xml/rss2/",
            "heise": "https://www.heise.de/rss/heise.rdf",
            "mein_mmo": "https://www.mein-mmo.de/feed/",
            "oglaf": "https://www.oglaf.com/feeds/rss/",
            "caschys_blog": "https://stadt-bremerhaven.de/feed/",
            "mactechnews": "https://www.mactechnews.de/Rss/News.x",
        }
        return defaults.get(aggregator_type)

    def _get_or_create_feed(self, target, identifier, limit):
        """Get existing feed or create a test feed."""
        if target.isdigit():
            feed = Feed.objects.get(id=int(target))
            if identifier:
                feed.identifier = identifier
        else:
            # If no identifier provided, try to use default
            if not identifier:
                identifier = self._get_default_identifier(target)
                if identifier:
                    self.stdout.write(
                        self.style.SUCCESS(f"Using default identifier for {target}: {identifier}")
                    )
                else:
                    self.stdout.write(
                        self.style.ERROR(
                            f"Error: identifier required for aggregator type '{target}'. "
                            f"Please provide it as the second argument."
                        )
                    )
                    return None

            from django.contrib.auth import get_user_model

            User = get_user_model()
            user = User.objects.filter(is_superuser=True).first() or User.objects.first()
            if not user:
                self.stdout.write(
                    self.style.ERROR("Error: No user found to associate with test feed")
                )
                return None

            feed = Feed(
                name=f"Test {target}",
                aggregator=target,
                identifier=identifier,
                user=user,
                daily_limit=limit or 20,
            )
            # Save the feed so we can create articles with foreign key
            feed.save()

        if limit:
            feed.daily_limit = limit
            feed.save()

        return feed

    def _print_section(self, title):
        """Print a section header."""
        self.stdout.write("")
        self.stdout.write(self.style.HTTP_INFO(f"\n{'=' * 70}"))
        self.stdout.write(self.style.HTTP_INFO(f"{title:^70}"))
        self.stdout.write(self.style.HTTP_INFO(f"{'=' * 70}\n"))

    def _print_field(self, label, value):
        """Print a labeled field."""
        self.stdout.write(f"  {label:.<40} {value}")

    def _print_articles_summary(self, articles):
        """Print summary of articles."""
        for idx, article in enumerate(articles, 1):
            name = article.get("name", "")[:60]
            identifier = article.get("identifier", "")[:60]
            raw_len = len(article.get("raw_content", ""))
            content_len = len(article.get("content", ""))
            date = article.get("date", "")

            self.stdout.write(f"  {idx:2}. {name}")
            self.stdout.write(f"      URL: {identifier}")
            self.stdout.write(
                f"      Content: {raw_len} raw / {content_len} processed chars | Date: {date}"
            )

    def _print_article_detail(self, idx, article, verbose):
        """Print detailed info for an article."""
        self.stdout.write(f"\n  Article {idx}:")
        self.stdout.write(f"    Name: {article.get('name', '')[:100]}")
        self.stdout.write(f"    URL: {article.get('identifier', '')}")
        self.stdout.write(f"    Date: {article.get('date', '')}")
        self.stdout.write(f"    Author: {article.get('author', '') or '(none)'}")
        self.stdout.write(f"    Raw content: {len(article.get('raw_content', ''))} chars")
        self.stdout.write(f"    Processed content: {len(article.get('content', ''))} chars")

        if verbose:
            raw = article.get("raw_content", "")[:800]
            self.stdout.write("\n    >>> RAW CONTENT (first 800 chars):")
            self.stdout.write(f"    {raw}...\n")

            content = article.get("content", "")[:800]
            self.stdout.write("    >>> PROCESSED CONTENT (first 800 chars):")
            self.stdout.write(f"    {content}...\n")

    def _validate_articles(self, articles):
        """Validate article data."""
        issues = []
        missing_fields = {"name": 0, "identifier": 0, "content": 0, "raw_content": 0}
        empty_content = 0
        no_date = 0

        for article in articles:
            for field in missing_fields:
                if not article.get(field):
                    missing_fields[field] += 1
            if len(article.get("content", "")) == 0:
                empty_content += 1
            if not article.get("date"):
                no_date += 1

        if missing_fields["name"] > 0:
            issues.append(f"  ⚠ {missing_fields['name']} articles missing 'name'")
        if missing_fields["identifier"] > 0:
            issues.append(f"  ⚠ {missing_fields['identifier']} articles missing 'identifier'")
        if missing_fields["raw_content"] > 0:
            issues.append(f"  ⚠ {missing_fields['raw_content']} articles missing 'raw_content'")
        if empty_content > 0:
            issues.append(f"  ⚠ {empty_content} articles have empty 'content'")
        if no_date > 0:
            issues.append(f"  ⚠ {no_date} articles missing 'date'")

        if issues:
            for issue in issues:
                self.stdout.write(self.style.WARNING(issue))
        else:
            self.stdout.write(self.style.SUCCESS("  ✓ All articles have required fields"))

    def _save_articles(self, feed, articles_data):
        """Save articles to database."""
        created = 0
        updated = 0
        failed = 0

        for article_data in articles_data:
            try:
                article, was_created = Article.objects.get_or_create(
                    feed=feed,
                    identifier=article_data["identifier"],
                    defaults={
                        "name": article_data.get("name", ""),
                        "raw_content": article_data.get("raw_content", ""),
                        "content": article_data.get("content", ""),
                        "date": timezone.now(),  # Always save with current timestamp
                        "author": article_data.get("author", ""),
                    },
                )
                if was_created:
                    created += 1
                else:
                    updated += 1
            except Exception as e:
                self.stdout.write(self.style.WARNING(f"  ✗ Failed to save: {e}"))
                failed += 1

        self._print_field("Created", created)
        self._print_field("Updated", updated)
        if failed > 0:
            self.stdout.write(self.style.WARNING(f"  ✗ Failed: {failed}"))
        else:
            self.stdout.write(self.style.SUCCESS("  ✓ All articles saved successfully"))
