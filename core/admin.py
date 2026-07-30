"""Admin configuration for the application."""

import contextlib
import logging

from django.contrib import admin, messages
from django.contrib.admin.sites import NotRegistered  # type: ignore
from django.contrib.auth.admin import GroupAdmin as BaseGroupAdmin
from django.contrib.auth.admin import UserAdmin as BaseUserAdmin
from django.contrib.auth.models import Group, User
from django.db import transaction
from django.db.models import Sum
from django.template.defaultfilters import filesizeformat
from django.utils.html import format_html, format_html_join

from django_q.admin import FailAdmin as BaseFailAdmin
from django_q.admin import QueueAdmin as BaseQueueAdmin
from django_q.admin import ScheduleAdmin as BaseScheduleAdmin
from django_q.admin import TaskAdmin as BaseTaskAdmin
from django_q.models import Failure, OrmQ, Schedule, Task
from djangoql.admin import DjangoQLSearchMixin
from import_export.admin import ImportExportMixin, ImportExportModelAdmin

from .aggregators.feed_logo import store_feed_logo
from .aggregators.services.image_store import find_image_refs
from .aggregators.utils import parse_rss_feed, resolve_feed_url
from .forms import FeedAdminForm, TextareaWithCopyButtonWidget, UserSettingsAdminForm
from .models import (
    Article,
    ArticleImage,
    Feed,
    FeedGroup,
    RedditSubreddit,
    UserSettings,
    YouTubeChannel,
)
from .services import AggregatorService, ArticleService
from .services.selector_suggester import (
    SelectorSuggestionError,
    apply_suggested_selectors,
    has_ai_provider,
)

logger = logging.getLogger(__name__)

# Customize Admin Site
admin.site.site_header = "Yana"
admin.site.site_title = "Yana Admin"
admin.site.index_title = "Welcome to Yana"
admin.site.site_url = None

# The "Resolve & test" action fetches each feed from inside an admin request.
# parse_rss_feed's default lets feedparser do its own HTTP, which has no timeout
# at all, so one black-holed host would hang the request indefinitely.
RESOLVE_TEST_TIMEOUT = 5


class YanaDjangoQLMixin(DjangoQLSearchMixin):
    """Mixin to enable DjangoQL search with toggle disabled by default."""

    djangoql_completion_enabled_by_default = False
    list_per_page = 20


class EfficientRelatedOnlyFieldListFilter(admin.RelatedOnlyFieldListFilter):
    """
    Custom RelatedOnlyFieldListFilter that clears default ordering to ensure DISTINCT works correctly.
    This prevents N+1 or large duplicate result sets when the related model has default ordering.
    """

    def field_choices(self, field, request, model_admin):
        # Access the queryset used by the filter
        # We must invoke the same logic as RelatedOnlyFieldListFilter but ensure ordering is cleared
        # so distinct() actually reduces the result set to unique FKs.
        pk_qs = (
            model_admin.get_queryset(request)
            .all()
            .order_by()
            .distinct()
            .values_list("%s__pk" % self.field_path, flat=True)
        )
        return field.get_choices(include_blank=False, limit_choices_to={"pk__in": pk_qs})


@admin.action(description="Clear raw article content for selected feeds")
def clear_raw_article_content(modeladmin, request, queryset):
    from .models import Article

    count = Article.objects.filter(feed__in=queryset).update(raw_content="")
    modeladmin.message_user(request, f"Cleared raw content for {count} articles.")


@admin.action(description="Delete all articles from selected feeds")
def delete_all_articles(modeladmin, request, queryset):
    from .models import Article

    count, _ = Article.objects.filter(feed__in=queryset).delete()
    modeladmin.message_user(request, f"Deleted {count} articles from selected feeds.")


@admin.register(RedditSubreddit)
class RedditSubredditAdmin(YanaDjangoQLMixin, admin.ModelAdmin):
    list_display = ["display_name", "title", "subscribers", "created_at"]
    search_fields = ["display_name", "title"]
    readonly_fields = ["created_at"]

    def get_search_results(self, request, queryset, search_term):
        queryset, use_distinct = super().get_search_results(request, queryset, search_term)

        if search_term and len(search_term) >= 2:
            try:
                from .aggregators.reddit.aggregator import RedditAggregator

                if hasattr(RedditAggregator, "update_search_results"):
                    RedditAggregator.update_search_results(search_term, request.user)

                queryset, _ = super().get_search_results(
                    request, self.model.objects.all(), search_term
                )

            except Exception as e:
                print(f"Error searching Reddit: {e}")

        return queryset, use_distinct


