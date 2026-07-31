# Reddit PRAW Migration Design

> **Superseded by the Next.js migration (2026-07-30).** The Django implementation
> described here now lives in `old/`, read-only — paths like `core/…` are `old/core/…`
> today. This document is kept as a record of decisions that were correct when made,
> and its behavior descriptions remain the reference for porting them to TypeScript.
> See [the Next.js direction record](../superpowers/specs/2026-07-30-nextjs-migration-direction.md).

**Date:** 2026-02-03
**Status:** Draft
**Author:** Claude + Human

## Summary

Migrate Reddit integration from direct `requests` API calls to PRAW (Python Reddit API Wrapper) for automatic rate limiting, retry logic, and simplified maintenance.

## Problem

Current Reddit implementation has minimal rate limit handling:
- Only catches 429 during OAuth token acquisition
- No retry logic on rate limit errors
- Ignores `X-Ratelimit-*` headers from Reddit
- Post and comment fetching crash on 429 errors

## Solution

Replace direct HTTP calls with PRAW, which provides:
- Automatic rate limit header monitoring
- Configurable retry with backoff (`ratelimit_seconds`)
- Simplified API access
- Battle-tested edge case handling

## Design Decisions

### PRAW Instance Strategy

**Decision:** Create fresh PRAW instance per request

**Rationale:**
- PRAW instances are not thread-safe
- Aggregation runs in django-q2 background tasks (low frequency)
- Simplicity over micro-optimization
- No shared state to manage

### Authentication Flow

**Decision:** Client credentials only (read-only mode)

**Rationale:**
- Current implementation uses client credentials
- No user-level actions needed (only reading posts/comments)
- Each user has their own Reddit API credentials in `UserSettings`

### Rate Limit Configuration

**Decision:** Use PRAW defaults (`ratelimit_seconds=5`)

**Rationale:**
- If Reddit says "wait 3 seconds", PRAW waits automatically
- If Reddit says "wait 10+ minutes", exception is raised (appropriate for background task)
- Can be tuned later if needed

## Implementation

### Files Changed

| File | Change | Lines |
|------|--------|-------|
| `requirements.txt` | Add `praw>=7.7.1` | +1 |
| `auth.py` | Replace OAuth with `get_praw_instance()` | -100, +30 |
| `types.py` | Add `from_praw()` conversion methods | +40 |
| `urls.py` | Replace `fetch_subreddit_info()` | -20, +15 |
| `posts.py` | Use `reddit.submission()` | -30, +20 |
| `comments.py` | Use `submission.comments` | -30, +25 |
| `aggregator.py` | Use `subreddit.hot/new/top()` | -40, +35 |
| `test_reddit_aggregator.py` | Update mocks | ~100 |

### auth.py

**Remove:**
- `_token_cache` dict
- `get_reddit_access_token()`
- `get_reddit_auth_headers()`

**Add:**
```python
import praw
import prawcore.exceptions

def get_praw_instance(user_id: int) -> praw.Reddit:
    """Create a read-only PRAW instance for the user."""
    settings = get_reddit_user_settings(user_id)

    if not settings.get("reddit_enabled"):
        raise ValueError("Reddit is not enabled")

    client_id = settings.get("reddit_client_id", "")
    client_secret = settings.get("reddit_client_secret", "")

    if not client_id or not client_secret:
        raise ValueError("Reddit API credentials not configured")

    return praw.Reddit(
        client_id=client_id,
        client_secret=client_secret,
        user_agent=settings.get("reddit_user_agent", "Yana/1.0"),
    )
```

**Keep:**
- `get_reddit_user_settings()` - Still needed for credentials

### types.py

Add conversion methods:

```python
@classmethod
def from_praw(cls, submission) -> "RedditPostData":
    """Convert PRAW Submission to RedditPostData."""
    return cls({
        "id": submission.id,
        "title": submission.title,
        "author": getattr(submission.author, "name", "[deleted]"),
        "selftext": submission.selftext,
        "selftext_html": submission.selftext_html,
        "url": submission.url,
        "permalink": submission.permalink,
        "created_utc": submission.created_utc,
        "score": submission.score,
        "num_comments": submission.num_comments,
        "is_self": submission.is_self,
        "thumbnail": submission.thumbnail,
        "preview": getattr(submission, "preview", None),
        "media": submission.media,
        "crosspost_parent_list": getattr(submission, "crosspost_parent_list", None),
        # ... other fields as needed
    })
```

### aggregator.py

**Replace in `fetch_source_data()`:**

