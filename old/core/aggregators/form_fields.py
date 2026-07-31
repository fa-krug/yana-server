"""Form fields for aggregator configuration."""

from typing import Any, List, Optional

from django import forms


class SelectorListField(forms.CharField):
    """
    Comma-separated CSS selector input, stored in ``Feed.options`` as a list.

    Blank input cleans to ``None`` so ``BaseAggregator.save_options`` drops the
    key entirely. An absent key means "use the code defaults", which is not the
    same as an explicitly empty list.
    """

    def prepare_value(self, value: Any) -> Any:
        if isinstance(value, (list, tuple)):
            return ", ".join(str(item) for item in value)
        return value

    def clean(self, value: Any) -> Optional[List[str]]:
        raw = super().clean(value)
        if isinstance(raw, (list, tuple)):
            parts = [str(item) for item in raw]
        else:
            parts = str(raw or "").split(",")
        cleaned = [part.strip() for part in parts if part.strip()]
        return cleaned or None
