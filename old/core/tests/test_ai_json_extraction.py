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
def test_ai_response_with_fluff_and_payload_check():
    user = User.objects.create_user(username="testuser_fluff", password="password")
    UserSettings.objects.create(
        user=user,
        active_ai_provider="gemini",
        gemini_enabled=True,
        gemini_api_key="test-key",
        gemini_model="gemini-1.5-flash",
    )
    feed = Feed.objects.create(name="Test Feed", user=user, options={"ai_summarize": True})
    aggregator = TestAggregator(feed)

    # We mock requests.post to check the payload sent by AIClient
    with patch("core.ai_client.requests.post") as mock_post:
        # Setup successful response
        mock_response = MagicMock()
        # Mocking the Gemini response structure
        mock_response.json.return_value = {
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {
                                "text": """
                Wait, here is the JSON:
                ```json
                {
                    "title": "Clean Title",
                    "content": "Clean Content"
                }
                ```
                """
                            }
                        ]
                    }
                }
            ]
        }
        mock_post.return_value = mock_response

        article = {"name": "Old", "content": "Old content", "identifier": "1"}
        results = aggregator._apply_ai_processing([article])

        # Verify extraction worked (Robustness check)
        assert len(results) == 1
        assert results[0]["name"] == "Clean Title"
        assert results[0]["content"] == "Clean Content"

        # Verify payload (API Correctness check)
        args, kwargs = mock_post.call_args
        # args[0] is url
        assert "generativelanguage.googleapis.com" in args[0]

        data = kwargs["json"]
        # Check generationConfig
        config = data.get("generationConfig", {})
        assert config.get("responseMimeType") == "application/json"

        # Check that we are using responseSchema (not responseJsonSchema) and uppercase types
        assert "responseSchema" in config
        assert "responseJsonSchema" not in config
        assert config["responseSchema"]["type"] == "OBJECT"
        assert config["responseSchema"]["properties"]["title"]["type"] == "STRING"
        assert config["responseSchema"]["properties"]["content"]["type"] == "STRING"
