import json
from unittest.mock import MagicMock, patch

from django.contrib.auth.models import User

import pytest

from core.aggregators.base import BaseAggregator
from core.models import Feed, UserSettings


# Concrete implementation for testing
class TestAggregator(BaseAggregator):
    def fetch_source_data(self, limit=None):
        return []

    def parse_to_raw_articles(self, source_data):
        return []

    def aggregate(self):
        return []


@pytest.mark.django_db
class TestAIProcessing:
    @pytest.fixture
    def user(self):
        return User.objects.create_user(username="testuser", password="password")

    @pytest.fixture
    def user_settings(self, user):
        settings = UserSettings.objects.create(
            user=user,
            active_ai_provider="openai",
            openai_enabled=True,
            openai_api_key="sk-test",
            openai_model="gpt-4o-mini",
        )
        return settings

    @pytest.fixture
    def feed(self, user):
        return Feed.objects.create(
            name="Test Feed",
            identifier="http://example.com/feed",
            user=user,
            options={"ai_translate": True, "ai_translate_language": "German"},
        )

    @pytest.fixture
    def aggregator(self, feed):
        return TestAggregator(feed)

    @patch("core.aggregators.base.AIClient")
    def test_ai_translation_title_and_content(self, mock_ai_client_cls, aggregator, user_settings):
        # Setup mock
        mock_ai_instance = MagicMock()
        mock_ai_client_cls.return_value = mock_ai_instance

        # expected JSON response
        ai_response = json.dumps(
            {"title": "Übersetzter Titel", "content": "<p>Übersetzter Inhalt</p>"}
        )
        mock_ai_instance.generate_response.return_value = ai_response

        # Article to process
        article = {
            "name": "Original Title",
            "content": "<p>Original Content</p>",
            "identifier": "http://example.com/1",
        }

        # Run processing
        results = aggregator._apply_ai_processing([article])

        # Assertions
        assert len(results) == 1
        processed_article = results[0]

        # Verify prompt structure (should contain JSON instructions in the new implementation)
        # For now, we just check if it updated correctly.
        # Since we haven't implemented the fix yet, this is expected to fail or behave unexpectedly
        # (e.g., content might become the JSON string, title unchanged)

        assert processed_article["name"] == "Übersetzter Titel"
        assert processed_article["content"] == "<p>Übersetzter Inhalt</p>"

    @patch("core.aggregators.base.AIClient")
    def test_ai_processing_json_failure(self, mock_ai_client_cls, aggregator, user_settings):
        # Setup mock
        mock_ai_instance = MagicMock()
        mock_ai_client_cls.return_value = mock_ai_instance

        # Invalid JSON response
        mock_ai_instance.generate_response.return_value = "Not valid JSON"

        article = {
            "name": "Original Title",
            "content": "<p>Original Content</p>",
            "identifier": "http://example.com/1",
        }

        # Run processing
        results = aggregator._apply_ai_processing([article])

        # Assertions - should skip update or fallback
        # The implementation skips the article if AI processing fails (including JSON errors)
        assert len(results) == 0

    @patch("core.aggregators.base.AIClient")
    def test_ai_improvement_preserves_links(self, mock_ai_client_cls, user_settings):
        """Test that AI improvement preserves HTML links"""
        # Create feed with AI improvement enabled
        feed = Feed.objects.create(
            name="Test Feed",
            identifier="http://example.com/feed",
            user=user_settings.user,
            options={"ai_improve_writing": True},
        )
        aggregator = TestAggregator(feed)

        # Setup mock
        mock_ai_instance = MagicMock()
        mock_ai_client_cls.return_value = mock_ai_instance

        # AI response with preserved links
        ai_response = json.dumps(
            {
                "title": "Improved Title",
                "content": '<p>This is improved text with <a href="https://example.com">a link</a> preserved.</p>',
            }
        )
        mock_ai_instance.generate_response.return_value = ai_response

        # Article with links
        article = {
            "name": "Original Title",
            "content": '<p>This is text with <a href="https://example.com">a link</a> here.</p>',
            "identifier": "http://example.com/1",
        }

        # Run processing
        results = aggregator._apply_ai_processing([article])

        # Verify link is preserved
        assert len(results) == 1
        assert '<a href="https://example.com">' in results[0]["content"]
        assert "a link" in results[0]["content"]

        # Verify prompt contains preservation instructions
        call_args = mock_ai_instance.generate_response.call_args
        prompt = call_args[0][0]
        assert "Preserve the complete HTML structure" in prompt
        assert "Keep all links" in prompt

    @patch("core.aggregators.base.AIClient")
    def test_ai_translation_preserves_link_labels(self, mock_ai_client_cls, user_settings):
        """Test that AI translation does not translate link labels"""
        # Create feed with AI translation enabled
        feed = Feed.objects.create(
            name="Test Feed",
            identifier="http://example.com/feed",
            user=user_settings.user,
            options={"ai_translate": True, "ai_translate_language": "German"},
        )
        aggregator = TestAggregator(feed)

        # Setup mock
        mock_ai_instance = MagicMock()
        mock_ai_client_cls.return_value = mock_ai_instance

        # AI response with link labels in original language
        ai_response = json.dumps(
            {
                "title": "Übersetzter Titel",
                "content": '<p>Dies ist übersetzter Text mit <a href="https://example.com">Read More</a> hier.</p>',
            }
        )
        mock_ai_instance.generate_response.return_value = ai_response

        # Article with English link label
        article = {
            "name": "Original Title",
            "content": '<p>This is text with <a href="https://example.com">Read More</a> here.</p>',
            "identifier": "http://example.com/1",
        }

        # Run processing
        results = aggregator._apply_ai_processing([article])

        # Verify link label stays in original language
        assert len(results) == 1
        assert "Read More" in results[0]["content"]

        # Verify prompt contains instruction not to translate links
        call_args = mock_ai_instance.generate_response.call_args
        prompt = call_args[0][0]
        assert "Do NOT translate link labels" in prompt
        assert "Keep link text in the original language" in prompt

    @patch("core.aggregators.base.AIClient")
    def test_ai_preserves_complex_html_structure(self, mock_ai_client_cls, user_settings):
        """Test that AI processing preserves complex HTML structure"""
        # Create feed with AI improvement enabled
        feed = Feed.objects.create(
            name="Test Feed",
            identifier="http://example.com/feed",
            user=user_settings.user,
            options={"ai_improve_writing": True},
        )
        aggregator = TestAggregator(feed)

        # Setup mock
        mock_ai_instance = MagicMock()
        mock_ai_client_cls.return_value = mock_ai_instance

        # Complex HTML with various elements
        complex_html = """
        <div>
            <h1>Heading</h1>
            <p>Paragraph with <a href="https://example.com">link</a>.</p>
            <ul>
                <li>List item 1</li>
                <li>List item 2</li>
            </ul>
            <img src="image.jpg" alt="Image">
        </div>
        """

        # AI response preserving structure
        ai_response = json.dumps(
            {
                "title": "Improved Title",
                "content": complex_html.strip(),
            }
        )
        mock_ai_instance.generate_response.return_value = ai_response

        article = {
            "name": "Original Title",
            "content": complex_html,
            "identifier": "http://example.com/1",
        }

        # Run processing
        results = aggregator._apply_ai_processing([article])

        # Verify all HTML elements are preserved
        assert len(results) == 1
        content = results[0]["content"]
        assert "<h1>" in content
        assert "<ul>" in content
        assert "<li>" in content
        assert "<img" in content
        assert '<a href="https://example.com">' in content

        # Verify prompt mentions HTML preservation
        call_args = mock_ai_instance.generate_response.call_args
        prompt = call_args[0][0]
        assert "Preserve ALL HTML tags" in prompt
