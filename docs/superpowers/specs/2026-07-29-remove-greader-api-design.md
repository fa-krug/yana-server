# Spec 0: Remove the Google Reader API

> **Superseded by the Next.js migration (2026-07-30).** The Django implementation
> described here now lives in `old/`, read-only — paths like `core/…` are `old/core/…`
> today. This document is kept as a record of decisions that were correct when made,
> and its behavior descriptions remain the reference for porting them to TypeScript.
> See [the Next.js direction record](2026-07-30-nextjs-migration-direction.md).

**Date:** 2026-07-29
**Status:** Approved design, pending spec review
**Depends on:** nothing — this is the first spec on the route
**Direction:** `2026-07-29-client-server-remigration-direction.md`

## Goal

Delete the Google Reader–compatible API entirely. It exists to serve third-party RSS readers, and
the re-migration makes the first-party Yana client the only consumer. Removing it first means the
three specs that follow don't have to build compatibility shims and then throw them away.

This is a **pure deletion**. No replacement is built here — the new tailored API is a later,
separately-specced piece of work.

## Why first, not last

Keeping GReader alive through the rest of the route would force:

- **Spec 1** to keep `stream_format.py`'s `published` / `crawlTimeMsec` / `timestampUsec` coherent
  once article dates stop being fabricated, and to keep offset pagination working over a changed
  ordering.
- **Spec 4** to serve images to plain `<img>` tags with no auth header, forcing either an
  unauthenticated endpoint or signed expiring URLs.
- **Spec 5** to preserve HTML article bodies as a wire contract, blocking block-only storage.

Each of those is work that gets deleted later. Doing the deletion up front avoids all three.

## What gets deleted

| Path | Notes |
|---|---|
| `core/services/greader/` | 6 modules: `auth_service`, `stream_filter_builder`, `stream_format`, `stream_service`, `subscription_service`, `tag_service` |
| `core/views/greader/` | 6 modules: `auth`, `decorators`, `preference`, `stream`, `subscription`, `tag` |
| `core/urls/greader.py` | all 11+ endpoint routes |
| `core/tests/test_greader_*.py` | 7 files: `api_auth`, `auth`, `client_login`, `polish`, `stream`, `subscription`, `tag` |
| `yana/urls.py` | the `path("api/greader/", …)` entry |
| `core.models.GReaderAuthToken` | model + a migration dropping the table |
| `core/tests/test_models.py` | `TestGReaderAuthToken` class and the `GReaderAuthToken` import |

Roughly 3,500 lines across `core/services/greader/` and `core/views/greader/`, plus the tests.

## What must NOT be deleted

Several things reference GReader by name but are not GReader-specific. Deleting them would break
aggregation.

- **`BaseAggregator.get_source_url()`** and its overrides in `heise`, `merkur`, `mein_mmo`, `oglaf`,
  `reddit`. The docstrings say "for GReader API" ([base.py:448](../../../core/aggregators/base.py:448)),
  but the method returns the feed's canonical website URL and is useful independently. **Reword the
  docstrings; keep the method.**
- **`Article.icon`** ([models.py:139](../../../core/models.py:139)). Set by aggregators (YouTube
  populates it from channel metadata) and shown in admin. Not a GReader field.
- **`core/urls/default.py`** — `health/`, `api/youtube-proxy`, `api/dailymotion-proxy`. The health
  check is infrastructure. The two proxies are discussed below.

## The embed proxies — deliberately left alone

`youtube_proxy_view` and `dailymotion_proxy_view` exist so RSS clients could render video embeds,
and iOS's `EmbedRewriter` reproduces "the exact markup the server's proxy served". Once Spec 5 turns
embeds into typed `Embed` blocks the client plays with its own player, the proxies are probably
dead.

**They are not deleted here.** Between Spec 0 and Spec 5 the pipeline still produces HTML containing
proxy-backed embed markup, so removing the proxies now would break embeds during the interim. Spec 5
revisits them once `Embed` blocks exist. Recorded so the leftover is intentional.

## After deletion: the server has no HTTP API

What remains reachable:

```
/admin/          Django admin — the verification surface for this phase
/health/         health check
/media/…         media files
/api/youtube-proxy, /api/dailymotion-proxy   embed proxies (interim, see above)
/*               catch-all redirect to admin
```

The existing catch-all `re_path(r"^.*$", redirect_to_admin)` in `yana/urls.py` already handles
everything else, so removing the GReader include leaves no dangling routes — requests to old
GReader paths land on the admin redirect rather than a 500.

This API-less state is intentional and lasts until the new API spec is built. Aggregation is driven
by django-q2 scheduled tasks and the `test_aggregator` / `trigger_aggregator` management commands,
none of which touch the HTTP layer.

## Data migration

One migration, dropping the `GReaderAuthToken` table:

```python
operations = [migrations.DeleteModel(name="GReaderAuthToken")]
```

The table holds only SHA-256 hashed session tokens for third-party readers. There is nothing to
preserve — every token is invalidated by definition when the API it authenticates is gone. No
user-owned content is touched: `GReaderAuthToken` has a plain `ForeignKey` to `auth.User` with
`related_name="greader_tokens"` and no reverse dependencies from `Feed` or `Article`.

Note the existing `core/migrations/0004_greaderauthtoken.py` stays in place — migrations are an
append-only history, so the new migration deletes the model rather than editing 0004.

## Error handling

Not applicable in the usual sense; this removes code paths rather than adding them. The one
behavioral consideration is what old clients see: a request to `/api/greader/…` now matches the
catch-all and receives a redirect to `/admin/`. That is an acceptable answer to a retired API —
sending a `410 Gone` would be tidier but means keeping a route table for an API that no longer
exists, which defeats the purpose.

## Testing

Deletion is verified by absence, so the test work is mostly subtraction plus a guard:

- **Delete** the 7 `test_greader_*.py` files and `TestGReaderAuthToken` in `test_models.py`.
- **Assert the routes are gone**: a test that `GET /api/greader/reader/api/0/user-info` does not
  resolve to a GReader view (it should hit the admin redirect).
- **Assert the model is gone**: importing `GReaderAuthToken` from `core.models` raises
  `ImportError`.
- **Full suite green** afterwards: `pytest`. The suite is the real check that nothing outside the
  GReader tree depended on it — particularly that no aggregator test broke via `get_source_url`.
- **Migration round-trip**: `python3 manage.py migrate` forward on a database that has the table,
  confirming the drop applies cleanly.
- **Coverage** should not drop meaningfully; ~3,500 lines of code and its 7 test files leave
  together.

## Verification via admin

After this spec, confirm by hand:

1. `python3 manage.py runserver`, log into `/admin/`.
2. Feeds and Articles list, filter, and open normally.
3. No "GReader Tokens" entry appears in the admin index.
4. `/health/` still returns OK.
5. `python3 manage.py test_aggregator <id> --dry-run` still runs — proving aggregation is
   independent of the deleted API.

## Out of scope

- Building any replacement API.
- Deleting the embed proxies (Spec 5).
- Touching `Article.icon`, `get_source_url()`, or any aggregator behavior.
- Removing `django-q2` scheduling or management commands.
