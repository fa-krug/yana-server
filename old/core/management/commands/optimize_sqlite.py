"""
Management command to run SQLite PRAGMA optimize.

PRAGMA optimize analyzes the database and updates query planner statistics
to help SQLite choose better query plans. This should be run periodically
(not on every connection) for best performance.

Usage:
    python manage.py optimize_sqlite
"""

from django.core.management.base import BaseCommand
from django.db import connection


class Command(BaseCommand):
    help = "Run SQLite PRAGMA optimize to update query planner statistics"

    def add_arguments(self, parser):
        parser.add_argument(
            "--analyze",
            action="store_true",
            help="Also run ANALYZE to update statistics for all tables",
        )

    def handle(self, *args, **options):
        """Run PRAGMA optimize and optionally ANALYZE."""
        self.stdout.write("Optimizing SQLite database...\n")

        connection.ensure_connection()

        with connection.cursor() as cursor:
            # Run PRAGMA optimize
            # This analyzes the database and updates query planner statistics
            self.stdout.write("Running PRAGMA optimize...")
            cursor.execute("PRAGMA optimize")
            self.stdout.write(self.style.SUCCESS("✓ PRAGMA optimize completed"))

            # Optionally run ANALYZE for all tables
            if options["analyze"]:
                self.stdout.write("\nRunning ANALYZE on all tables...")
                cursor.execute("ANALYZE")
                self.stdout.write(self.style.SUCCESS("✓ ANALYZE completed"))

        self.stdout.write(self.style.SUCCESS("\n✓ Database optimization complete!"))
        self.stdout.write(
            "\nNote: Run this command periodically (e.g., daily or weekly) "
            "for best performance, not on every connection."
        )