@admin.register(YouTubeChannel)
class YouTubeChannelAdmin(YanaDjangoQLMixin, admin.ModelAdmin):
    list_display = ["title", "handle", "channel_id", "created_at"]
    search_fields = ["title", "handle", "channel_id"]
    readonly_fields = ["created_at"]

    def get_search_results(self, request, queryset, search_term):
        queryset, use_distinct = super().get_search_results(request, queryset, search_term)

        if search_term and len(search_term) >= 2:
            try:
                from .aggregators.youtube.aggregator import YouTubeAggregator

                if hasattr(YouTubeAggregator, "update_search_results"):
                    YouTubeAggregator.update_search_results(search_term, request.user)

                queryset, _ = super().get_search_results(
                    request, self.model.objects.all(), search_term
                )

            except Exception as e:
                print(f"Error searching YouTube: {e}")

        return queryset, use_distinct


@admin.register(FeedGroup)
class FeedGroupAdmin(YanaDjangoQLMixin, admin.ModelAdmin):
    """Admin configuration for FeedGroup model."""

    list_display = ["name", "user", "created_at"]
    list_filter = [("user", admin.RelatedOnlyFieldListFilter), "created_at"]
    search_fields = ["name", "user__username"]
    readonly_fields = ["created_at", "updated_at"]
    save_as = True
    list_select_related = ["user"]

    fieldsets = (
        (None, {"fields": ("name", "user")}),
        ("Timestamps", {"fields": ("created_at", "updated_at"), "classes": ("collapse",)}),
    )


