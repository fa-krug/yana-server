"""Drop the pre-Django (Drizzle ORM) tables left behind by the TypeScript server.

Thirteen tables from the project's pre-Django era survive in deployed databases.
Django's migration graph never created them and no code reads them -- they are
invisible to `makemigrations`, so only an explicit DROP removes them:

    __drizzle_migrations  articles     feed_groups  feeds     greader_auth_tokens
    groups                sessions     tasks        task_executions
    user_ai_quotas        user_article_states        user_settings      users

They are unreadable by the current application even in principle: integer Unix
timestamps instead of Django's datetime strings, and foreign keys into a legacy
`users` table rather than `auth_user`. Beyond the dead weight (in the reference
database `articles` alone held 43 MB of a 74 MB file), the cluster is a standing
liability -- the legacy `user_settings` row carries third-party API credentials
and `users` carries bcrypt password hashes that no admin surface can reach, so
they are never rotated or revoked.

`greader_auth_tokens` in particular held expired Google Reader tokens for an API
that no longer exists; see
docs/superpowers/specs/2026-07-29-remove-greader-api-design.md. Its Django-era
counterpart, `core_greaderauthtoken`, is dropped by migration 0026.

DROP order is significant. Django enables `PRAGMA foreign_keys`, and SQLite runs
an implicit DELETE FROM before removing a table, so a surviving table must never
reference an already-dropped one -- doing so fails with "no such table" once
SQLite tries to resolve the dangling reference. (These legacy foreign keys are
ON DELETE cascade, so a parent-first drop does not raise an integrity error; it
silently cascade-deletes children, or dies on the next dependent table.) Dropping
children before parents avoids both outcomes; the order below is verified by
`core/tests/test_legacy_table_cleanup.py`, which asserts a parents-first order
fails.

The reverse operation is a deliberate no-op. Recreating empty tables of a schema
no code can read would restore structure without data and without purpose; the
rows are gone either way. Reversing past this migration therefore succeeds and
simply leaves the tables absent.
"""

from django.db import migrations

# Children before parents -- see the module docstring.
LEGACY_TABLES = [
    "user_article_states",
    "feed_groups",
    "greader_auth_tokens",
    "user_ai_quotas",
    "user_settings",
    "articles",
    "groups",
    "feeds",
    "users",
    "sessions",
    "tasks",
    "task_executions",
    "__drizzle_migrations",
]

# One statement per table: the SQLite driver refuses multiple statements in a
# single execute(), and IF EXISTS keeps the migration safe on databases that
# never had the legacy schema (fresh installs, CI, the test database).
# A tuple rather than a list so it satisfies RunSQL's covariant sequence type.
DROP_STATEMENTS = tuple(f'DROP TABLE IF EXISTS "{table}"' for table in LEGACY_TABLES)


class Migration(migrations.Migration):
    dependencies = [
        ("core", "0028_article_created_at_indexes"),
    ]

    operations = [
        migrations.RunSQL(DROP_STATEMENTS, reverse_sql=migrations.RunSQL.noop),
    ]
