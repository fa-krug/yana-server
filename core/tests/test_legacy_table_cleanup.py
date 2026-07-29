"""Tests for the migration that drops the pre-Django (Drizzle ORM) tables.

The legacy cluster is invisible to Django's autodetector, so these tests recreate
it in the test database -- schemas copied from a real deployed database, trimmed
to the columns and foreign keys that matter -- and then run the migration's own
statements against it.
"""

import importlib

from django.db import connection
from django.db.utils import OperationalError

import pytest

MIGRATION_MODULE = "core.migrations.0029_drop_legacy_drizzle_tables"

# Parents first: this is creation order, the reverse of the drop order.
LEGACY_SCHEMA = [
    """CREATE TABLE "users" (
        "id" integer PRIMARY KEY NOT NULL,
        "username" text NOT NULL,
        "email" text NOT NULL,
        "password_hash" text NOT NULL
    )""",
    """CREATE TABLE "feeds" (
        "id" integer PRIMARY KEY NOT NULL,
        "user_id" integer,
        "name" text NOT NULL,
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null
    )""",
    """CREATE TABLE "groups" (
        "id" integer PRIMARY KEY NOT NULL,
        "name" text NOT NULL,
        "user_id" integer,
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
    )""",
    """CREATE TABLE "articles" (
        "id" integer PRIMARY KEY NOT NULL,
        "feed_id" integer NOT NULL,
        "name" text NOT NULL,
        "url" text NOT NULL,
        FOREIGN KEY ("feed_id") REFERENCES "feeds"("id") ON DELETE cascade
    )""",
    """CREATE TABLE "feed_groups" (
        "id" integer PRIMARY KEY NOT NULL,
        "feed_id" integer NOT NULL,
        "group_id" integer NOT NULL,
        FOREIGN KEY ("feed_id") REFERENCES "feeds"("id") ON DELETE cascade,
        FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE cascade
    )""",
    """CREATE TABLE "greader_auth_tokens" (
        "id" integer PRIMARY KEY NOT NULL,
        "user_id" integer NOT NULL,
        "token" text NOT NULL,
        "expires_at" integer,
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
    )""",
    """CREATE TABLE "user_ai_quotas" (
        "id" integer PRIMARY KEY NOT NULL,
        "user_id" integer NOT NULL,
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
    )""",
    """CREATE TABLE "user_settings" (
        "id" integer PRIMARY KEY NOT NULL,
        "user_id" integer NOT NULL,
        "openai_api_key" text DEFAULT '' NOT NULL,
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade
    )""",
    """CREATE TABLE "user_article_states" (
        "id" integer PRIMARY KEY NOT NULL,
        "user_id" integer NOT NULL,
        "article_id" integer NOT NULL,
        FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade,
        FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE cascade
    )""",
    """CREATE TABLE "sessions" (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expire INTEGER NOT NULL
    )""",
    """CREATE TABLE "tasks" (
        "id" integer PRIMARY KEY NOT NULL,
        "type" text NOT NULL
    )""",
    """CREATE TABLE "task_executions" (
        "id" integer PRIMARY KEY NOT NULL,
        "task_id" text NOT NULL
    )""",
    """CREATE TABLE "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at numeric
    )""",
]

# Child rows exist so the order tests mean something: with no rows, any drop
# order succeeds. SQLite runs an implicit DELETE FROM when foreign keys are
# enforced, so only a populated cluster exercises the dependency constraints.
LEGACY_ROWS = [
    ("""INSERT INTO "users" VALUES (1, 'admin', 'a@example.com', '$2b$10$hash')""", ()),
    ("""INSERT INTO "feeds" VALUES (1, 1, 'Legacy feed')""", ()),
    ("""INSERT INTO "groups" VALUES (1, 'Legacy group', 1)""", ()),
    ("""INSERT INTO "articles" VALUES (1, 1, 'Legacy article', 'https://example.com/a')""", ()),
    ("""INSERT INTO "feed_groups" VALUES (1, 1, 1)""", ()),
    ("""INSERT INTO "greader_auth_tokens" VALUES (1, 1, 'stale-token', 1765000000)""", ()),
    ("""INSERT INTO "user_ai_quotas" VALUES (1, 1)""", ()),
    ("""INSERT INTO "user_settings" VALUES (1, 1, 'sk-stale')""", ()),
    ("""INSERT INTO "user_article_states" VALUES (1, 1, 1)""", ()),
]


@pytest.fixture
def migration():
    return importlib.import_module(MIGRATION_MODULE)


def _table_names():
    with connection.cursor() as cursor:
        cursor.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        return {row[0] for row in cursor.fetchall()}


def _create_legacy_cluster():
    with connection.cursor() as cursor:
        for statement in LEGACY_SCHEMA:
            cursor.execute(statement)
        for statement, params in LEGACY_ROWS:
            cursor.execute(statement, params)


