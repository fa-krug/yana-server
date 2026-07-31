"""Drop Oglaf's retired ``convert_to_base64`` option.

Oglaf's comic image now goes through the shared content-addressed image store
like every other image, so the toggle has nothing left to switch. The reverse
operation is a deliberate no-op: restoring a key no code reads would only make
the stored options lie about what the aggregator does.
"""

import logging

from django.db import migrations

logger = logging.getLogger(__name__)


def forwards(apps, schema_editor):
    Feed = apps.get_model("core", "Feed")

    for feed in Feed.objects.all():
        if not isinstance(feed.options, dict) or "convert_to_base64" not in feed.options:
            continue

        logger.info("Feed %s: dropping the retired convert_to_base64 option", feed.pk)
        feed.options.pop("convert_to_base64")
        feed.save(update_fields=["options"])


def backwards(apps, schema_editor):
    """No-op: the option no longer exists."""


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0032_articleimage"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
