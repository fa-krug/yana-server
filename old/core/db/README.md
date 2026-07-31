# SQLite Performance Optimizations

This directory contains an optimized SQLite database backend for Django with performance improvements applied via SQLite PRAGMA settings.

## Overview

The custom backend extends Django's default SQLite backend to automatically apply performance optimizations when database connections are established. These optimizations significantly improve read/write performance, especially for concurrent operations.

## Performance Optimizations

### 1. WAL Mode (Write-Ahead Logging)
- **PRAGMA**: `journal_mode=WAL`
- **Benefits**:
  - Better concurrency: multiple readers and one writer can operate simultaneously
  - Faster writes: writes don't block readers
  - Improved performance for multi-threaded applications (like Django Q2)
- **Reference**: https://www.sqlite.org/wal.html

### 2. Synchronous Mode
- **PRAGMA**: `synchronous=NORMAL`
- **Benefits**:
  - Balanced safety and performance
  - Much faster than FULL mode while maintaining data integrity
  - Safe in WAL mode due to WAL's durability guarantees
- **Note**: FULL is safest but slowest, OFF is fastest but unsafe

### 3. Cache Size
- **PRAGMA**: `cache_size=-64000` (64MB)
- **Benefits**:
  - More data kept in memory, reducing disk I/O
  - Faster query execution for frequently accessed data
  - Adjust based on available RAM and database size
- **Default**: 2MB (-2000)

### 4. Memory-Mapped I/O
- **PRAGMA**: `mmap_size=268435456` (256MB)
- **Benefits**:
  - Faster file access through OS memory mapping
  - Reduces system call overhead
  - Should be roughly equal to or larger than cache_size
- **Note**: Requires sufficient available RAM

### 5. Temporary Store
- **PRAGMA**: `temp_store=MEMORY`
- **Benefits**:
  - Temporary tables stored in RAM instead of disk
  - Faster sorting and temporary operations
  - Reduces disk I/O for complex queries

### 6. Page Size
- **PRAGMA**: `page_size=4096`
- **Benefits**:
  - Optimized page size for modern systems
  - Better performance for large databases
- **Note**: Only applies to new databases

### 7. Query Planner Optimization
- **PRAGMA**: `optimize`
- **Benefits**:
  - Helps SQLite choose better query plans
  - Automatically analyzes and optimizes queries
  - Runs periodically to maintain performance

### 8. Foreign Key Constraints
- **PRAGMA**: `foreign_keys=ON`
- **Benefits**:
  - Maintains data integrity
  - Can improve query performance through better query planning
  - Enables referential integrity checks

### 9. Busy Timeout
- **PRAGMA**: `busy_timeout=30000` (30 seconds)
- **Benefits**:
  - Prevents "database is locked" errors
  - Waits for locks to be released instead of failing immediately
  - Essential for multi-threaded applications

### 10. Immediate Transaction Mode
- **OPTION**: `transaction_mode="IMMEDIATE"` (a Django connection option, not a PRAGMA)
- **Benefits**:
  - The key fix for "database is locked" (`SQLITE_BUSY`) errors under concurrent
    writers (multiple Django Q2 workers + web requests)
  - Acquires the write lock at the *start* of a write transaction (`BEGIN IMMEDIATE`)
    instead of lazily upgrading from a read lock (`BEGIN`/DEFERRED)
- **Why it matters**: In WAL mode with DEFERRED transactions, a connection first
  takes a read lock and only upgrades to a write lock on its first write. If two
  connections both hold a read lock and try to upgrade, SQLite returns
  `SQLITE_BUSY` *immediately* to break the deadlock — **ignoring `busy_timeout`**.
  With IMMEDIATE, the write lock is taken up front, so `busy_timeout` is honored
  and writers queue instead of failing.
- **Note**: Supported since Django 5.1. Read-only (autocommit `SELECT`) queries
  are unaffected and still run concurrently.

## Configuration

The optimized backend is configured in `yana/settings.py`:

```python
DATABASES = {
    "default": {
        "ENGINE": "core.db.backends.sqlite3",
        "NAME": BASE_DIR / "db.sqlite3",
        "OPTIONS": {
            "timeout": 30,  # Connection timeout in seconds
            "check_same_thread": False,  # Required for Django Q2 multi-threading
            "transaction_mode": "IMMEDIATE",  # Avoids "database is locked" on concurrent writes
        },
    }
}
```

## Implementation Details

This backend uses Django 6+ recommended approach:

- **`init_connection_state()` method**: This is the modern Django 6+ way to apply connection-level settings. It's called after a connection is established and when reusing connections from the pool, ensuring PRAGMA settings are always applied.

- **Why not `get_new_connection()`?**: While `get_new_connection()` works, `init_connection_state()` is the recommended place for connection configuration in Django 6+ because:
  - It's called for both new and reused connections
  - It's the designated hook for connection-level initialization
  - It ensures settings persist across connection reuse

