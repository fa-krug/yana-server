"""Django command to trigger feed aggregators."""

from django.core.management.base import BaseCommand, CommandError

from core.services import AggregatorService


class Command(BaseCommand):
    help = "Trigger aggregator for a specific feed or all feeds"

    def add_arguments(self, parser):
        parser.add_argument("--feed-id", type=int, help="Trigger aggregator for a specific feed ID")
        parser.add_argument(
            "--aggregator-type", type=str, help="Trigger all feeds of a specific aggregator type"
        )
        parser.add_argument("--all", action="store_true", help="Trigger all enabled feeds")
        parser.add_argument(
            "--limit",
            type=int,
            help="Limit number of feeds to process (for --all or --aggregator-type)",
        )
        parser.add_argument(
            "--force-update",
            action="store_true",
            help="Update existing articles if content has changed",
        )

    def handle(self, *args, **options):
        feed_id = options.get("feed_id")
        aggregator_type = options.get("aggregator_type")
        trigger_all = options.get("all")
        limit = options.get("limit")
        force_update = options.get("force_update")

        # Validate arguments
        if not any([feed_id, aggregator_type, trigger_all]):
            raise CommandError("You must specify one of: --feed-id, --aggregator-type, or --all")

        if sum([bool(feed_id), bool(aggregator_type), bool(trigger_all)]) > 1:
            raise CommandError(
                "You can only specify one of: --feed-id, --aggregator-type, or --all"
            )

        try:
            if feed_id:
                # Trigger specific feed
                self.stdout.write(self.style.SUCCESS(f"Triggering feed ID: {feed_id}"))
                result = AggregatorService.trigger_by_feed_id(feed_id, force_update=force_update)
                self._print_result(result)

            elif aggregator_type:
                # Trigger all feeds of a specific type
                self.stdout.write(
                    self.style.SUCCESS(
                        f"Triggering all {aggregator_type} feeds"
                        + (f" (limit: {limit})" if limit else "")
                    )
                )
                results = AggregatorService.trigger_by_aggregator_type(
                    aggregator_type, limit=limit, force_update=force_update, sync=True
                )
                for result in results:
                    self._print_result(result)

            elif trigger_all:
                # Trigger all enabled feeds
                self.stdout.write(
                    self.style.SUCCESS(
                        "Triggering all enabled feeds" + (f" (limit: {limit})" if limit else "")
                    )
                )
                results = AggregatorService.trigger_all(
                    limit=limit, force_update=force_update, sync=True
                )
                for result in results:
                    self._print_result(result)

        except Exception as e:
            raise CommandError(f"Error: {str(e)}") from e

    def _print_result(self, result):
        """Print aggregation result."""
        if result["success"]:
            self.stdout.write(
                self.style.SUCCESS(
                    f"✓ Feed '{result['feed_name']}' (ID: {result['feed_id']}, "
                    f"Type: {result['aggregator_type']}) - "
                    f"{result['articles_count']} articles"
                )
            )
        else:
            self.stdout.write(
                self.style.ERROR(
                    f"✗ Feed '{result['feed_name']}' (ID: {result['feed_id']}, "
                    f"Type: {result['aggregator_type']}) - "
                    f"Error: {result.get('error', 'Unknown error')}"
                )
            )