@admin.register(Feed)
class FeedAdmin(YanaDjangoQLMixin, ImportExportModelAdmin):
    """Admin configuration for Feed model."""

    form = FeedAdminForm

    list_display = ["name", "aggregator", "enabled", "user", "group", "created_at"]
    list_filter = [
        "aggregator",
        "enabled",
        ("user", admin.RelatedOnlyFieldListFilter),
        ("group", admin.RelatedOnlyFieldListFilter),
        "created_at",
    ]
    search_fields = ["name", "identifier", "user__username"]
    readonly_fields = ["created_at", "updated_at"]
    actions = [
        "resolve_and_test_feeds",
        "refresh_feed_logos",
        "aggregate_selected_feeds",
        "force_delete_selected",
        "delete_all_articles",
        "clear_raw_article_content",
        "suggest_content_selectors",
        "suggest_ignore_selectors",
    ]
    SUGGEST_ACTIONS = ("suggest_content_selectors", "suggest_ignore_selectors")
    autocomplete_fields = ["reddit_subreddit", "youtube_channel"]
    save_as = True
    list_select_related = ["user", "group", "reddit_subreddit", "youtube_channel"]

    def get_fieldsets(self, request, obj=None):
        """Dynamic fieldsets: Simple for Add, Detailed for Edit."""
        # Check if this is a "Save as new" operation
        is_save_as_new = "_saveasnew" in request.POST

        if not obj and not is_save_as_new:
            # Add View: Minimal fields
            return ((None, {"fields": ("name", "aggregator")}),)

        # For "Save as new", get aggregator from POST data
        aggregator_type = obj.aggregator if obj else request.POST.get("aggregator", "")

        # Edit View: Full fields
        # Always include "aggregator" (not "aggregator_info") so it's part of the form.
        # In edit view, we'll use a custom widget to show it as readonly + hidden input.
        fields = [
            "name",
            "aggregator",
        ]

        try:
            from .aggregators.registry import AggregatorRegistry

            agg_class = AggregatorRegistry.get(aggregator_type)
            fields.append(agg_class.identifier_field)
        except Exception:
            fields.append("identifier")

        fields.extend(["enabled"])

        # DYNAMIC CONFIG FIELDS
        config_field_names = []
        if aggregator_type:
            try:
                from .aggregators.registry import AggregatorRegistry

                agg_class = AggregatorRegistry.get(aggregator_type)
                config_fields = agg_class.get_configuration_fields()
                config_field_names = list(config_fields.keys())
            except Exception:
                pass

        # Add config fields to the Configuration set
        config_fieldset_fields = config_field_names + ["daily_limit"]

        return (
            (None, {"fields": fields}),
            ("Configuration", {"fields": config_fieldset_fields}),
            (
                "AI Configuration",
                {
                    "fields": (
                        "ai_summarize",
                        "ai_improve_writing",
                        "ai_translate",
                        "ai_translate_language",
                    )
                },
            ),
            ("Relationships", {"fields": ("user", "group")}),
            ("Timestamps", {"fields": ("created_at", "updated_at"), "classes": ("collapse",)}),
        )

    def get_readonly_fields(self, request, obj=None):
        """Return readonly fields for the admin form."""
        # We no longer use aggregator_info since we use a custom widget for aggregator
        # that renders both readonly display and hidden input.
        return ["created_at", "updated_at"]

    @admin.display(description="Aggregator Type")
    def aggregator_info(self, instance):
        """Display information about the selected aggregator."""

        if not instance.aggregator:
            return "-"

        try:
            from .aggregators.registry import AggregatorRegistry

            agg_class = AggregatorRegistry.get(instance.aggregator)

            doc = agg_class.__doc__ or ""

            # Return first line of docstring

            return doc.strip().split("\n")[0]

        except Exception:
            return "Unknown aggregator"

    def get_form(self, request, obj=None, **kwargs):
        """
        Pass request to form and dynamically adjust fields.
        - Add View: Only name/aggregator.
        - Edit View / Save as new: Inject config fields and toggling logic.
        """
        # Check if this is a "Save as new" operation
        is_save_as_new = "_saveasnew" in request.POST

        # Filter out non-model fields (dynamic config fields) from kwargs['fields']
        # to ensure modelform_factory doesn't raise FieldError
        if "fields" in kwargs and kwargs["fields"]:
            valid_fields = {f.name for f in self.model._meta.get_fields()}
            kwargs["fields"] = [f for f in kwargs["fields"] if f in valid_fields]
            # Ensure our FKs are in valid_fields if we passed them?
            # They are in the model, so yes.

        # Note: We used to try adding "aggregator" to kwargs["fields"] here, but
        # Django calls get_form() with empty kwargs, so that approach doesn't work.
        # Instead, we add the aggregator field directly in RequestForm.__init__ below.

        form_class = super().get_form(request, obj, **kwargs)

        # Get aggregator type from obj or POST data (for "Save as new")
        aggregator_type = None
        if obj and obj.aggregator:
            aggregator_type = obj.aggregator
        elif is_save_as_new:
            aggregator_type = request.POST.get("aggregator", "")

        # Capture whether this is edit view for use in RequestForm
        is_edit_view = obj is not None and not is_save_as_new

        class RequestForm(form_class):
            def __init__(self_form, *args, **kwargs):
                from .forms import ReadonlyWithHiddenInputWidget

                super().__init__(*args, **kwargs)

                # In edit view, make the aggregator field appear readonly while still
                # including a hidden input for form submission. This is critical for
                # "Save as new" to work - the aggregator value must be in POST data.
                if is_edit_view and "aggregator" in self_form.fields:
                    # Get the display label for the current aggregator value
                    choices = list(self_form.fields["aggregator"].choices)
                    self_form.fields["aggregator"].widget = ReadonlyWithHiddenInputWidget(
                        choices=choices,
                    )

                # Handling for Edit View (obj exists) or "Save as new"
                if aggregator_type:
                    # 1. Inject aggregator-specific configuration fields
                    try:
                        from .aggregators.registry import AggregatorRegistry

                        agg_class = AggregatorRegistry.get(aggregator_type)

                        # Check if aggregator provides static identifier choices
                        # (not dynamic search)
                        if not agg_class.supports_identifier_search:
                            choices = agg_class.get_identifier_choices(user=request.user)
                            if choices:
                                from django import forms

                                self_form.fields["identifier"].widget = forms.Select(
                                    choices=choices
                                )

                        config_fields = agg_class.get_configuration_fields()

                        # Add config fields
                        for field_name, field in config_fields.items():
                            self_form.fields[field_name] = field
                            if obj and obj.options and field_name in obj.options:
                                self_form.initial[field_name] = obj.options[field_name]

                    except Exception as e:
                        print(f"Error configuring form for aggregator: {e}")

                # Initialize AI fields from options
                ai_fields = [
                    "ai_summarize",
                    "ai_improve_writing",
                    "ai_translate",
                    "ai_translate_language",
                ]
                for field_name in ai_fields:
                    if obj and obj.options and field_name in obj.options:
                        self_form.initial[field_name] = obj.options[field_name]

        return RequestForm

    def save_model(self, request, obj, form, change):
        """Save aggregator-specific fields to options JSON."""
        if obj.aggregator:
            try:
                from .aggregators.registry import AggregatorRegistry

                aggregator = AggregatorRegistry.get(obj.aggregator)(obj)
                aggregator.save_options(form.cleaned_data)
            except Exception as e:
                print(f"Error saving aggregator options: {e}")

        # Save AI fields to options
        ai_fields = [
            "ai_summarize",
            "ai_improve_writing",
            "ai_translate",
            "ai_translate_language",
        ]
        if not obj.options:
            obj.options = {}

        for field_name in ai_fields:
            if field_name in form.cleaned_data:
                obj.options[field_name] = form.cleaned_data[field_name]

        super().save_model(request, obj, form, change)

        # The logo is resolved here, not in the form: ModelAdmin.save_form() calls
        # form.save(commit=False), so the form's commit=True branch never runs in
        # the admin. ``obj`` has a pk by now and ``form.changed_data`` is still
        # available, which is what the refresh needs.
        #
        # It is deferred to on_commit because resolving a logo does network I/O
        # (icon page + download). save_model runs inside changeform_view's
        # atomic block, and with transaction_mode="IMMEDIATE" that would hold
        # SQLite's write lock for the whole fetch.
        refresh_logo = getattr(form, "refresh_logo_if_needed", None)
        if refresh_logo is None:
            return

        def resolve_logo_after_commit() -> None:
            # Still best-effort: an on_commit callback that raises would
            # propagate out of the atomic block and surface as a save error.
            try:
                refresh_logo(obj)
            except Exception:
                logger.exception(f"Logo resolution failed for feed {obj.pk}")

        transaction.on_commit(resolve_logo_after_commit)

    def response_add(self, request, obj, post_url_continue=None):
        """
        Redirect to the change view after adding a new Feed.
        This allows the user to immediately see and configure the aggregator-specific options
        that appear only after the feed type is saved.

        Special handling for 'Save as new': redirect to changelist instead.
        """
        from django.http import HttpResponseRedirect
        from django.urls import reverse
        from django.utils.html import format_html
        from django.utils.translation import gettext as _

        opts = obj._meta

        # If the user clicked "Save as new", redirect to changelist
        if "_saveasnew" in request.POST:
            changelist_url = reverse(
                f"admin:{opts.app_label}_{opts.model_name}_changelist",
                current_app=self.admin_site.name,
            )
            msg = format_html(
                _('The {name} "{obj}" was added successfully.'),
                name=opts.verbose_name,
                obj=obj,
            )
            self.message_user(request, msg, messages.SUCCESS)
            return HttpResponseRedirect(changelist_url)

        # If the user clicked "Save" (not "Save and add another" or "Save and continue editing")
        if "_save" in request.POST:
            change_url = reverse(
                f"admin:{opts.app_label}_{opts.model_name}_change",
                args=(obj.pk,),
                current_app=self.admin_site.name,
            )
            # Add a message to let the user know they can now configure options
            msg = format_html(
                _('The {name} "{obj}" was added successfully. You may edit it again below.'),
                name=opts.verbose_name,
                obj=obj,
            )
            self.message_user(request, msg, messages.SUCCESS)
            return HttpResponseRedirect(change_url)

        return super().response_add(request, obj, post_url_continue)

    @admin.action(description="Resolve & test")
    def resolve_and_test_feeds(self, request, queryset):
        """Resolve each identifier and report how many entries it yields.

        Reports only -- nothing is saved, so this is safe to run on a feed you
        are still configuring.
        """
        from .aggregators.registry import AggregatorRegistry

        for feed in queryset:
            try:
                agg_class = AggregatorRegistry.get(feed.aggregator)
            except Exception:
                self.message_user(
                    request, f"{feed.name}: unknown aggregator '{feed.aggregator}'", messages.ERROR
                )
                continue

            resolved = (
                resolve_feed_url(feed.identifier)
                if agg_class.resolves_feed_url()
                else feed.identifier
            )

            try:
                data = parse_rss_feed(resolved, timeout=RESOLVE_TEST_TIMEOUT)
            except Exception as exc:
                self.message_user(
                    request, f"{feed.name}: {resolved} failed -- {exc}", messages.ERROR
                )
                continue

            # No zero-entries case to report: parse_rss_feed raises
            # ValueError("No entries found in feed") for an empty feed, which the
            # except above already turns into an ERROR message.
            entries = len(data.get("entries", []))
            self.message_user(
                request, f"{feed.name}: {resolved} yields {entries} entries", messages.SUCCESS
            )

    @admin.action(description="Refresh feed logo")
    def refresh_feed_logos(self, request, queryset):
        """Re-resolve and re-download the logo for the selected feeds."""
        for feed in queryset:
            try:
                stored = store_feed_logo(feed)
            except Exception as exc:
                self.message_user(request, f"{feed.name}: logo failed -- {exc}", messages.ERROR)
                continue

            if stored:
                self.message_user(
                    request, f"{feed.name}: logo from {feed.logo_source_url}", messages.SUCCESS
                )
            else:
                self.message_user(request, f"{feed.name}: no logo resolved", messages.WARNING)

    @admin.action(description="Aggregate selected feeds")
    def aggregate_selected_feeds(self, request, queryset):
        """Admin action to aggregate selected feeds directly."""
        total_feeds = queryset.count()
        successful = 0
        failed = 0
        total_articles = 0

        for feed in queryset:
            try:
                result = AggregatorService.trigger_by_feed_id(feed.id)

                if result["success"]:
                    successful += 1
                    total_articles += result["articles_count"]
                else:
                    failed += 1

            except Exception:
                failed += 1

        # Summary message
        if successful > 0:
            self.message_user(
                request,
                f"Aggregation complete: {successful}/{total_feeds} feeds successful, "
                f"{total_articles} total articles aggregated",
                messages.SUCCESS if failed == 0 else messages.WARNING,
            )

        if failed > 0:
            self.message_user(
                request,
                f"Aggregation finished with {failed} failure(s). Check logs for details.",
                messages.WARNING if successful > 0 else messages.ERROR,
            )

    @admin.action(description="Force delete selected feeds")
    def force_delete_selected(self, request, queryset):
        """Force delete selected feeds without confirmation."""
        count = queryset.count()
        queryset.delete()
        self.message_user(request, f"Successfully deleted {count} feeds.", messages.SUCCESS)

    def get_actions(self, request):
        """Hide the AI suggest actions entirely when no provider is configured.

        Hidden rather than disabled, matching the iOS client.
        """
        actions = super().get_actions(request)
        if not has_ai_provider(getattr(request, "user", None)):
            for name in self.SUGGEST_ACTIONS:
                actions.pop(name, None)
        return actions

    def _suggest_selectors(self, request, queryset, kind):
        """Ask the configured AI provider for ``kind`` selectors, per feed."""
        for feed in queryset:
            try:
                previous, new = apply_suggested_selectors(feed, kind)
            except SelectorSuggestionError as exc:
                self.message_user(request, f"{feed.name}: {exc}", messages.ERROR)
                continue

            self.message_user(
                request, f"{feed.name}: {kind} selectors {previous} -> {new}", messages.SUCCESS
            )

    @admin.action(description="Suggest content selectors")
    def suggest_content_selectors(self, request, queryset):
        """Ask the configured AI provider for content selectors."""
        self._suggest_selectors(request, queryset, "content")

    @admin.action(description="Suggest ignore selectors")
    def suggest_ignore_selectors(self, request, queryset):
        """Ask the configured AI provider for ignore selectors."""
        self._suggest_selectors(request, queryset, "ignore")


