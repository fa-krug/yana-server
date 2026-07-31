# Remove the Google Reader API — Implementation Plan

> **Superseded by the Next.js migration (2026-07-30).** The Django implementation
> described here now lives in `old/`, read-only — paths like `core/…` are `old/core/…`
> today. This document is kept as a record of decisions that were correct when made,
> and its behavior descriptions remain the reference for porting them to TypeScript.
> See [the Next.js direction record](../specs/2026-07-30-nextjs-migration-direction.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the Google Reader–compatible API from the Yana server entirely, leaving the server with no HTTP API beyond admin, health, media, and the two interim embed proxies.

**Architecture:** Pure deletion in three reviewable slices. Task 1 removes the HTTP surface (URLs, views, services, their tests). Task 2 drops the `GReaderAuthToken` model and its table via a `DeleteModel` migration. Task 3 removes the stale GReader vocabulary from code docstrings and user-facing documentation. Nothing is replaced — the tailored API is separately specced, later work.

**Tech Stack:** Python 3.13, Django 6.0, pytest + pytest-django, SQLite, `uv` for dependency and command execution, ruff for lint/format, mypy for typing.

**Spec:** `docs/superpowers/specs/2026-07-29-remove-greader-api-design.md`
**Direction:** `docs/superpowers/specs/2026-07-29-client-server-remigration-direction.md`

## Global Constraints

- **This is a pure deletion.** Build no replacement API, no compatibility shim, no `410 Gone` route table. Retired GReader paths land on the existing catch-all admin redirect.
- **Every command runs through `uv run`.** There is no activated virtualenv; `uv run pytest`, `uv run python manage.py …`, `uv run ruff …`, `uv run mypy core/`.
- **Do NOT delete `BaseAggregator.get_source_url()`** or its overrides in `heise`, `merkur`, `mein_mmo`, `oglaf`, `reddit`. The docstrings mention GReader but the method returns the feed's canonical website URL and is used independently. Reword the docstrings; keep the methods and their behavior.
- **Do NOT delete `Article.icon`** (`core/models.py:139`). It is populated by aggregators (YouTube channel metadata) and shown in admin. It is not a GReader field.
- **Do NOT delete `core/urls/default.py`** or anything it routes: `health/`, `api/youtube-proxy`, `api/dailymotion-proxy`.
- **Do NOT delete `youtube_proxy_view` or `dailymotion_proxy_view`.** They stay deliberately until Spec 5 turns embeds into typed blocks; the interim pipeline still emits proxy-backed embed markup.
- **Do NOT edit existing migrations.** Migration history is append-only. `core/migrations/0004_greaderauthtoken.py` stays exactly as it is; the new migration deletes the model.
- **Do NOT remove django-q2 scheduling or any management command.** No periodic task references GReader (verified in `core/migrations/0014_setup_periodic_tasks.py`).
- **Line length is 100 characters.** Double-quoted strings. Enforced by `ruff format`.
- **Every task ends with the full suite green:** `uv run pytest`. The baseline before this plan is **376 passed**.
- **Commit message format:** `<type>(<scope>): <Description>` — e.g. `refactor(greader): Delete the Google Reader HTTP surface`.

## Baseline facts (verified, do not re-derive)

- `GReaderAuthToken` is **not** registered in `core/admin.py`, so no admin change is needed to satisfy the spec's "no GReader Tokens entry in admin index" check — it was never there.
- No code outside `core/services/greader/`, `core/views/greader/`, `core/urls/greader.py`, and `core/tests/test_greader_*.py` calls `invalidate_unread_cache`, `cleanup_expired_tokens`, or any other GReader service function.
- `core/views/__init__.py`, `core/services/__init__.py`, and `core/urls/__init__.py` do **not** import anything from the GReader packages. They need no edits.
- Current behavior: `GET /api/greader/reader/api/0/user-info` returns **401**. After the URL include is removed it matches `re_path(r"^.*$", redirect_to_admin)` in `yana/urls.py` and returns **302** with `Location: /admin/`.
- Last existing migration is `0025_add_ai_request_delay`. The new migration will be `0026_delete_greaderauthtoken`.

---

### Task 1: Delete the GReader HTTP surface

Removes the URL routes, views, services, and their seven test files. This is the bulk of the deletion (~2,500 lines). The `GReaderAuthToken` model stays for now — Task 2 removes it — because `core/services/greader/auth_service.py` imports it and must go first.

**Files:**
- Create: `core/tests/test_greader_removed.py`
- Delete: `core/urls/greader.py`
- Delete: `core/views/greader/` (entire package: `__init__.py`, `auth.py`, `decorators.py`, `preference.py`, `stream.py`, `subscription.py`, `tag.py`)
- Delete: `core/services/greader/` (entire package: `__init__.py`, `auth_service.py`, `stream_filter_builder.py`, `stream_format.py`, `stream_service.py`, `subscription_service.py`, `tag_service.py`)
- Delete: `core/tests/test_greader_api_auth.py`
- Delete: `core/tests/test_greader_auth.py`
- Delete: `core/tests/test_greader_client_login.py`
- Delete: `core/tests/test_greader_polish.py`
- Delete: `core/tests/test_greader_stream.py`
- Delete: `core/tests/test_greader_subscription.py`
- Delete: `core/tests/test_greader_tag.py`
- Modify: `yana/urls.py` — remove line 19, `path("api/greader/", include("core.urls.greader")),`

**Interfaces:**
- Consumes: nothing from earlier tasks — this is the first task.
- Produces: the guard test module `core/tests/test_greader_removed.py` containing class `TestGReaderRoutesRemoved`. Task 2 adds a second class, `TestGReaderModelRemoved`, to this same file.

- [ ] **Step 1: Write the failing guard test**

Create `core/tests/test_greader_removed.py`:

```python
"""Guard tests: the Google Reader API stays deleted.

These assert absence. They exist so a future change cannot silently
reintroduce the GReader surface removed in Spec 0.
"""

from django.test import Client, TestCase
from django.urls import resolve


class TestGReaderRoutesRemoved(TestCase):
    """Old GReader paths must fall through to the catch-all admin redirect."""

    GREADER_PATHS = [
        "/api/greader/reader/api/0/user-info",
        "/api/greader/reader/api/0/token",
        "/api/greader/reader/api/0/subscription/list",
        "/api/greader/reader/api/0/stream/items/ids",
        "/api/greader/reader/api/0/unread-count",
        "/api/greader/reader/api/0/edit-tag",
        "/api/greader/accounts/ClientLogin",
    ]

    def setUp(self):
        self.client = Client()

    def test_greader_paths_redirect_to_admin(self):
        """No GReader path resolves to a GReader view; all redirect to admin."""
        for path in self.GREADER_PATHS:
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 302)
                self.assertEqual(response["Location"], "/admin/")

    def test_greader_paths_resolve_to_catch_all(self):
        """The resolved view is the catch-all redirect, not a GReader view."""
        for path in self.GREADER_PATHS:
            with self.subTest(path=path):
                match = resolve(path)
                self.assertEqual(match.func.__name__, "redirect_to_admin")

    def test_greader_url_namespace_is_gone(self):
        """reverse() on the retired 'greader' namespace must fail."""
        from django.urls import NoReverseMatch, reverse

        with self.assertRaises(NoReverseMatch):
            reverse("greader:user_info")
```

- [ ] **Step 2: Run the guard test to verify it fails**

Run: `uv run pytest core/tests/test_greader_removed.py -v --no-cov`

Expected: FAIL. `test_greader_paths_redirect_to_admin` gets 401 (not 302) for `user-info`, `test_greader_paths_resolve_to_catch_all` resolves to `user_info` rather than `redirect_to_admin`, and `test_greader_url_namespace_is_gone` reverses successfully instead of raising.

- [ ] **Step 3: Remove the URL include from the project URL conf**

In `yana/urls.py`, delete the `api/greader/` line so the list reads:

```python
urlpatterns: List[Any] = [
    path("admin/", admin.site.urls),
    path("", include("core.urls")),
]
```

Leave everything else in the file untouched — the media `re_path`, the `DEBUG` static block, and the trailing catch-all `re_path(r"^.*$", redirect_to_admin)` all stay.

- [ ] **Step 4: Delete the GReader packages, route module, and tests**

```bash
git rm -r core/services/greader core/views/greader
git rm core/urls/greader.py
git rm core/tests/test_greader_api_auth.py core/tests/test_greader_auth.py \
       core/tests/test_greader_client_login.py core/tests/test_greader_polish.py \
       core/tests/test_greader_stream.py core/tests/test_greader_subscription.py \
       core/tests/test_greader_tag.py
```

Then clear any stale bytecode so a leftover `.pyc` cannot mask a live import:

```bash
find core -name __pycache__ -type d -prune -exec rm -rf {} +
```

- [ ] **Step 5: Verify no dangling imports remain**

Run: `uv run python -c "import core.urls, yana.urls; print('url confs import cleanly')"`

Expected: prints `url confs import cleanly`. If it raises `ModuleNotFoundError` for a `core.views.greader` or `core.services.greader` module, something outside the deleted tree still imports it — find it with `grep -rn "greader" --include="*.py" core/ yana/` and remove that import. Do **not** recreate any deleted module.

- [ ] **Step 6: Run the guard test to verify it passes**

Run: `uv run pytest core/tests/test_greader_removed.py -v --no-cov`

Expected: PASS, 3 tests.

- [ ] **Step 7: Run the full suite**

Run: `uv run pytest`

Expected: PASS. The seven deleted `test_greader_*.py` files took their tests with them, so the count drops well below the 376 baseline. No failures and no errors. `core/tests/test_models.py::TestGReaderAuthToken` still passes at this point — the model is untouched until Task 2. If any *aggregator* test fails, `get_source_url` was damaged: restore it, it must not change.

- [ ] **Step 8: Lint, format, and type-check**

```bash
uv run ruff check core/ yana/ --fix && uv run ruff format core/ yana/ && uv run mypy core/
```

Expected: ruff reports no remaining errors, format leaves files unchanged or reformats only what you touched, mypy passes.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(greader): Delete the Google Reader HTTP surface

Remove core/urls/greader.py, core/views/greader/, core/services/greader/,
the seven test_greader_* modules, and the api/greader/ URL include.

Retired GReader paths now match the catch-all redirect to admin. Guard
tests in core/tests/test_greader_removed.py assert the routes and the
'greader' URL namespace are gone.

GReaderAuthToken is left in place; it goes in the next commit."
```

If the pre-commit `pytest` hook is slow but green, let it run. If a hook fails, fix the cause rather than passing `--no-verify`.

---

### Task 2: Drop the GReaderAuthToken model and its table

Removes the model from `core/models.py`, its tests from `core/tests/test_models.py`, and generates the `DeleteModel` migration. Ordered after Task 1 because `core/services/greader/auth_service.py` imported this model.

**Files:**
- Create: `core/migrations/0026_delete_greaderauthtoken.py`
- Modify: `core/tests/test_greader_removed.py` — add `TestGReaderModelRemoved`
- Modify: `core/models.py` — delete the `GReaderAuthToken` class (starts at line 275)
- Modify: `core/tests/test_models.py` — delete `TestGReaderAuthToken` (line 75 to end of file) and prune the imports it made unused

**Interfaces:**
- Consumes: `core/tests/test_greader_removed.py` from Task 1 — append to it, do not recreate it.
- Produces: migration `0026_delete_greaderauthtoken`, the new leaf of the `core` migration graph. Nothing later in this plan depends on it.

- [ ] **Step 1: Write the failing guard test**

Append to `core/tests/test_greader_removed.py`:

```python
class TestGReaderModelRemoved(TestCase):
    """The GReaderAuthToken model and its table must be gone."""

    def test_model_import_raises_import_error(self):
        """Importing GReaderAuthToken from core.models must fail."""
        with self.assertRaises(ImportError):
            from core.models import GReaderAuthToken  # noqa: F401

    def test_model_not_in_app_registry(self):
        """The app registry must not know the model either."""
        from django.apps import apps

        with self.assertRaises(LookupError):
            apps.get_model("core", "GReaderAuthToken")

    def test_table_does_not_exist(self):
        """The database table must be dropped."""
        from django.db import connection

        self.assertNotIn("core_greaderauthtoken", connection.introspection.table_names())

    def test_user_has_no_greader_tokens_relation(self):
        """The reverse accessor from User must be gone."""
        from django.contrib.auth.models import User

        self.assertFalse(hasattr(User, "greader_tokens"))
```

Note on `test_model_not_in_app_registry`: `apps.get_model` raises the **builtin** `LookupError` — there is no `LookupError` in `django.core.exceptions` (verified against this repo's pinned Django 6.0.0). The assertion is not vacuous: `"core"` is a valid app label, so the only way `get_model` raises here is if the model is genuinely absent from the registry. Reintroduce the model and `get_model` returns it, failing the block with "LookupError not raised".

- [ ] **Step 2: Run the guard test to verify it fails**

Run: `uv run pytest core/tests/test_greader_removed.py::TestGReaderModelRemoved -v --no-cov`

Expected: FAIL, all 4 tests — the import succeeds, the registry resolves the model, the table exists, and `User.greader_tokens` is present.

- [ ] **Step 3: Delete the model**

In `core/models.py`, delete the entire `GReaderAuthToken` class — from `class GReaderAuthToken(models.Model):` through its last method, including the `generate_for_user` classmethod and `is_valid`. Leave the classes above and below it untouched.

The deleted class was the only user of two module-level imports. `generate_for_user` called `secrets.token_hex(32)` and `timezone.now() + timedelta(days=days)`; `is_valid` called `timezone.now()`. After the deletion:

- **Delete `import secrets`** (line 3) — used only by `generate_for_user`.
- **Delete `from datetime import timedelta`** (line 4) — used only by `generate_for_user`.
- **KEEP `from django.utils import timezone`** (line 7) — still used at line 135, `Article.date = models.DateTimeField(default=timezone.now)`.

So the import block becomes:

```python
"""Database models for the application."""

from django.db import models
from django.utils import timezone

from .choices import AGGREGATOR_CHOICES
```

Confirm with `uv run ruff check core/models.py` — it flags both an unused import you left and a used one you removed.

- [ ] **Step 4: Delete the model's tests and prune imports**

In `core/tests/test_models.py`:

1. Delete the `TestGReaderAuthToken` class entirely (line 75 through end of file).
2. Change the `core.models` import to drop `GReaderAuthToken`:

```python
from core.models import Feed, FeedGroup, RedditSubreddit, YouTubeChannel
```

3. `timedelta` and `timezone` were used **only** by the deleted class (lines 88, 100). Delete both imports:

```python
from unittest.mock import patch

from django.contrib.auth.models import User
from django.test import TestCase

from core.models import Feed, FeedGroup, RedditSubreddit, YouTubeChannel
```

Keep `patch` — it is still used at line 63 (`@patch("core.aggregators.registry.AggregatorRegistry.get")`).

Then confirm with `uv run ruff check core/tests/test_models.py`, which flags any import you left unused or removed too eagerly.

- [ ] **Step 5: Generate the migration**

Run: `uv run python manage.py makemigrations core --name delete_greaderauthtoken`

Expected: creates `core/migrations/0026_delete_greaderauthtoken.py`. Read the generated file and confirm its `operations` list is exactly the delete, and its dependency is the previous leaf:

```python
class Migration(migrations.Migration):

    dependencies = [
        ("core", "0025_add_ai_request_delay"),
    ]

    operations = [
        migrations.DeleteModel(
            name="GReaderAuthToken",
        ),
    ]
```

If Django generated extra operations (e.g. `RemoveIndex` before the delete), that is acceptable — `DeleteModel` drops the table and its indexes together, and leaving the autogenerated form untouched is preferable to hand-editing. Do **not** touch `0004_greaderauthtoken.py`.

- [ ] **Step 6: Verify the migration applies against a database that has the table**

The table exists in the working `db.sqlite3` from before this change, which makes it the real round-trip test:

```bash
uv run python manage.py migrate core
```

Expected: `Applying core.0026_delete_greaderauthtoken... OK`.

Then confirm the table is actually gone:

```bash
uv run python manage.py shell -c "from django.db import connection; print('core_greaderauthtoken' in connection.introspection.table_names())"
```

Expected: prints `False`.

- [ ] **Step 7: Confirm no missing-migration drift**

Run: `uv run python manage.py makemigrations --check --dry-run`

Expected: reports no changes. If it wants to create another migration, the model deletion and the generated migration disagree — read its proposed output and reconcile before continuing.

- [ ] **Step 8: Run the guard test to verify it passes**

`pyproject.toml` sets `addopts = "… --reuse-db"`, which reuses an existing test database **without re-running migrations**. The `test_table_does_not_exist` assertion would then read a stale test DB that still has the table and fail for the wrong reason. Force a rebuild once, on this run only:

Run: `uv run pytest core/tests/test_greader_removed.py -v --no-cov --create-db`

Expected: PASS, 7 tests (3 from Task 1 plus 4 new). If `test_table_does_not_exist` fails, confirm you passed `--create-db` before treating it as a real failure.

- [ ] **Step 9: Run the full suite**

Run: `uv run pytest --create-db`

Expected: PASS, no failures, no errors. `TestGReaderAuthToken` is gone from the count. `--create-db` is needed here for the same reason as Step 8; later runs can drop it.

- [ ] **Step 10: Lint, format, and type-check**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
```

Expected: all three clean. Note that ruff and mypy are configured to skip `core/migrations/`, so the generated migration is not linted — that is intended.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "refactor(greader): Drop the GReaderAuthToken model and table

Delete the model from core/models.py, its tests from test_models.py, and
add migration 0026 dropping the table via DeleteModel.

The table held only SHA-256 hashed session tokens for third-party readers;
every one is invalidated by definition now that the API authenticating them
is gone. No user content is touched -- the FK to auth.User had no reverse
dependencies from Feed or Article.

Migration 0004 stays in place: history is append-only."
```

---

### Task 3: Retire the GReader vocabulary from docstrings and documentation

The API is gone but the codebase and docs still describe it. Six docstrings say `get_source_url` exists "for GReader API", `README.md` tells users to connect Reeder and NetNewsWire, and `CLAUDE.md` documents an endpoint table for routes that no longer resolve. This task makes the documentation match the code.

**Files:**
- Modify: `core/aggregators/base.py:448` — `get_source_url` docstring
- Modify: `core/aggregators/heise/aggregator.py:31`
- Modify: `core/aggregators/merkur/aggregator.py:29`
- Modify: `core/aggregators/mein_mmo/aggregator.py:24`
- Modify: `core/aggregators/oglaf/aggregator.py:56`
- Modify: `core/aggregators/reddit/aggregator.py:56`
- Modify: `README.md` — lines ~79-87 (Connecting RSS Clients), ~172-173 (architecture bullets), ~182 (test command), ~202 (ClientLogin troubleshooting), and the Google Reader API feature bullet
- Modify: `CLAUDE.md` — project overview, Quick Reference URLs, project structure tree, key models table, the entire Google Reader API section, and the "Important Files" table row

**Interfaces:**
- Consumes: nothing — this task is independent of Tasks 1 and 2 except that it describes their outcome. Run it last so the docs describe the finished state.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Reword the `get_source_url` docstrings**

The method and its return value do not change — only the prose. In `core/aggregators/base.py`, the docstring currently reads that the value "is used by the GReader API to return the feed's website/source URL". Replace the GReader mention with what the method actually provides:

```python
        This returns the feed's canonical website URL -- the human-facing page
        a reader would open, as opposed to the feed identifier the aggregator
        fetches from. Subclasses override it when the two differ.
```

Then reword the five overrides so none mentions GReader:

- `core/aggregators/heise/aggregator.py`: `"""Return the Heise website URL."""`
- `core/aggregators/merkur/aggregator.py`: `"""Return the Merkur website URL."""`
- `core/aggregators/mein_mmo/aggregator.py`: `"""Return the Mein-MMO website URL."""`
- `core/aggregators/oglaf/aggregator.py`: `"""Return the Oglaf website URL."""`
- `core/aggregators/reddit/aggregator.py`: `"""Return the Reddit subreddit URL."""`

Change nothing but the docstrings. The method bodies, signatures, and return values stay byte-for-byte identical.

- [ ] **Step 2: Verify no GReader references remain in Python source**

Run:

```bash
grep -rn "greader\|GReader\|Google Reader" --include="*.py" core/ yana/ | grep -v "core/migrations/"
```

Expected: only hits inside `core/tests/test_greader_removed.py` (the guard tests, which must name what they assert is absent). Migrations are excluded deliberately — `0004_greaderauthtoken.py` and `0005`'s dependency reference are frozen history.

- [ ] **Step 3: Update `README.md`**

Three edits:

1. **Replace the "Connecting RSS Clients" section.** It currently instructs users to point Reeder/NetNewsWire/FeedMe at a Google Reader endpoint that no longer exists. Replace the whole section with:

```markdown
### Clients

Yana currently has no HTTP API. Content is aggregated by background tasks and
inspected through the Django admin at `http://<your-server-ip>:8000/admin/`.

The Google Reader compatible API was removed: the first-party Yana app for
iOS/macOS is becoming the only client, and a tailored API is being designed to
replace it. Third-party RSS readers are not supported in the meantime.
```

2. **Fix the Features and Project Architecture bullets.** Replace the `- **Google Reader API:** Full compatibility with desktop and mobile RSS readers.` feature bullet with:

```markdown
-   **Admin-First:** Feeds, groups, and articles are managed and inspected through the Django admin.
```

And in Project Architecture, replace the two GReader lines:

```markdown
-   **`core/services/`**: Business logic (aggregation triggers, article maintenance).
```

(Delete the `core/views/greader/` bullet entirely — there is no replacement line for it.)

3. **Fix the test command and troubleshooting entry.** Replace `uv run python manage.py test core.tests.test_greader` with a module that exists:

```bash
uv run python manage.py test core.tests.test_models
```

And delete the `**"ClientLogin" Errors:**` troubleshooting paragraph outright — the endpoint it troubleshoots is gone.

- [ ] **Step 4: Update `CLAUDE.md`**

`CLAUDE.md` is the instruction file for AI assistants working on this repo, so a stale endpoint table there actively misleads future work. Edits:

1. **Project Overview** — the opening sentence claims "Google Reader API compatibility" and a GReader-compatible API for external clients. Rewrite to:

```markdown
**Yana** is a self-hosted Django 6.0 RSS aggregator. It aggregates content from multiple sources (RSS, YouTube, Reddit, Podcasts, specialized website scrapers) into a SQLite store, inspected and managed through the Django admin. A tailored HTTP API for the first-party iOS/macOS client is in design; the server currently exposes no article API.
```

2. **Quick Reference URLs** — delete the `- API: http://localhost:8000/api/greader/*` line. Keep Admin and Health.

3. **Project structure tree** — remove the `core/services/greader/` and `core/views/greader/` entries and the `greader.py` entry under `core/urls/`. Update the `models.py` comment to drop `GReaderAuthToken`:

```
│   ├── models.py                 # FeedGroup, Feed, Article, UserSettings
```

4. **Key Models table** — delete the `GReaderAuthToken` row.

5. **Delete the entire "Google Reader API" section** — its Endpoints table, the Authentication paragraph, and the ID Formats block. Replace the whole section with:

```markdown
## HTTP Surface

The server has no article API. What is reachable:

| Path | Purpose |
|---|---|
| `/admin/` | Django admin — the verification surface for the current phase |
| `/health/` | Health check |
| `/media/…` | Media files |
| `/api/youtube-proxy`, `/api/dailymotion-proxy` | Embed proxies (interim) |
| `/*` | Catch-all redirect to admin |

The Google Reader API was removed (see
`docs/superpowers/specs/2026-07-29-remove-greader-api-design.md`). Aggregation
runs via django-q2 scheduled tasks and the `test_aggregator` /
`trigger_aggregator` management commands — none of which touch HTTP.
```

6. **Important Files table** — replace the `| GReader API | … |` row with:

```markdown
| HTTP views | `core/views/default.py`, `core/urls/default.py` |
```

7. **Commit Message Format example** — the `fix(greader): Correct unread count calculation` sample references a retired scope. Change it to `fix(aggregator): Correct duplicate article detection`.

- [ ] **Step 5: Verify the documentation is consistent**

Run:

```bash
grep -rn "greader\|GReader\|Google Reader" README.md CLAUDE.md
```

Expected: **only past-tense removal context** — the two paragraphs in Steps 3 and 4 that name what was removed and link the spec. Nothing else.

The bar is that no remaining hit describes GReader as *available*: no connection instructions, no endpoint table, no auth-header documentation, no "Server Type: Google Reader" client setup. Naming the retired API historically is deliberate and required — a reader who finds "the previous RSS-sync API" has no way to know the term to search for, and a user whose Reeder setup just broke needs the docs to say why. Check each hit against that bar rather than counting hits.

Then confirm every path the new `CLAUDE.md` HTTP Surface table claims actually resolves:

```bash
ALLOWED_HOSTS=testserver,localhost uv run python -c "
import os, django
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'yana.settings')
django.setup()
from django.test import Client
c = Client()
for p in ['/health/', '/api/youtube-proxy?v=dQw4w9WgXcQ', '/api/greader/reader/api/0/user-info']:
    r = c.get(p)
    print(p, '->', r.status_code, r.get('Location') or '')
"
```

Expected: `/health/` → 200, `/api/youtube-proxy?v=…` → 200, `/api/greader/…` → 302 `/admin/`.

- [ ] **Step 6: Run the full suite**

Run: `uv run pytest`

Expected: PASS, no failures, no errors. Docstring rewording touches no behavior, so any failure here means a method body was edited by accident — compare against `git diff` and revert the code change.

- [ ] **Step 7: Lint, format, and type-check**

```bash
uv run ruff check core/ --fix && uv run ruff format core/ && uv run mypy core/
```

Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "docs(greader): Retire the GReader vocabulary from code and docs

Reword the get_source_url docstrings in base.py and the five aggregator
overrides -- the method returns the feed's canonical website URL and is
useful independently of the API that used to consume it. Behavior unchanged.

Update README.md and CLAUDE.md to describe the server as it now is: no
article API, admin as the verification surface, and no instructions for
connecting third-party RSS readers to an endpoint that no longer resolves."
```

---

## Manual verification (after all three tasks)

The spec asks for hand-verification through admin. Run these once at the end:

```bash
uv run python manage.py runserver
```

1. Log into `http://localhost:8000/admin/`.
2. Feeds and Articles list, filter, and open normally.
3. No "Google Reader Auth Tokens" entry appears in the admin index.
4. `http://localhost:8000/health/` returns `{"status": "healthy", "database": "connected"}`.
5. Stop the server, then confirm aggregation is independent of the deleted API:

```bash
uv run python manage.py test_aggregator tagesschau --dry-run --limit 3
```

Expected: fetches and reports articles without error.

## Out of scope

- Building any replacement API. The tailored API needs its own brainstorm and spec.
- Deleting the embed proxies — Spec 5 revisits them once typed `Embed` blocks exist.
- Touching `Article.icon`, `get_source_url()`'s behavior, or any aggregator logic.
- Removing django-q2 scheduling or management commands.
- Editing `core/migrations/0004_greaderauthtoken.py` or any other existing migration.
