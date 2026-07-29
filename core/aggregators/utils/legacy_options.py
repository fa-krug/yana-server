"""Conversion helpers for the pre-Spec-1 selector options.

Kept as pure functions so migration 0027 stays thin and the behavior is
directly testable.

Ownership: this module is owned by migration
``core/migrations/0027_migrate_selector_options.py``, its only production
consumer. Do not delete it even though nothing under ``core/aggregators/``
imports it directly -- doing so would break that migration for anyone
running it from scratch (e.g. a fresh `migrate` or a squash).
"""

from typing import Any, Dict, List, Tuple

LEGACY_CONTENT_KEY = "custom_content_selector"
LEGACY_IGNORE_KEY = "custom_selectors_to_remove"
LEGACY_FULL_CONTENT_KEY = "use_full_content"


def clean_selector_list(value: Any) -> List[str]:
    """Split a comma string (or normalize a list) into non-empty selectors."""
    if isinstance(value, str):
        parts = value.split(",")
    elif isinstance(value, (list, tuple)):
        parts = [str(item) for item in value]
    else:
        return []
    return [part.strip() for part in parts if part.strip()]


def convert_legacy_options(options: Any) -> Tuple[Dict[str, Any], bool]:
    """
    Convert one feed's options to the Spec 1 schema.

    An existing new-style key always wins -- it may legitimately hold an empty
    list, which means "the user cleared this" and is not the same as absent.

    Args:
        options: The feed's raw options value (may be malformed)

    Returns:
        (new_options, convert_to_feed_content)
    """
    if not isinstance(options, dict):
        return {}, False

    converted = dict(options)

    legacy_content = converted.pop(LEGACY_CONTENT_KEY, None)
    if "content_selectors" not in converted:
        selectors = clean_selector_list(legacy_content)
        if selectors:
            converted["content_selectors"] = selectors

    legacy_ignore = converted.pop(LEGACY_IGNORE_KEY, None)
    if "ignore_selectors" not in converted:
        selectors = clean_selector_list(legacy_ignore)
        if selectors:
            converted["ignore_selectors"] = selectors

    to_feed_content = False
    if LEGACY_FULL_CONTENT_KEY in converted:
        to_feed_content = converted.pop(LEGACY_FULL_CONTENT_KEY) is False

    return converted, to_feed_content


def revert_options(options: Any) -> Dict[str, Any]:
    """
    Approximate reverse: selector lists become comma strings again.

    Which ``feed_content`` feeds were originally ``full_website`` is not
    recoverable, so the aggregator type is left alone.
    """
    if not isinstance(options, dict):
        return {}

    reverted = dict(options)

    if "content_selectors" in reverted:
        reverted[LEGACY_CONTENT_KEY] = ", ".join(
            clean_selector_list(reverted.pop("content_selectors"))
        )
    if "ignore_selectors" in reverted:
        reverted[LEGACY_IGNORE_KEY] = ", ".join(
            clean_selector_list(reverted.pop("ignore_selectors"))
        )

    return reverted