@admin.register(Article)
class ArticleAdmin(YanaDjangoQLMixin, ImportExportModelAdmin):
    """Admin configuration for Article model."""

    list_display = ["name", "feed", "author", "date", "read", "starred", "created_at"]
    list_filter = [
        ("feed", EfficientRelatedOnlyFieldListFilter),
        "read",
        "starred",
        "date",
        "created_at",
    ]
    search_fields = ["name", "author", "identifier"]
    readonly_fields = ["created_at", "updated_at", "referenced_images"]
    actions = ["reload_selected_articles", "force_delete_selected"]
    save_as = True
    list_select_related = ["feed"]

    fieldsets = (
        (None, {"fields": ("name", "identifier", "feed")}),
        ("Content", {"fields": ("raw_content", "content")}),
        ("Images", {"fields": ("referenced_images",)}),
        ("Metadata", {"fields": ("author", "icon", "date")}),
        ("Status", {"fields": ("read", "starred")}),
        ("Timestamps", {"fields": ("created_at", "updated_at"), "classes": ("collapse",)}),
    )

    def formfield_for_dbfield(self, db_field, request, **kwargs):
        """Use TextareaWithCopyButtonWidget for content fields."""
        if db_field.name in ("content", "raw_content"):
            kwargs["widget"] = TextareaWithCopyButtonWidget(attrs={"rows": 15, "cols": 80})
        return super().formfield_for_dbfield(db_field, request, **kwargs)

    def get_queryset(self, request):
        qs = super().get_queryset(request)
        return qs.defer("content", "raw_content")

    @admin.action(description="Reload selected articles")
    def reload_selected_articles(self, request, queryset):
        """Admin action to reload selected articles directly."""
        total_articles = queryset.count()
        successful = 0
        failed = 0

        total_fetched = 0
        total_processed = 0

        for article in queryset:
            try:
                result = ArticleService.reload_article(article.id)

                if result["success"]:
                    successful += 1
                    total_fetched += result.get("fetch_size", 0)
                    total_processed += result.get("process_size", 0)
                else:
                    failed += 1

            except Exception:
                failed += 1

        # Summary message
        if successful > 0:
            msg = f"Reload complete: {successful}/{total_articles} articles successful."
            if total_fetched > 0 or total_processed > 0:
                msg += f" Total: {total_fetched} bytes fetched, {total_processed} bytes processed."

            self.message_user(
                request,
                msg,
                messages.SUCCESS if failed == 0 else messages.WARNING,
            )

        if failed > 0:
            self.message_user(
                request,
                f"Reload finished with {failed} failure(s). Check logs for details.",
                messages.WARNING if successful > 0 else messages.ERROR,
            )

    @admin.action(description="Force delete selected articles")
    def force_delete_selected(self, request, queryset):
        """Force delete selected articles without confirmation."""
        count = queryset.count()
        queryset.delete()
        self.message_user(request, f"Successfully deleted {count} articles.", messages.SUCCESS)

    @admin.display(description="Referenced images")
    def referenced_images(self, obj):
        """Show the stored images this article references, so a missing one is
        traceable to the article that wanted it."""
        if not obj or not obj.pk:
            return "-"

        hashes = find_image_refs(obj.content or "")
        if not hashes:
            return "No hosted images referenced"

        stored = {
            image.content_hash: image
            for image in ArticleImage.objects.filter(content_hash__in=hashes)
        }

        cells = []
        for content_hash in sorted(hashes):
            image = stored.get(content_hash)
            if image and image.file:
                cells.append(
                    format_html(
                        '<a href="{}" target="_blank"><img src="{}" '
                        'style="max-height: 90px; margin: 0 8px 8px 0;"></a>',
                        image.file.url,
                        image.file.url,
                    )
                )
            else:
                cells.append(
                    format_html('<span style="color: #ba2121;">missing: {}</span> ', content_hash)
                )

        return format_html_join("", "{}", ((cell,) for cell in cells))


