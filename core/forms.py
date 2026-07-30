"""Forms for the application."""

import logging

from django import forms
from django.utils.html import format_html

from .aggregators.feed_logo import store_feed_logo
from .aggregators.registry import AggregatorRegistry
from .aggregators.utils import resolve_feed_url
from .ai_client import AIClient
from .models import Feed, UserSettings

logger = logging.getLogger(__name__)


class TextareaWithCopyButtonWidget(forms.Textarea):
    """
    A textarea widget with a copy-to-clipboard button.

    Useful for readonly or large text fields where users might want to
    copy the content easily.
    """

    template_name = "admin/widgets/textarea_with_copy.html"

    class Media:
        css = {"all": ("admin/css/copy_button.css",)}
        js = ("admin/js/copy_button.js",)

    def __init__(self, attrs=None):
        default_attrs = {"rows": 10, "cols": 80}
        if attrs:
            default_attrs.update(attrs)
        super().__init__(attrs=default_attrs)


class ReadonlyWithHiddenInputWidget(forms.Widget):
    """
    A widget that renders a readonly display value AND a hidden input.

    This is useful for fields that should be displayed as readonly but still
    need to submit their value in the form (e.g., for 'Save as new' functionality).
    """

    template_name = ""  # We override render() completely, no template needed

    def __init__(self, display_value="", choices=None, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.display_value = display_value
        self.choices = choices or []

    def render(self, name, value, attrs=None, renderer=None):
        # Get the display text for the value
        display_text = self.display_value
        if not display_text and self.choices:
            for choice_value, choice_label in self.choices:
                if choice_value == value:
                    display_text = choice_label
                    break

        if not display_text:
            display_text = value or ""

        # Render readonly display + hidden input
        return format_html(
            '<span class="readonly">{}</span><input type="hidden" name="{}" value="{}">',
            display_text,
            name,
            value or "",
        )


class UserSettingsAdminForm(forms.ModelForm):
    """Custom form for UserSettings admin with validation."""

    class Meta:
        model = UserSettings
        fields = [
            "user",
            "reddit_enabled",
            "reddit_client_id",
            "reddit_client_secret",
            "reddit_user_agent",
            "youtube_enabled",
            "youtube_api_key",
            "active_ai_provider",
            "openai_enabled",
            "openai_api_url",
            "openai_api_key",
            "openai_model",
            "anthropic_enabled",
            "anthropic_api_key",
            "anthropic_model",
            "gemini_enabled",
            "gemini_api_key",
            "gemini_model",
            "ai_temperature",
            "ai_max_tokens",
            "ai_default_daily_limit",
            "ai_default_monthly_limit",
            "ai_max_prompt_length",
            "ai_request_timeout",
            "ai_max_retries",
            "ai_retry_delay",
            "ai_request_delay",
        ]

    def clean(self):
        cleaned_data = super().clean()

        # Check OpenAI
        if cleaned_data.get("openai_enabled"):
            api_key = cleaned_data.get("openai_api_key")
            model = cleaned_data.get("openai_model")
            api_url = cleaned_data.get("openai_api_url")

            # Check if relevant fields changed or if it was just enabled
            if (
                "openai_enabled" in self.changed_data
                or "openai_api_key" in self.changed_data
                or "openai_model" in self.changed_data
                or "openai_api_url" in self.changed_data
            ) and not AIClient.verify_api_connection("openai", api_key, model, api_url):
                self.add_error(
                    "openai_api_key", "Verification failed: Could not connect to OpenAI API."
                )

        # Check Anthropic
        if cleaned_data.get("anthropic_enabled"):
            api_key = cleaned_data.get("anthropic_api_key")
            model = cleaned_data.get("anthropic_model")

            if (
                "anthropic_enabled" in self.changed_data
                or "anthropic_api_key" in self.changed_data
                or "anthropic_model" in self.changed_data
            ) and not AIClient.verify_api_connection("anthropic", api_key, model):
                self.add_error(
                    "anthropic_api_key",
                    "Verification failed: Could not connect to Anthropic API.",
                )

        # Check Gemini
        if cleaned_data.get("gemini_enabled"):
            api_key = cleaned_data.get("gemini_api_key")
            model = cleaned_data.get("gemini_model")

            if (
                "gemini_enabled" in self.changed_data
                or "gemini_api_key" in self.changed_data
                or "gemini_model" in self.changed_data
            ) and not AIClient.verify_api_connection("gemini", api_key, model):
                self.add_error(
                    "gemini_api_key", "Verification failed: Could not connect to Gemini API."
                )

        return cleaned_data


class FeedAdminForm(forms.ModelForm):
    """Custom form for Feed admin."""

    class Meta:
        model = Feed
        fields = [
            "name",
            "aggregator",
            "identifier",
            "reddit_subreddit",
            "youtube_channel",
            "daily_limit",
            "enabled",
            "user",
            "group",
            "options",
        ]
        widgets = {
            "identifier": forms.TextInput(attrs={"class": "vTextField"}),
        }

    ai_summarize = forms.BooleanField(
        required=False, label="AI Summarize", help_text="Generate a summary of the article."
    )
    ai_improve_writing = forms.BooleanField(
        required=False,
        label="AI Improve Writing",
        help_text="Rewrite the article to improve clarity and style.",
    )
    ai_translate = forms.BooleanField(
        required=False,
        label="AI Translate",
        help_text="Translate the article to another language.",
    )
    ai_translate_language = forms.CharField(
        required=False,
        label="Target Language",
        help_text="Language to translate to (e.g., 'German', 'French', 'English').",
    )

    def __init__(self, *args, **kwargs):
        # The ModelAdmin passes 'request' to the form, but ModelForm doesn't expect it.
        # Remove it before calling super().__init__
        self.request = kwargs.pop("request", None)
        super().__init__(*args, **kwargs)
        # Set help text or other field attributes
        if "aggregator" in self.fields:
            self.fields[
                "aggregator"
            ].help_text = "Select aggregator type. This determines available identifier choices."

    def clean_identifier(self):
        """Normalize and resolve the identifier for free-form URL aggregators.

        A user pasting ``golem.de`` gets ``https://golem.de/rss.php`` stored.
        ``resolve_feed_url`` never raises, so a dead or unreachable site still
        saves -- with the normalized input.
        """
        identifier = self.cleaned_data.get("identifier", "")
        if not identifier:
            return identifier

        aggregator_type = self.cleaned_data.get("aggregator") or self.instance.aggregator
        try:
            agg_class = AggregatorRegistry.get(aggregator_type)
        except Exception:
            return identifier

        if not agg_class.resolves_feed_url():
            return identifier

        return resolve_feed_url(identifier)

    def save(self, commit=True):
        """
        Save the feed and try to fetch the icon if missing or if identifier changed.
        """
        from .aggregators import get_aggregator

        instance = super().save(commit=False)

        # Normalize identifier if changed
        if "identifier" in self.changed_data:
            try:
                aggregator = get_aggregator(instance)
                instance.identifier = aggregator.normalize_identifier(instance.identifier)
            except Exception:
                pass

        if commit:
            instance.save()
            self.save_m2m()
            # Direct (non-admin) callers save with commit=True and never reach
            # FeedAdmin.save_model, so the logo is resolved here for them.
            self.refresh_logo_if_needed(instance)

        return instance

    def refresh_logo_if_needed(self, instance) -> None:
        """Resolve the logo when the identifier or aggregator changed, or none is set.

        Called from ``save(commit=True)`` for direct callers and from
        ``FeedAdmin.save_model`` for the admin, whose ``save_form()`` saves with
        ``commit=False`` and would otherwise skip it entirely.

        Best-effort: a failure here must never surface as a save error.
        """
        needs_logo = (
            "identifier" in self.changed_data
            or "aggregator" in self.changed_data
            or not instance.logo
        )
        if not needs_logo:
            return

        try:
            store_feed_logo(instance)
        except Exception:
            logger.exception(f"Logo resolution failed for feed {instance.pk}")
