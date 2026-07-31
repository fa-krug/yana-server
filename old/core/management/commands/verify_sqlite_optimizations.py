"""Django command to verify SQLite optimizations."""

from django.core.management.base import BaseCommand
from django.db import connection


class Command(BaseCommand):
    help = "Verify that SQLite performance optimizations are correctly applied"

    def handle(self, *args, **options):
        """Check all PRAGMA settings to verify optimizations."""
        self.stdout.write(self.style.SUCCESS("Checking SQLite performance optimizations...\n"))

        # Ensure connection is established (triggers init_connection_state)
        connection.ensure_connection()

        # Check transaction mode (should be IMMEDIATE to avoid "database is locked"
        # errors under concurrent writers). This is a connection OPTION, not a PRAGMA.
        transaction_mode = connection.settings_dict.get("OPTIONS", {}).get("transaction_mode")
        expected_immediate = (transaction_mode or "").upper() == "IMMEDIATE"
        status = self.style.SUCCESS("✓") if expected_immediate else self.style.ERROR("✗")
        self.stdout.write(f"{status} Transaction mode: {transaction_mode} (expected: IMMEDIATE)")

        with connection.cursor() as cursor:
            # Check journal mode (should be WAL)
            cursor.execute("PRAGMA journal_mode")
            journal_mode = cursor.fetchone()[0]
            expected_wal = journal_mode.upper() == "WAL"
            status = self.style.SUCCESS("✓") if expected_wal else self.style.ERROR("✗")
            self.stdout.write(f"{status} Journal mode: {journal_mode} (expected: WAL)")

            # Check synchronous mode (should be NORMAL)
            cursor.execute("PRAGMA synchronous")
            synchronous = cursor.fetchone()[0]
            expected_normal = synchronous == 1  # NORMAL = 1
            status = self.style.SUCCESS("✓") if expected_normal else self.style.ERROR("✗")
            self.stdout.write(f"{status} Synchronous: {synchronous} (1=NORMAL, expected: 1)")

            # Check cache size (should be -64000 = 64MB)
            cursor.execute("PRAGMA cache_size")
            cache_size = cursor.fetchone()[0]
            expected_cache = cache_size == -64000
            status = self.style.SUCCESS("✓") if expected_cache else self.style.WARNING("⚠")
            self.stdout.write(f"{status} Cache size: {cache_size} KB (expected: -64000 = 64MB)")

            # Check mmap_size (should be 268435456 = 256MB)
            cursor.execute("PRAGMA mmap_size")
            mmap_size = cursor.fetchone()[0]
            expected_mmap = mmap_size == 268435456
            status = self.style.SUCCESS("✓") if expected_mmap else self.style.WARNING("⚠")
            self.stdout.write(
                f"{status} MMap size: {mmap_size} bytes (expected: 268435456 = 256MB)"
            )

            # Check temp_store (should be 2 = MEMORY)
            cursor.execute("PRAGMA temp_store")
            temp_store = cursor.fetchone()[0]
            expected_memory = temp_store == 2  # MEMORY = 2
            status = self.style.SUCCESS("✓") if expected_memory else self.style.WARNING("⚠")
            self.stdout.write(f"{status} Temp store: {temp_store} (2=MEMORY, expected: 2)")

            # Check busy_timeout (should be 30000 = 30 seconds)
            cursor.execute("PRAGMA busy_timeout")
            busy_timeout = cursor.fetchone()[0]
            expected_timeout = busy_timeout == 30000
            status = self.style.SUCCESS("✓") if expected_timeout else self.style.WARNING("⚠")
            self.stdout.write(f"{status} Busy timeout: {busy_timeout} ms (expected: 30000 = 30s)")

            # Check foreign_keys (should be 1 = ON)
            cursor.execute("PRAGMA foreign_keys")
            foreign_keys = cursor.fetchone()[0]
            expected_fk = foreign_keys == 1
            status = self.style.SUCCESS("✓") if expected_fk else self.style.WARNING("⚠")
            self.stdout.write(f"{status} Foreign keys: {foreign_keys} (1=ON, expected: 1)")

            # Check page_size (informational, may not be set on existing DBs)
            cursor.execute("PRAGMA page_size")
            page_size = cursor.fetchone()[0]
            self.stdout.write(f"  Page size: {page_size} bytes (informational)")

        self.stdout.write("\n" + self.style.SUCCESS("Verification complete!"))
        self.stdout.write(
            self.style.WARNING(
                "\nNote: Some settings (cache_size, mmap_size) may show different values "
                "if the database was created before optimizations were applied."
            )
        )