@admin.register(ArticleImage)
class ArticleImageAdmin(YanaDjangoQLMixin, admin.ModelAdmin):
    """
    Read-only view of the content-addressed image store.

    Rows are derived from aggregation: hand-editing one makes its hash a lie, so
    adding and changing are disabled. Deletion stays available for manual
    cleanup (``prune_orphaned_images`` is the automated path).
    """

    list_display = [
        "thumbnail",
        "short_hash",
        "content_type",
        "dimensions",
        "byte_size",
        "created_at",
    ]
    list_filter = ["content_type", "created_at"]
    search_fields = ["content_hash"]
    readonly_fields = [
        "preview",
        "content_hash",
        "file",
        "content_type",
        "width",
        "height",
        "byte_size",
        "created_at",
    ]
    fields = list(readonly_fields)
    change_list_template = "admin/core/articleimage/change_list.html"

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    @admin.display(description="Preview")
    def thumbnail(self, obj):
        if not obj.file:
            return "-"
        return format_html(
            '<img src="{}" style="max-height: 60px; max-width: 100px;">', obj.file.url
        )

    @admin.display(description="Image")
    def preview(self, obj):
        if not obj.file:
            return "-"
        return format_html(
            '<a href="{}" target="_blank"><img src="{}" style="max-height: 400px; '
            'max-width: 100%;"></a>',
            obj.file.url,
            obj.file.url,
        )

    @admin.display(description="Hash", ordering="content_hash")
    def short_hash(self, obj):
        return obj.content_hash[:12]

    @admin.display(description="Dimensions")
    def dimensions(self, obj):
        if not obj.width or not obj.height:
            return "-"
        return f"{obj.width}x{obj.height}"

    def changelist_view(self, request, extra_context=None):
        """Add the stored-byte total -- the number that makes the savings visible."""
        response = super().changelist_view(request, extra_context=extra_context)

        context = getattr(response, "context_data", None)
        if not context or "cl" not in context:
            return response

        total = context["cl"].queryset.aggregate(total=Sum("byte_size"))["total"] or 0
        context["total_byte_size"] = total
        context["total_byte_size_display"] = filesizeformat(total)
        return response


