"""
Management command to test email configuration.

This command sends a test email to verify SMTP settings are correctly configured.
"""

import sys

from django.conf import settings
from django.core.management.base import BaseCommand

from core.services import EmailService


class Command(BaseCommand):
    """Test email configuration by sending a test email."""

    help = "Send a test email to verify email configuration"

    def add_arguments(self, parser):
        """Add command arguments."""
        parser.add_argument(
            "recipient",
            type=str,
            nargs="?",
            help="Recipient email address (defaults to admin email)",
        )
        parser.add_argument(
            "--error",
            action="store_true",
            help="Send a test error notification email to admins",
        )
        parser.add_argument(
            "--notification",
            action="store_true",
            help="Send a test notification email to admins",
        )

    def handle(self, *args, **options):
        """Execute the command."""
        recipient = options.get("recipient")
        send_error = options.get("error", False)
        send_notification = options.get("notification", False)

        # Display current email configuration
        self.stdout.write(self.style.SUCCESS("\n=== Email Configuration ==="))
        self.stdout.write(f"Backend: {settings.EMAIL_BACKEND}")
        self.stdout.write(f"Host: {settings.EMAIL_HOST or '(not set)'}")
        self.stdout.write(f"Port: {settings.EMAIL_PORT}")
        self.stdout.write(f"Use TLS: {settings.EMAIL_USE_TLS}")
        self.stdout.write(f"Use SSL: {settings.EMAIL_USE_SSL}")
        self.stdout.write(f"Username: {settings.EMAIL_HOST_USER or '(not set)'}")
        self.stdout.write(f"Password: {'***' if settings.EMAIL_HOST_PASSWORD else '(not set)'}")
        self.stdout.write(f"Default From: {settings.DEFAULT_FROM_EMAIL}")
        self.stdout.write(f"Server Email: {settings.SERVER_EMAIL}")
        self.stdout.write(f"Admins: {settings.ADMINS or '(not set)'}\n")

        # Send error email to admins
        if send_error:
            if not settings.ADMINS:
                self.stdout.write(
                    self.style.ERROR("Error: No admins configured. Set ADMIN_EMAIL in .env file.")
                )
                sys.exit(1)

            self.stdout.write("\nSending test error email to admins...")
            try:
                test_error = ValueError("This is a test error from test_email command")
                context = {
                    "command": "test_email",
                    "user": "test_user",
                    "timestamp": "2024-01-01 12:00:00",
                }
                EmailService.send_error_email(
                    error=test_error,
                    context=context,
                    include_traceback=True,
                    fail_silently=False,
                )
                self.stdout.write(self.style.SUCCESS("✓ Error email sent successfully!"))
            except Exception as e:
                self.stdout.write(self.style.ERROR(f"✗ Failed to send error email: {e}"))
                sys.exit(1)
            return

        # Send notification email to admins
        if send_notification:
            if not settings.ADMINS:
                self.stdout.write(
                    self.style.ERROR("Error: No admins configured. Set ADMIN_EMAIL in .env file.")
                )
                sys.exit(1)

            self.stdout.write("\nSending test notification email to admins...")
            try:
                EmailService.send_notification_email(
                    subject="Test Notification",
                    message="This is a test notification from the test_email command.\n\n"
                    "If you received this email, your email configuration is working correctly!",
                    fail_silently=False,
                )
                self.stdout.write(self.style.SUCCESS("✓ Notification email sent successfully!"))
            except Exception as e:
                self.stdout.write(self.style.ERROR(f"✗ Failed to send notification email: {e}"))
                sys.exit(1)
            return

        # Send regular test email
        if not recipient:
            if settings.ADMINS:
                recipient = settings.ADMINS[0][1]
                self.stdout.write(f"\nNo recipient specified, using admin: {recipient}")
            else:
                self.stdout.write(
                    self.style.ERROR(
                        "Error: No recipient specified and no admins configured.\n"
                        "Usage: python manage.py test_email <email@example.com>\n"
                        "   Or: python manage.py test_email --error\n"
                        "   Or: python manage.py test_email --notification"
                    )
                )
                sys.exit(1)

        self.stdout.write(f"\nSending test email to: {recipient}...")
        try:
            count = EmailService.send_email(
                subject="Yana Test Email",
                message="This is a test email from Yana RSS Aggregator.\n\n"
                "If you received this email, your email configuration is working correctly!\n\n"
                f"Settings:\n"
                f"  Backend: {settings.EMAIL_BACKEND}\n"
                f"  Host: {settings.EMAIL_HOST}\n"
                f"  Port: {settings.EMAIL_PORT}\n"
                f"  TLS: {settings.EMAIL_USE_TLS}\n"
                f"  SSL: {settings.EMAIL_USE_SSL}\n"
                f"  From: {settings.DEFAULT_FROM_EMAIL}",
                recipient_list=[recipient],
                fail_silently=False,
            )
            if count > 0:
                self.stdout.write(self.style.SUCCESS("✓ Test email sent successfully!"))
            else:
                self.stdout.write(self.style.WARNING("⚠ Email backend returned 0"))
        except Exception as e:
            self.stdout.write(self.style.ERROR(f"✗ Failed to send test email: {e}"))
            import traceback

            self.stdout.write(traceback.format_exc())
            sys.exit(1)