def _run(statements):
    with connection.cursor() as cursor:
        for statement in statements:
            cursor.execute(statement)


@pytest.mark.django_db(transaction=True)
class TestDropLegacyTables:
    @pytest.fixture(autouse=True)
    def _isolate_legacy_cluster(self, migration):
        """Drop the cluster around every test.

        ``django_db`` rolls back or truncates the tables Django knows about, but
        these are created with raw DDL and survive both -- without this fixture a
        test would inherit whatever the previous one left behind, and one failure
        would cascade into "table already exists" everywhere after it.
        """
        _run(migration.DROP_STATEMENTS)
        yield
        _run(migration.DROP_STATEMENTS)

    def test_every_legacy_table_is_dropped(self, migration):
        _create_legacy_cluster()
        assert set(migration.LEGACY_TABLES) <= _table_names()

        _run(migration.DROP_STATEMENTS)

        remaining = _table_names() & set(migration.LEGACY_TABLES)
        assert remaining == set(), f"legacy tables survived: {sorted(remaining)}"

    def test_django_tables_are_left_alone(self, migration):
        _create_legacy_cluster()

        _run(migration.DROP_STATEMENTS)

        tables = _table_names()
        for table in ("core_article", "core_feed", "auth_user", "django_migrations"):
            assert table in tables, f"{table} must survive the cleanup"

    def test_drop_order_survives_foreign_key_enforcement(self, migration):
        with connection.cursor() as cursor:
            cursor.execute("PRAGMA foreign_keys")
            assert cursor.fetchone()[0] == 1, "test is meaningless without FK enforcement"

        _create_legacy_cluster()

        _run(migration.DROP_STATEMENTS)  # must not raise

        assert _table_names() & set(migration.LEGACY_TABLES) == set()

    def test_a_parents_first_order_would_fail(self):
        """Pins why the order is not arbitrary.

        A surviving table cannot reference a dropped one: SQLite runs an implicit
        DELETE FROM and then cannot resolve the dangling reference. Note these
        legacy foreign keys are ON DELETE cascade, so this surfaces as
        OperationalError ("no such table"), not IntegrityError.
        """
        _create_legacy_cluster()

        with pytest.raises(OperationalError, match="no such table"):
            _run([f'DROP TABLE IF EXISTS "{t}"' for t in ("users", "feeds", "articles", "groups")])

    def test_running_forward_twice_is_safe(self, migration):
        """Fresh installs and CI never had the cluster -- IF EXISTS covers them."""
        _create_legacy_cluster()

        _run(migration.DROP_STATEMENTS)
        _run(migration.DROP_STATEMENTS)

        assert _table_names() & set(migration.LEGACY_TABLES) == set()

    def test_runs_on_a_database_that_never_had_the_cluster(self, migration):
        assert _table_names() & set(migration.LEGACY_TABLES) == set()

        _run(migration.DROP_STATEMENTS)

        assert "core_article" in _table_names()


class TestMigrationDefinition:
    def test_covers_exactly_the_documented_cluster(self, migration):
        """Guards against a name being dropped from the list by accident."""
        assert set(migration.LEGACY_TABLES) == {
            "__drizzle_migrations",
            "articles",
            "feed_groups",
            "feeds",
            "greader_auth_tokens",
            "groups",
            "sessions",
            "task_executions",
            "tasks",
            "user_ai_quotas",
            "user_article_states",
            "user_settings",
            "users",
        }

    def test_children_are_dropped_before_their_parents(self, migration):
        order = migration.LEGACY_TABLES
        dependencies = {
            "user_article_states": ["articles", "users"],
            "feed_groups": ["feeds", "groups"],
            "articles": ["feeds"],
            "greader_auth_tokens": ["users"],
            "user_ai_quotas": ["users"],
            "user_settings": ["users"],
            "groups": ["users"],
            "feeds": ["users"],
        }
        for child, parents in dependencies.items():
            for parent in parents:
                assert order.index(child) < order.index(parent), (
                    f"{child} must be dropped before {parent}"
                )

    def test_one_statement_per_table(self, migration):
        """The SQLite driver executes a single statement per execute() call."""
        assert len(migration.DROP_STATEMENTS) == len(migration.LEGACY_TABLES)
        for statement in migration.DROP_STATEMENTS:
            assert statement.startswith("DROP TABLE IF EXISTS ")
            assert ";" not in statement

    def test_reverse_is_a_noop(self, migration):
        from django.db import migrations as django_migrations

        operation = migration.Migration.operations[0]
        assert operation.reverse_sql is django_migrations.RunSQL.noop
        assert operation.reversible

    def test_depends_on_the_previous_migration(self, migration):
        assert migration.Migration.dependencies == [("core", "0028_article_created_at_indexes")]