class UserSettingsInline(admin.StackedInline):
    """Inline admin for UserSettings displayed in User admin."""

    model = UserSettings
    form = UserSettingsAdminForm
    can_delete = False
    verbose_name = "API Settings"
    verbose_name_plural = "API Settings"
    fk_name = "user"

    fieldsets = (
        (
            "Reddit API",
            {
                "fields": (
                    "reddit_enabled",
                    "reddit_client_id",
                    "reddit_client_secret",
                    "reddit_user_agent",
                ),
                "classes": ("collapse",),
            },
        ),
        (
            "YouTube API",
            {"fields": ("youtube_enabled", "youtube_api_key"), "classes": ("collapse",)},
        ),
        (
            "AI Settings",
            {
                "fields": ("active_ai_provider",),
            },
        ),
        (
            "AI General Settings",
            {
                "fields": (
                    "ai_temperature",
                    "ai_max_tokens",
                    "ai_default_daily_limit",
                    "ai_default_monthly_limit",
                    "ai_max_prompt_length",
                    "ai_request_timeout",
                    "ai_max_retries",
                    "ai_retry_delay",
                    "ai_request_delay",
                ),
                "classes": ("collapse",),
            },
        ),
        (
            "OpenAI",
            {
                "fields": (
                    "openai_enabled",
                    "openai_api_url",
                    "openai_api_key",
                    "openai_model",
                ),
                "classes": ("collapse",),
            },
        ),
        (
            "Anthropic",
            {
                "fields": (
                    "anthropic_enabled",
                    "anthropic_api_key",
                    "anthropic_model",
                ),
                "classes": ("collapse",),
            },
        ),
        (
            "Gemini",
            {
                "fields": (
                    "gemini_enabled",
                    "gemini_api_key",
                    "gemini_model",
                ),
                "classes": ("collapse",),
            },
        ),
    )


