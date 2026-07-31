"""Management command to set up test Mein-MMO feed."""

from django.contrib.auth.models import User
from django.core.management.base import BaseCommand

from core.models import Feed, FeedGroup


class Command(BaseCommand):
    help = "Set up test Mein-MMO feed with test user"

    def handle(self, *args, **options):
        # Create or get test user
        test_user, created = User.objects.get_or_create(
            username="testuser", defaults={"email": "test@example.com"}
        )

        if created:
            test_user.set_password("testpass123")
            test_user.save()
            self.stdout.write(self.style.SUCCESS("✓ Created test user: testuser"))
        else:
            self.stdout.write(f"✓ Using existing test user: {test_user.username}")

        # Create or get feed group
        feed_group, created = FeedGroup.objects.get_or_create(name="Mein-MMO Test", user=test_user)

        if created:
            self.stdout.write(self.style.SUCCESS(f"✓ Created feed group: {feed_group.name}"))
        else:
            self.stdout.write(f"✓ Using existing feed group: {feed_group.name}")

        # Create or get test feed
        feed, created = Feed.objects.get_or_create(
            name="Mein-MMO (Test)",
            user=test_user,
            group=feed_group,
            defaults={
                "aggregator": "mein_mmo",
                "identifier": "https://mein-mmo.de/feed/",
                "daily_limit": 5,
                "enabled": True,
            },
        )

        if created:
            self.stdout.write(self.style.SUCCESS(f"✓ Created test feed: {feed.name}"))
            self.stdout.write(f"  - ID: {feed.id}")
            self.stdout.write(f"  - Aggregator: {feed.aggregator}")
            self.stdout.write(f"  - Feed URL: {feed.identifier}")
            self.stdout.write(f"  - Daily limit: {feed.daily_limit}")
        else:
            self.stdout.write(f"✓ Using existing test feed: {feed.name} (ID: {feed.id})")

        self.stdout.write("")
        self.stdout.write(self.style.SUCCESS("✅ Test feed is ready!"))
        self.stdout.write("\nTo test the aggregator, run:")
        self.stdout.write(f"  python3 manage.py test_aggregator {feed.id}")