## Performance Impact

Expected performance improvements:

- **Concurrent Reads**: 2-5x faster with WAL mode
- **Writes**: 2-3x faster with WAL mode and NORMAL synchronous
- **Query Performance**: 10-30% improvement with increased cache
- **Multi-threaded Operations**: Significant improvement with WAL mode
- **Lock Contention**: Reduced with busy timeout

## Tuning for Your Environment

### Small Databases (< 100MB)
- Cache size: 32MB (`-32000`)
- mmap_size: 128MB (`134217728`)

### Medium Databases (100MB - 1GB)
- Cache size: 64MB (`-64000`) - **Current setting**
- mmap_size: 256MB (`268435456`) - **Current setting**

### Large Databases (> 1GB)
- Cache size: 128MB (`-128000`) or more
- mmap_size: 512MB (`536870912`) or more
- Retention (deleting old articles) is the intended answer to unbounded growth,
  not switching engines -- SQLite is the only supported backend

### Limited RAM
- Reduce cache_size and mmap_size proportionally
- Monitor memory usage and adjust accordingly

## WAL Mode Notes

When using WAL mode, SQLite creates two additional files:
- `db.sqlite3-wal` - Write-ahead log file
- `db.sqlite3-shm` - Shared memory file

These files are normal and should not be deleted. They are automatically managed by SQLite.

## Migration from Default Backend

The optimized backend is a drop-in replacement. To migrate:

1. The backend automatically applies optimizations on first connection
2. Existing databases will be switched to WAL mode automatically
3. No data migration is required
4. The database will continue to work with standard SQLite tools

## Monitoring Performance

### Using Management Commands

**Verify optimizations are applied:**
```bash
python3 manage.py verify_sqlite_optimizations
```

**Run periodic optimization:**
```bash
# Run PRAGMA optimize (updates query planner statistics)
python3 manage.py optimize_sqlite

# Also run ANALYZE for all tables
python3 manage.py optimize_sqlite --analyze
```

**Note:** Run `optimize_sqlite` periodically (daily/weekly), not on every connection.

### Programmatic Verification

To verify optimizations are applied programmatically:

```python
from django.db import connection

connection.ensure_connection()
with connection.cursor() as cursor:
    cursor.execute("PRAGMA journal_mode")
    print(f"Journal mode: {cursor.fetchone()[0]}")

    cursor.execute("PRAGMA cache_size")
    print(f"Cache size: {cursor.fetchone()[0]}")

    cursor.execute("PRAGMA synchronous")
    print(f"Synchronous: {cursor.fetchone()[0]}")
```

### Standalone Test Script

A standalone test script is available:
```bash
python3 test_sqlite_backend.py
```

**Note:** Requires virtual environment to be activated and Django dependencies installed.

## References

- [SQLite PRAGMA Documentation](https://www.sqlite.org/pragma.html)
- [SQLite WAL Mode](https://www.sqlite.org/wal.html)
- [SQLite Performance Tuning](https://www.sqlite.org/performance.html)
- [Django Database Backends](https://docs.djangoproject.com/en/stable/ref/databases/)

## Maintenance

### Periodic Optimization

Run `PRAGMA optimize` periodically to update query planner statistics:

```bash
# Daily or weekly via cron
python3 manage.py optimize_sqlite

# Or with ANALYZE for comprehensive statistics
python3 manage.py optimize_sqlite --analyze
```

### Database Vacuum

For large databases with many deletions, periodically run:

```bash
python3 manage.py dbshell
# Then in SQLite shell:
VACUUM;
```

This reclaims space and can improve performance.

## Troubleshooting

### "database is locked" errors
- Ensure `transaction_mode="IMMEDIATE"` is set in OPTIONS (primary fix for
  concurrent-writer lock errors; busy_timeout alone does NOT cover the
  read-to-write upgrade deadlock case)
- Increase `busy_timeout` in PRAGMA settings (currently 30s)
- Check for long-running transactions
- Ensure `check_same_thread=False` in OPTIONS
- Verify WAL mode is enabled (allows concurrent readers)
- Consider lowering Django Q2 `workers` if write contention remains high

### High memory usage
- Reduce `cache_size` and `mmap_size` values in `base.py`
- Monitor with system tools (htop, top)
- Adjust based on available RAM

### Slow performance
- Verify WAL mode is enabled: `python3 manage.py verify_sqlite_optimizations`
- Check cache size: Should be -64000 (64MB)
- Run periodic optimization: `python3 manage.py optimize_sqlite`
- Consider database vacuum: `VACUUM` (see Maintenance section)
- Check for missing indexes on frequently queried columns

### Backend not loading
- Verify `ENGINE` in settings.py is `"core.db.backends.sqlite3"`
- Check that `core` is in `INSTALLED_APPS`
- Ensure `core/db/backends/sqlite3/__init__.py` exports `DatabaseWrapper`
