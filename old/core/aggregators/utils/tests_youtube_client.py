import unittest
from unittest.mock import MagicMock, patch

from core.aggregators.utils.youtube_client import YouTubeClient


class TestYouTubeClient(unittest.TestCase):
    def setUp(self):
        self.api_key = "test_api_key"
        self.client = YouTubeClient(self.api_key)

    @patch("requests.get")
    def test_resolve_channel_id_from_uc_id(self, mock_get):
        # Mock successful channel lookup
        uc_id = "UC12345678901234567890123"
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"items": [{"id": uc_id}]}
        mock_get.return_value = mock_response

        channel_id, error = self.client.resolve_channel_id(uc_id)

        self.assertEqual(channel_id, uc_id)
        self.assertIsNone(error)
        mock_get.assert_called_once()

    @patch("requests.get")
    def test_resolve_channel_id_from_handle(self, mock_get):
        # 1. Mock search response
        search_response = MagicMock()
        search_response.status_code = 200
        search_response.json.return_value = {
            "items": [
                {
                    "id": {"channelId": "UC_MKBHD"},
                    "snippet": {"title": "MKBHD"},
                }
            ]
        }

        # 2. Mock channels response
        channels_response = MagicMock()
        channels_response.status_code = 200
        channels_response.json.return_value = {
            "items": [
                {
                    "id": "UC_MKBHD",
                    "snippet": {"customUrl": "@mkbhd", "title": "MKBHD"},
                }
            ]
        }

        mock_get.side_effect = [search_response, channels_response]

        channel_id, error = self.client.resolve_channel_id("@mkbhd")

        self.assertEqual(channel_id, "UC_MKBHD")
        self.assertIsNone(error)
        self.assertEqual(mock_get.call_count, 2)

    @patch("requests.get")
    def test_fetch_channel_data(self, mock_get):
        # Mock channels.list response
        uc_id = "UC12345678901234567890123"
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "items": [
                {
                    "id": uc_id,
                    "contentDetails": {"relatedPlaylists": {"uploads": "UU123"}},
                    "snippet": {"thumbnails": {"high": {"url": "https://icon.url"}}},
                }
            ]
        }
        mock_get.return_value = mock_response

        # Mock playlistItems.list and videos.list would be next,
        # but let's just test the basic structure for now

        data = self.client.fetch_channel_data(uc_id)
        self.assertEqual(data["channel_icon_url"], "https://icon.url")
        self.assertEqual(data["uploads_playlist_id"], "UU123")

    @patch("requests.get")
    def test_fetch_video_details(self, mock_get):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "items": [
                {"id": "vid1", "snippet": {"title": "Video 1"}},
                {"id": "vid2", "snippet": {"title": "Video 2"}},
            ]
        }
        mock_get.return_value = mock_response

        videos = self.client.fetch_video_details(["vid1", "vid2"])
        self.assertEqual(len(videos), 2)
        self.assertEqual(videos[0]["id"], "vid1")
        self.assertEqual(videos[1]["snippet"]["title"], "Video 2")

    @patch("requests.get")
    def test_fetch_video_comments(self, mock_get):
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "items": [
                {
                    "id": "c1",
                    "snippet": {"topLevelComment": {"snippet": {"textDisplay": "Great video!"}}},
                }
            ]
        }
        mock_get.return_value = mock_response

        comments = self.client.fetch_video_comments("vid1", max_results=5)
        self.assertEqual(len(comments), 1)
        self.assertEqual(comments[0]["id"], "c1")
        self.assertEqual(
            comments[0]["snippet"]["topLevelComment"]["snippet"]["textDisplay"], "Great video!"
        )
