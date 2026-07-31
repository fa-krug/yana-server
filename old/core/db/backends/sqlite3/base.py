"""Optimized SQLite database backend with performance PRAGMA settings."""

# mypy: ignore-errors

from django.db.backends.sqlite3.base import (
    Database,
    DatabaseFeatures,
    DatabaseIntrospection,
    DatabaseOperations,
    DatabaseSchemaEditor,
)
from django.db.backends.sqlite3.base import (
    DatabaseWrapper as SQLiteDatabaseWrapper,
)


class DatabaseWrapper(SQLiteDatabaseWrapper):
    """
    Optimized SQLite database wrapper with performance PRAGMA settings.

    Extends Django's default SQLite backend to apply performance optimizations
    when database connections are established. Uses Django 6+ recommended approach
    via `init_connection_state()` method.

    Performance Optimizations Applied:
    - WAL mode (Write-Ahead Logging): Better concurrency, faster writes
    - Synchronous = NORMAL: Balanced safety and performance
    - Increased cache size (64MB): More data in memory, fewer disk reads
    - Memory-mapped I/O (256MB): Faster access to database file
    - Temp store in memory: Faster temporary operations
    - Busy timeout: Prevents lock contention
    - Foreign keys: Data integrity and query performance

    References:
    - https://www.sqlite.org/pragma.html
    - https://www.sqlite.org/wal.html
    - https://www.sqlite.org/performance.html
    - https://docs.djangoproject.com/en/stable/ref/databases/#sqlite-notes
    """

    def init_connection_state(self):
        """
        Initialize connection state with performance optimizations.

        This method is called after a connection is established and is the
        recommended place in Django 6+ to apply connection-level PRAGMA settings.
        It's called both for new connections and when reusing connections from the pool,
        ensuring settings are always applied.

        Applies SQLite PRAGMA settings for optimal performance.
        """
        # Call parent to ensure base initialization
        super().init_connection_state()

        # Apply performance optimizations via PRAGMA statements
        # Wrap in try-except to handle edge cases gracefully
        try:
            with self.cursor() as cursor:
                # 1. Enable WAL mode (Write-Ahead Logging)
                # Benefits: Better concurrency, faster writes, readers don't block writers
                # WAL mode allows multiple readers and one writer simultaneously
                cursor.execute("PRAGMA journal_mode=WAL")

                # 2. Set synchronous mode to NORMAL (balanced safety/performance)
                # FULL is safest but slowest, OFF is fastest but unsafe
                # NORMAL is a good balance: safe for most use cases, much faster than FULL
                # In WAL mode, NORMAL is safe because WAL provides durability guarantees
                cursor.execute("PRAGMA synchronous=NORMAL")

                # 3. Increase cache size (default is -2000 = 2MB)
                # Negative values are in KB, positive in pages (typically 4KB)
                # -64000 = 64MB cache (good for databases up to ~1GB)
                # Adjust based on available RAM and database size
                cursor.execute("PRAGMA cache_size=-64000")

                # 4. Enable memory-mapped I/O for faster file access
                # 268435456 = 256MB (adjust based on database size and available RAM)
                # mmap_size should be roughly equal to or larger than cache_size
                # Set to 0 to disable (default), or positive bytes for mmap
                cursor.execute("PRAGMA mmap_size=268435456")

                # 5. Store temporary tables in memory (faster than disk)
                # 0 = default (disk), 1 = file, 2 = memory
                cursor.execute("PRAGMA temp_store=MEMORY")

                # 6. Set page size (if not already set)
                # Larger page sizes can improve performance for large databases
                # Default is usually 4096, but we'll set it explicitly
                # Note: This only works if the database is empty/new
                import contextlib

                with contextlib.suppress(Exception):
                    cursor.execute("PRAGMA page_size=4096")

                # 7. Enable foreign key constraints (safety + performance)
                # Foreign keys help maintain data integrity and can improve query performance
                cursor.execute("PRAGMA foreign_keys=ON")

                # 8. Set busy timeout via PRAGMA
                # This prevents "database is locked" errors by waiting for locks
                # 30000 milliseconds = 30 seconds
                cursor.execute("PRAGMA busy_timeout=30000")

                # Note: PRAGMA optimize is best run periodically, not on every connection
                # Consider running it via a management command or scheduled task instead
        except Exception as e:
            # Log but don't fail - allow connection to proceed even if optimizations fail
            # This ensures the app can still function if there are PRAGMA issues
            import logging

            logger = logging.getLogger(__name__)
            logger.warning(
                f"Failed to apply some SQLite performance optimizations: {e}. "
                "Connection will proceed with default settings."
            )


# Export required attributes for Django database backend
__all__ = [
    "Database",
    "DatabaseWrapper",
    "DatabaseFeatures",
    "DatabaseIntrospection",
    "DatabaseOperations",
    "DatabaseSchemaEditor",
]
