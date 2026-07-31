import logging
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

import requests

logger = logging.getLogger(__name__)


class YouTubeAPIError(Exception):
    """Exception raised for YouTube API errors."""

    def __init__(self, message: str, original_error: Optional[Exception] = None):
        super().__init__(message)
        self.original_error = original_error


class YouTubeClient:
    """
    YouTube API client for interacting with YouTube Data API v3.
    """

    BASE_URL = "https://www.googleapis.com/youtube/v3"

    def __init__(self, api_key: str):
        if not api_key:
            raise YouTubeAPIError("YouTube API key is required")
        self.api_key = api_key

    def _get(self, endpoint: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a GET request to the YouTube API."""
        url = f"{self.BASE_URL}/{endpoint}"
        params["key"] = self.api_key

        try:
            response = requests.get(url, params=params, timeout=10)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.RequestException as e:
            logger.error(f"YouTube API error at {endpoint}: {str(e)}")
            raise YouTubeAPIError(f"YouTube API request failed: {str(e)}", e) from e

    def resolve_channel_id(self, identifier: str) -> Tuple[Optional[str], Optional[str]]:
        """
        Resolve a YouTube channel identifier (handle, ID, or URL) to a canonical Channel ID.

        Returns:
            Tuple of (channel_id, error_message)
        """
        iden = identifier.strip()
        if not iden:
            return None, "Channel identifier is required"

        # 1. Existing ID (UC...)
        if iden.startswith("UC") and len(iden) >= 24:
            if self._validate_channel_id(iden):
                return iden, None
            return None, f"Channel ID not found: {iden}"

        # 2. URL extraction
        handle = None
        if "youtube.com" in iden or "youtu.be" in iden:
            extracted = self._extract_from_url(iden)
            if extracted.get("channel_id"):
                # Recursive call to validate the extracted ID
                return self.resolve_channel_id(extracted["channel_id"])
            handle = extracted.get("handle")
        else:
            handle = iden.lstrip("@")

        # 3. Resolve handle
        if handle:
            # Try search.list first (most reliable for handles)
            channel_id = self._resolve_via_search(handle)
            if channel_id:
                return channel_id, None

            # Fallback to forUsername (legacy handles)
            channel_id = self._resolve_via_username(handle)
            if channel_id:
                return channel_id, None

            return None, f"Channel handle not found: @{handle}"

        return None, "Could not parse channel identifier"

    def _validate_channel_id(self, channel_id: str) -> bool:
        """Check if a channel ID exists."""
        try:
            data = self._get("channels", {"part": "id", "id": channel_id})
            return len(data.get("items", [])) > 0
        except YouTubeAPIError:
            return False

    def _extract_from_url(self, url: str) -> Dict[str, str]:
        """Extract handle or channel ID from a YouTube URL."""
        if not url.startswith("http"):
            url = "https://" + url

        try:
            parsed = urlparse(url)
            path = parsed.path.lstrip("/")

            if path.startswith("@"):
                return {"handle": path.split("/")[0][1:]}
            if path.startswith("c/") or path.startswith("user/"):
                return {"handle": path.split("/")[1]}
            if path.startswith("channel/"):
                return {"channel_id": path.split("/")[1]}

            # Check for channel_id query param
            qs = parse_qs(parsed.query)
            if "channel_id" in qs:
                return {"channel_id": qs["channel_id"][0]}

            return {}
        except Exception:
            return {}

    def _resolve_via_search(self, handle: str) -> Optional[str]:
        """Resolve handle to channel ID using search.list."""
        q = handle if handle.startswith("@") else f"@{handle}"
        try:
            data = self._get(
                "search", {"part": "snippet", "q": q, "type": "channel", "maxResults": 10}
            )

            items = data.get("items", [])
            if not items:
                return None

            channel_ids = [item["id"]["channelId"] for item in items]
            channels_data = self.fetch_channels_data(channel_ids)

            norm_handle = handle.lower().lstrip("@")

            # 1. Exact customUrl match
            for channel in channels_data:
                custom_url = channel.get("custom_url", "").lower().lstrip("@")
                if custom_url == norm_handle:
                    return channel["channel_id"]

            # 2. Title match
            for channel in channels_data:
                title = channel.get("title", "").lower()
                if norm_handle in title or title in norm_handle:
                    return channel["channel_id"]

            # 3. First result fallback
            return channel_ids[0]
        except YouTubeAPIError:
            return None

    def _resolve_via_username(self, handle: str) -> Optional[str]:
        """Resolve legacy username to channel ID using channels.list(forUsername)."""
        try:
            data = self._get("channels", {"part": "id", "forUsername": handle})
            items = data.get("items", [])
            if items:
                return items[0]["id"]
            return None
        except YouTubeAPIError:
            return None

    def fetch_channel_data(self, channel_id: str) -> Dict[str, Any]:
        """Fetch basic channel data including uploads playlist ID and icon."""
        channels = self.fetch_channels_data([channel_id])
        if not channels:
            raise YouTubeAPIError(f"Channel not found: {channel_id}")
        return channels[0]

    def fetch_channels_data(self, channel_ids: List[str]) -> List[Dict[str, Any]]:
        """Fetch basic data for multiple channels."""
        if not channel_ids:
            return []

        results = []
        # YouTube API allows up to 50 IDs per request
        for i in range(0, len(channel_ids), 50):
            batch = channel_ids[i : i + 50]
            data = self._get("channels", {"part": "contentDetails,snippet", "id": ",".join(batch)})

            for item in data.get("items", []):
                snippet = item.get("snippet", {})
                thumbnails = snippet.get("thumbnails", {})

                icon_url = (
                    thumbnails.get("high", {}).get("url")
                    or thumbnails.get("medium", {}).get("url")
                    or thumbnails.get("default", {}).get("url")
                )

                uploads_playlist_id = (
                    item.get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads")
                )

                custom_url = snippet.get("customUrl")
                if custom_url and not custom_url.startswith("@"):
                    custom_url = f"@{custom_url}"

                results.append(
                    {
                        "channel_id": item.get("id"),
                        "title": snippet.get("title"),
                        "custom_url": custom_url,
                        "uploads_playlist_id": uploads_playlist_id,
                        "channel_icon_url": icon_url,
                    }
                )
        return results

    def fetch_videos_from_playlist(
        self, playlist_id: str, max_results: int = 50
    ) -> List[Dict[str, Any]]:
        """Fetch videos from a playlist, then fetch full details for each."""
        videos: List[Dict[str, Any]] = []
        next_page_token: Optional[str] = None

        while len(videos) < max_results:
            params = {
                "part": "snippet,contentDetails",
                "playlistId": playlist_id,
                "maxResults": min(50, max_results - len(videos)),
            }
            if next_page_token:
                params["pageToken"] = next_page_token

            data = self._get("playlistItems", params)
            items = data.get("items", [])
            if not items:
                break

            video_ids = [item["contentDetails"]["videoId"] for item in items]
            detailed_videos = self.fetch_video_details(video_ids)
            videos.extend(detailed_videos)

            next_page_token = data.get("nextPageToken")
            if not next_page_token:
                break

        return videos[:max_results]

    def fetch_video_details(self, video_ids: List[str]) -> List[Dict[str, Any]]:
        """Fetch detailed information for a list of video IDs in batches."""
        all_videos = []
        # YouTube API allows up to 50 IDs per request
        for i in range(0, len(video_ids), 50):
            batch = video_ids[i : i + 50]
            data = self._get(
                "videos", {"part": "snippet,statistics,contentDetails", "id": ",".join(batch)}
            )
            all_videos.extend(data.get("items", []))
        return all_videos

    def fetch_video_comments(self, video_id: str, max_results: int = 10) -> List[Dict[str, Any]]:
        """Fetch top-level comments for a video."""
        if max_results <= 0:
            return []

        comments: List[Dict[str, Any]] = []
        next_page_token: Optional[str] = None

        try:
            while len(comments) < max_results:
                params = {
                    "part": "snippet",
                    "videoId": video_id,
                    "maxResults": min(100, max_results - len(comments)),
                    "order": "relevance",
                    "textFormat": "html",
                }
                if next_page_token:
                    params["pageToken"] = next_page_token

                data = self._get("commentThreads", params)
                items = data.get("items", [])
                if not items:
                    break

                for item in items:
                    snippet = item.get("snippet", {}).get("topLevelComment", {}).get("snippet", {})
                    text = snippet.get("textDisplay")

                    if text and text not in ["[deleted]", "[removed]"]:
                        comments.append(item)

                next_page_token = data.get("nextPageToken")
                if not next_page_token:
                    break
        except YouTubeAPIError as e:
            logger.warning(f"Failed to fetch comments for video {video_id}: {str(e)}")
            # Don't fail the whole video aggregation just because comments failed
            return []

        return comments[:max_results]

    def fetch_videos_via_search(
        self, channel_id: str, max_results: int = 50
    ) -> List[Dict[str, Any]]:
        """Fallback method using search.list if uploads playlist is unavailable."""
        videos: List[Dict[str, Any]] = []
        next_page_token: Optional[str] = None

        while len(videos) < max_results:
            params = {
                "part": "id",
                "channelId": channel_id,
                "type": "video",
                "order": "date",
                "maxResults": min(50, max_results - len(videos)),
            }
            if next_page_token:
                params["pageToken"] = next_page_token

            data = self._get("search", params)
            items = data.get("items", [])
            if not items:
                break

            video_ids = [item["id"]["videoId"] for item in items]
            detailed_videos = self.fetch_video_details(video_ids)
            videos.extend(detailed_videos)

            next_page_token = data.get("nextPageToken")
            if not next_page_token:
                break

        return videos[:max_results]