```python
# Before
headers = get_reddit_auth_headers(user_id)
response = requests.get(
    f"https://oauth.reddit.com/r/{subreddit}/{sort_by}",
    params={"limit": fetch_limit},
    headers=headers,
)
posts_data = response.json().get("data", {}).get("children", [])

# After
reddit = get_praw_instance(user_id)
subreddit_obj = reddit.subreddit(subreddit)
submissions = list(getattr(subreddit_obj, sort_by)(limit=fetch_limit))
posts = [RedditPostData.from_praw(s) for s in submissions]
```

**Replace in `get_identifier_choices()`:**

```python
# Before
response = requests.get(
    "https://oauth.reddit.com/subreddits/search",
    params={"q": query, "limit": "10"},
    headers=headers,
)

# After
reddit = get_praw_instance(user.id)
results = reddit.subreddits.search(query, limit=10)
```

### comments.py

**Replace in `fetch_post_comments()`:**

```python
# Before
response = requests.get(
    f"https://oauth.reddit.com/r/{subreddit}/comments/{post_id}",
    headers={"Authorization": f"Bearer {access_token}"},
)

# After
reddit = get_praw_instance(user_id)
submission = reddit.submission(id=post_id)
submission.comment_sort = "best"
submission.comments.replace_more(limit=0)  # Skip "load more" links
raw_comments = submission.comments.list()[:limit]
comments = [RedditComment.from_praw(c) for c in raw_comments]
```

### posts.py

**Replace in `fetch_reddit_post()`:**

```python
# Before
response = requests.get(
    f"https://oauth.reddit.com/r/{subreddit}/comments/{post_id}",
    headers=headers,
)

# After
reddit = get_praw_instance(user_id)
submission = reddit.submission(id=post_id)
_ = submission.title  # Trigger fetch
return RedditPostData.from_praw(submission)
```

### urls.py

**Replace in `fetch_subreddit_info()`:**

```python
# Before
response = requests.get(
    f"https://oauth.reddit.com/r/{subreddit}/about",
    headers=headers,
)

# After
reddit = get_praw_instance(user_id)
sub = reddit.subreddit(subreddit)
return {
    "iconUrl": sub.icon_img or sub.community_icon,
    "title": sub.title,
    "subscribers": sub.subscribers,
}
```

## Error Handling

### Exception Mapping

| PRAW Exception | HTTP Equivalent | Our Response |
|----------------|-----------------|--------------|
| `prawcore.exceptions.Forbidden` | 403 | `ValueError("Subreddit is private or banned")` |
| `prawcore.exceptions.NotFound` | 404 | `ValueError("Subreddit does not exist")` or `return None` |
| `praw.exceptions.RedditAPIException` | 429 (exceeded threshold) | `ValueError("Rate limit exceeded")` |
| `prawcore.exceptions.ResponseException` | Various | Log + re-raise with context |
| `prawcore.exceptions.RequestException` | Network error | Log + `ValueError("Failed to connect")` |

### Graceful Degradation

- **Comments fail** → Article created without comments
- **Single post fails** → Skip article, continue with others
- **Rate limit** → Raise error, let django-q2 retry later
- **Auth fails** → Clear error message about credentials

## Testing

### Mock Strategy

Mock at PRAW instance level, not HTTP:

```python
@pytest.fixture
def mock_praw_reddit():
    with patch("core.aggregators.reddit.auth.praw.Reddit") as mock:
        instance = MagicMock()
        mock.return_value = instance
        yield instance
```

### Test Cases

1. **Happy path** - Post listing, comments, single post fetch
2. **Rate limit** - `RedditAPIException` raised, handled gracefully
3. **Not found** - Subreddit/post doesn't exist
4. **Forbidden** - Private/banned subreddit
5. **Network error** - Connection failures
6. **Cross-posts** - Original post data extraction
7. **Comment filtering** - Bots, deleted, AutoModerator

## Migration Steps

1. Add `praw>=7.7.1` to requirements.txt
2. Update `types.py` with `from_praw()` methods
3. Rewrite `auth.py` - Replace OAuth with PRAW
4. Update `urls.py` - Subreddit info via PRAW
5. Update `posts.py` - Single post fetch
6. Update `comments.py` - Comment fetching
7. Update `aggregator.py` - Post listing and search
8. Update tests with PRAW mocks
9. Manual verification with `test_aggregator` command

## Rollback Plan

If issues arise:
1. Revert to previous commit
2. All changes are localized to `core/aggregators/reddit/`
3. No database migrations involved
4. No API contract changes

## Future Considerations

- **Async support:** PRAW has async variant (asyncpraw) if needed later
- **Caching:** Could cache PRAW instances per-user if performance becomes issue
- **Rate limit tuning:** Adjust `ratelimit_seconds` based on observed behavior
