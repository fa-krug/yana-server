"""AI-assisted CSS selector suggestion for a feed.

Mirrors the iOS client's ``SelectorSuggester``: fetch one article page, show the
model a size-capped digest of its markup plus the list currently configured, and
take back a replacement for exactly one of ``content_selectors`` /
``ignore_selectors``.

The digest keeps markup rather than plain text -- a selector cannot be named from
prose -- but applies the same "strip chrome, cap length" idea: script/style/
noscript/svg and comments go, every text node is truncated, and the whole thing
is capped.
"""

import json
import logging
import re
from typing import Any, Literal

from bs4 import BeautifulSoup, Comment

from core.aggregators.utils import fetch_html, parse_rss_feed
from core.ai_client import AIClient
from core.models import UserSettings

logger = logging.getLogger(__name__)

SelectorKind = Literal["content", "ignore"]

OPTION_KEYS: dict[str, str] = {
    "content": "content_selectors",
    "ignore": "ignore_selectors",
}

KIND_INSTRUCTIONS: dict[str, str] = {
    "content": (
        "Return CSS selectors that match the container(s) holding the main article body. "
        "Prefer one stable selector; add more only when the body is genuinely split across "
        "containers."
    ),
    "ignore": (
        "Return CSS selectors for noise that should be stripped from the article body: ads, "
        "share bars, newsletter boxes, related-article teasers, comment sections, cookie banners."
    ),
}

CHROME_TAGS = ("script", "style", "noscript", "svg", "template")
MAX_TEXT_NODE_CHARS = 80
MAX_DIGEST_CHARS = 40000

JSON_SCHEMA: dict[str, Any] = {
    "type": "OBJECT",
    "properties": {"selectors": {"type": "ARRAY", "items": {"type": "STRING"}}},
    "required": ["selectors"],
}


class SelectorSuggestionError(Exception):
    """A suggestion could not be produced. The existing list must stay untouched."""


def has_ai_provider(user: Any) -> bool:
    """Whether ``user`` has an AI provider configured."""
    if user is None:
        return False
    try:
        settings_row = UserSettings.objects.get(user=user)
    except UserSettings.DoesNotExist:
        return False
    return bool(settings_row.active_ai_provider)


def html_digest_for_selectors(html: str, max_chars: int = MAX_DIGEST_CHARS) -> str:
    """Structure-preserving, size-capped digest of ``html`` for prompting."""
    soup = BeautifulSoup(html or "", "html.parser")

    for tag in soup(list(CHROME_TAGS)):
        tag.decompose()

    for comment in soup.find_all(string=lambda text: isinstance(text, Comment)):
        comment.extract()

    for text_node in soup.find_all(string=True):
        collapsed = re.sub(r"\s+", " ", str(text_node)).strip()
        if len(collapsed) > MAX_TEXT_NODE_CHARS:
            collapsed = collapsed[:MAX_TEXT_NODE_CHARS] + "…"
        text_node.replace_with(collapsed)

    return str(soup)[:max_chars]


def _page_url(feed: Any) -> str:
    """URL of an article page to learn selectors from."""
    article = feed.articles.order_by("-created_at").first()
    if article and article.identifier:
        return str(article.identifier)

    try:
        data = parse_rss_feed(feed.identifier)
    except Exception as exc:
        raise SelectorSuggestionError(f"No article page to inspect: {exc}") from exc

    for entry in data.get("entries", []):
        link = entry.get("link")
        if link:
            return str(link)

    raise SelectorSuggestionError("No article page to inspect: the feed has no entries")


def _current_selectors(feed: Any, kind: SelectorKind) -> list[str]:
    options = feed.options or {}
    value = options.get(OPTION_KEYS[kind]) or []
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value]
    return [part.strip() for part in str(value).split(",") if part.strip()]


def _decode_selectors(raw: str) -> list[str]:
    """Decode ``{"selectors": [...]}``, tolerating a fenced or wrapped response."""
    candidates = [raw]
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
    if fenced:
        candidates.append(fenced.group(1))
    start, end = raw.find("{"), raw.rfind("}")
    if start != -1 and end > start:
        candidates.append(raw[start : end + 1])

    for candidate in candidates:
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        selectors = payload.get("selectors") if isinstance(payload, dict) else None
        if isinstance(selectors, list):
            return [str(item).strip() for item in selectors if str(item).strip()]

    raise SelectorSuggestionError("The AI response was not decodable JSON")


def suggest_selectors(feed: Any, kind: SelectorKind) -> list[str]:
    """Suggest the ``kind`` selector list for ``feed``.

    Raises:
        ValueError: If ``kind`` is not "content" or "ignore".
        SelectorSuggestionError: On any fetch, provider, or decode failure. The
            caller must leave the existing list untouched.
    """
    if kind not in OPTION_KEYS:
        raise ValueError(f"Unknown selector kind: {kind}")

    try:
        settings_row = UserSettings.objects.get(user=feed.user)
    except UserSettings.DoesNotExist as exc:
        raise SelectorSuggestionError("No AI provider is configured") from exc

    if not settings_row.active_ai_provider:
        raise SelectorSuggestionError("No AI provider is configured")

    url = _page_url(feed)
    try:
        html = fetch_html(url)
    except Exception as exc:
        raise SelectorSuggestionError(f"Could not fetch {url}: {exc}") from exc

    current = _current_selectors(feed, kind)
    prompt = "\n".join(
        [
            "You suggest CSS selectors for a web scraper. Answer with JSON only: "
            '{"selectors": ["...", "..."]}. No prose, no markdown fences.',
            KIND_INSTRUCTIONS[kind],
            "These selectors are currently configured. Keep the ones still appropriate for "
            f"this page and drop the stale ones: {json.dumps(current)}",
            f"Page URL: {url}",
            "Page markup (truncated):",
            html_digest_for_selectors(html),
        ]
    )

    response = AIClient(settings_row).generate_response(
        prompt, json_mode=True, json_schema=JSON_SCHEMA
    )
    if not response:
        raise SelectorSuggestionError("The AI provider returned no response")

    selectors = _decode_selectors(response)
    if not selectors:
        raise SelectorSuggestionError("The AI provider suggested no selectors")

    return selectors


def apply_suggested_selectors(feed: Any, kind: SelectorKind) -> tuple[list[str], list[str]]:
    """Write a suggestion into ``feed.options``, overwriting only that list.

    Returns:
        ``(previous, new)`` selector lists.

    Raises:
        SelectorSuggestionError: On failure -- ``feed.options`` is left untouched.
    """
    previous = _current_selectors(feed, kind)
    new = suggest_selectors(feed, kind)

    options = dict(feed.options or {})
    options[OPTION_KEYS[kind]] = new
    feed.options = options
    feed.save(update_fields=["options", "updated_at"])

    logger.info(f"Feed {feed.pk}: {OPTION_KEYS[kind]} {previous} -> {new}")
    return previous, new
