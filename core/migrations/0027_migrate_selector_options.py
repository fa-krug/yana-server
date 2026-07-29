"""Convert legacy selector options and retire use_full_content.

Feeds carrying ``use_full_content: false`` relied on summary-only behavior, so
they become ``feed_content`` feeds rather than silently starting to scrape every
article.

The reverse operation is approximate by design: it restores the comma-string
selector keys, but cannot tell which ``feed_content`` feeds were originally
``full_website``, and does not restore ``use_full_content``. Removing the toggle
is a one-way product decision.
"""

import logging

from django.db import migrations

from core.aggregators.utils.legacy_options import convert_legacy_options, revert_options

logger = logging.getLogger(__name__)


def forwards(apps, schema_editor):
    Feed = apps.get_model("core", "Feed")

    for feed in Feed.objects.all():
        if not isinstance(feed.options, dict):
            logger.warning(
                "Feed %s: options is %s, not a dict -- skipping conversion",
                feed.pk,
                type(feed.options).__name__,
            )
            continue

        try:
            new_options, to_feed_content = convert_legacy_options(feed.options)
        except Exception as exc:
            logger.warning("Feed %s: could not convert options (%s) -- skipping", feed.pk, exc)
            continue

        update_fields = []

        if new_options != feed.options:
            feed.options = new_options
            update_fields.append("options")

        if to_feed_content and feed.aggregator == "full_website":
            logger.info(
                "Feed %s: use_full_content was false -- converting to feed_content", feed.pk
            )
            feed.aggregator = "feed_content"
            update_fields.append("aggregator")

        if update_fields:
            feed.save(update_fields=update_fields)


def backwards(apps, schema_editor):
    Feed = apps.get_model("core", "Feed")

    for feed in Feed.objects.all():
        if not isinstance(feed.options, dict):
            continue

        reverted = revert_options(feed.options)
        if reverted != feed.options:
            feed.options = reverted
            feed.save(update_fields=["options"])


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0026_delete_greaderauthtoken"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
