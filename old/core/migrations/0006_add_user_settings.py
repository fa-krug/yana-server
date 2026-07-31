# Generated manually

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("core", "0005_alter_article_icon"),
    ]

    operations = [
        migrations.CreateModel(
            name="UserSettings",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("reddit_enabled", models.BooleanField(default=False)),
                (
                    "reddit_client_id",
                    models.CharField(blank=True, default="", max_length=255),
                ),
                (
                    "reddit_client_secret",
                    models.CharField(blank=True, default="", max_length=255),
                ),
                (
                    "reddit_user_agent",
                    models.CharField(default="Yana/1.0", max_length=255),
                ),
                ("youtube_enabled", models.BooleanField(default=False)),
                (
                    "youtube_api_key",
                    models.CharField(blank=True, default="", max_length=255),
                ),
                ("openai_enabled", models.BooleanField(default=False)),
                (
                    "openai_api_url",
                    models.CharField(
                        default="https://api.openai.com/v1", max_length=255
                    ),
                ),
                (
                    "openai_api_key",
                    models.CharField(blank=True, default="", max_length=255),
                ),
                ("ai_model", models.CharField(default="gpt-4o-mini", max_length=100)),
                ("ai_temperature", models.FloatField(default=0.3)),
                ("ai_max_tokens", models.IntegerField(default=2000)),
                ("ai_default_daily_limit", models.IntegerField(default=200)),
                ("ai_default_monthly_limit", models.IntegerField(default=2000)),
                ("ai_max_prompt_length", models.IntegerField(default=500)),
                ("ai_request_timeout", models.IntegerField(default=120)),
                ("ai_max_retries", models.IntegerField(default=3)),
                ("ai_retry_delay", models.IntegerField(default=2)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "user",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="user_settings",
                        to=settings.AUTH_USER_MODEL,
                        unique=True,
                    ),
                ),
            ],
            options={
                "verbose_name": "User Settings",
                "verbose_name_plural": "User Settings",
            },
        ),
        migrations.AddIndex(
            model_name="usersettings",
            index=models.Index(fields=["user"], name="core_userset_user_id_idx"),
        ),
    ]
