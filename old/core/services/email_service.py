"""
Email service for sending emails via Django's email backend.

This service provides utilities for sending various types of emails including
error notifications, system alerts, and generic messages.
"""

import logging
import traceback
from typing import Optional

from django.conf import settings
from django.core.mail import EmailMessage, mail_admins, send_mail

logger = logging.getLogger(__name__)


class EmailService:
    """Service for handling email operations."""

    @staticmethod
    def send_email(
        subject: str,
        message: str,
        recipient_list: list[str],
        from_email: Optional[str] = None,
        html_message: Optional[str] = None,
        fail_silently: bool = False,
    ) -> int:
        """
        Send an email to a list of recipients.

        Args:
            subject: Email subject line
            message: Plain text email body
            recipient_list: List of recipient email addresses
            from_email: Sender email address (defaults to DEFAULT_FROM_EMAIL)
            html_message: Optional HTML version of the email
            fail_silently: If False, raise exceptions on error

        Returns:
            Number of successfully sent emails
        """
        if not recipient_list:
            logger.warning("No recipients provided for email")
            return 0

        from_email = from_email or settings.DEFAULT_FROM_EMAIL

        try:
            count = send_mail(
                subject=subject,
                message=message,
                from_email=from_email,
                recipient_list=recipient_list,
                html_message=html_message,
                fail_silently=fail_silently,
            )
            logger.info(f"Sent email to {len(recipient_list)} recipients: {subject}")
            return count
        except Exception as e:
            logger.error(f"Failed to send email: {e}")
            if not fail_silently:
                raise
            return 0

    @staticmethod
    def send_email_with_attachments(
        subject: str,
        body: str,
        recipient_list: list[str],
        from_email: Optional[str] = None,
        attachments: Optional[list[tuple[str, bytes, str]]] = None,
        fail_silently: bool = False,
    ) -> bool:
        """
        Send an email with attachments.

        Args:
            subject: Email subject line
            body: Email body text
            recipient_list: List of recipient email addresses
            from_email: Sender email address (defaults to DEFAULT_FROM_EMAIL)
            attachments: List of (filename, content, mimetype) tuples
            fail_silently: If False, raise exceptions on error

        Returns:
            True if email was sent successfully
        """
        if not recipient_list:
            logger.warning("No recipients provided for email with attachments")
            return False

        from_email = from_email or settings.DEFAULT_FROM_EMAIL

        try:
            email = EmailMessage(
                subject=subject,
                body=body,
                from_email=from_email,
                to=recipient_list,
            )

            if attachments:
                for filename, content, mimetype in attachments:
                    email.attach(filename, content, mimetype)

            email.send(fail_silently=fail_silently)
            logger.info(
                f"Sent email with attachments to {len(recipient_list)} recipients: {subject}"
            )
            return True
        except Exception as e:
            logger.error(f"Failed to send email with attachments: {e}")
            if not fail_silently:
                raise
            return False

    @staticmethod
    def send_error_email(
        error: Exception,
        context: Optional[dict] = None,
        include_traceback: bool = True,
        fail_silently: bool = True,
    ) -> bool:
        """
        Send an error notification email to admins.

        Args:
            error: The exception that occurred
            context: Optional dictionary with additional context information
            include_traceback: Whether to include the full traceback
            fail_silently: If False, raise exceptions on error

        Returns:
            True if email was sent successfully
        """
        if not settings.ADMINS:
            logger.warning("No admins configured to receive error emails")
            return False

        try:
            # Build error message
            error_type = type(error).__name__
            error_msg = str(error)

            message_parts = [
                f"Error Type: {error_type}",
                f"Error Message: {error_msg}",
                "",
            ]

            # Add context if provided
            if context:
                message_parts.append("Context:")
                for key, value in context.items():
                    message_parts.append(f"  {key}: {value}")
                message_parts.append("")

            # Add traceback if requested
            if include_traceback:
                message_parts.append("Traceback:")
                message_parts.append(traceback.format_exc())

            message = "\n".join(message_parts)

            # Send to admins
            mail_admins(
                subject=f"[Yana Error] {error_type}: {error_msg[:50]}",
                message=message,
                fail_silently=fail_silently,
            )

            logger.info(f"Sent error email to admins: {error_type}")
            return True
        except Exception as e:
            logger.error(f"Failed to send error email: {e}")
            if not fail_silently:
                raise
            return False

    @staticmethod
    def send_notification_email(
        subject: str,
        message: str,
        fail_silently: bool = True,
    ) -> bool:
        """
        Send a notification email to admins.

        Args:
            subject: Email subject line
            message: Email body text
            fail_silently: If False, raise exceptions on error

        Returns:
            True if email was sent successfully
        """
        if not settings.ADMINS:
            logger.warning("No admins configured to receive notification emails")
            return False

        try:
            mail_admins(
                subject=f"[Yana] {subject}",
                message=message,
                fail_silently=fail_silently,
            )
            logger.info(f"Sent notification email to admins: {subject}")
            return True
        except Exception as e:
            logger.error(f"Failed to send notification email: {e}")
            if not fail_silently:
                raise
            return False