# Unregister the default User admin and register with inline
admin.site.unregister(User)


@admin.register(User)
class UserAdmin(YanaDjangoQLMixin, ImportExportMixin, BaseUserAdmin):
    """Custom User admin with UserSettings inline."""

    search_fields = BaseUserAdmin.search_fields
    inlines = [UserSettingsInline]


# Unregister default Group admin and register with DjangoQL
admin.site.unregister(Group)


@admin.register(Group)
class GroupAdmin(YanaDjangoQLMixin, BaseGroupAdmin):
    """Custom Group admin with DjangoQL support."""

    search_fields = BaseGroupAdmin.search_fields


# Unregister default Django Q2 admins and register with DjangoQL
for model in [Schedule, Task, Failure, OrmQ]:
    with contextlib.suppress(NotRegistered):
        admin.site.unregister(model)


@admin.register(Schedule)
class ScheduleAdmin(YanaDjangoQLMixin, BaseScheduleAdmin):
    """Custom Schedule admin with DjangoQL support."""

    search_fields = BaseScheduleAdmin.search_fields


@admin.register(Task)
class TaskAdmin(YanaDjangoQLMixin, BaseTaskAdmin):
    """Custom Task admin with DjangoQL support."""

    search_fields = BaseTaskAdmin.search_fields


@admin.register(Failure)
class FailAdmin(YanaDjangoQLMixin, BaseFailAdmin):
    """Custom Failure admin with DjangoQL support."""

    search_fields = BaseFailAdmin.search_fields


@admin.register(OrmQ)
class QueueAdmin(YanaDjangoQLMixin, BaseQueueAdmin):
    """Custom Queue admin with DjangoQL support."""

    pass
