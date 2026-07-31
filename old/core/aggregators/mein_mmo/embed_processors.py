"""Embed processing strategies for Mein-MMO content."""

import logging
import re
from abc import ABC, abstractmethod
from typing import List, Optional

from bs4 import BeautifulSoup, Tag

from ..utils import get_attr_str
from ..utils.bluesky import build_bluesky_embed_html, is_bluesky_url
from ..utils.youtube import build_youtube_facade_html


class EmbedProcessorStrategy(ABC):
    """Base class for embed processing strategies."""

    @abstractmethod
    def can_handle(self, figure: Tag) -> bool:
        """Check if this strategy can handle the figure."""
        pass

    @abstractmethod
    def process(self, figure: Tag, soup: BeautifulSoup, logger: logging.Logger) -> Optional[Tag]:
        """
        Process the figure and return replacement element.

        Returns:
            Replacement element or None if figure should be removed
        """
        pass


class YouTubeEmbedProcessor(EmbedProcessorStrategy):
    """Process YouTube embed figures."""

    def can_handle(self, figure: Tag) -> bool:
        class_str = get_attr_str(figure, "class")

        # Check data-sanitized-class too (after sanitization)
        sanitized_class = get_attr_str(figure, "data-sanitized-class")

        return any(
            keyword in class_str or keyword in sanitized_class
            for keyword in ["wp-block-embed-youtube", "is-provider-youtube", "embed-youtube"]
        )

    def process(self, figure: Tag, soup: BeautifulSoup, logger: logging.Logger) -> Optional[Tag]:
        # Extract video ID
        video_id = self._extract_video_id(figure)

        if not video_id:
            return None

        # Wrap in div. There is no iframe -- see build_youtube_facade_html for
        # why -- so the facade's own markup (data-embed + watch-link anchor) is
        # parsed into the wrapper directly rather than built by hand here.
        wrapper = soup.new_tag("div")
        wrapper["data-sanitized-class"] = "youtube-embed"
        fragment = BeautifulSoup(build_youtube_facade_html(video_id), "html.parser")
        facade = fragment.find("div")
        assert isinstance(facade, Tag)  # build_youtube_facade_html always yields one
        wrapper["data-embed"] = facade["data-embed"]
        for child in list(facade.children):
            wrapper.append(child)

        # Add caption if present
        figcaption = figure.find("figcaption")
        if figcaption:
            caption = soup.new_tag("p")
            caption.string = figcaption.get_text(strip=True)
            wrapper.append(caption)

        logger.debug(f"Converted YouTube embed to a facade: {video_id}")
        return wrapper

    def _extract_video_id(self, figure: Tag) -> Optional[str]:
        """Extract YouTube video ID from figure."""
        # Try data attributes
        embed_content = get_attr_str(figure, "data-sanitized-data-embed-content")
        if embed_content:
            match = re.search(
                r"(?:youtube\.com/embed/|youtube-nocookie\.com/embed/)([a-zA-Z0-9_-]{11})",
                embed_content,
            )
            if match:
                return match.group(1)

        # Try links
        for link in figure.find_all("a", href=True):
            href = get_attr_str(link, "href")
            # Standard YouTube URL
            match = re.search(r"(?:youtube\.com/watch\?v=|youtu\.be/)([a-zA-Z0-9_-]{11})", href)
            if match:
                return match.group(1)

        return None


class TwitterEmbedProcessor(EmbedProcessorStrategy):
    """Process Twitter/X embed figures."""

    def can_handle(self, figure: Tag) -> bool:
        # Look for Twitter links
        for link in figure.find_all("a", href=True):
            if "twitter.com" in link["href"] or "x.com" in link["href"]:
                return True
        return False

    def process(self, figure: Tag, soup: BeautifulSoup, logger: logging.Logger) -> Optional[Tag]:
        # Find Twitter link
        twitter_link = None
        for link in figure.find_all("a", href=True):
            href = get_attr_str(link, "href")
            if "twitter.com" in href or "x.com" in href:
                twitter_link = href
                break

        if not twitter_link:
            return None

        # Clean URL (remove tracking parameters)
        clean_url = twitter_link.split("?")[0]

        # Create replacement paragraph
        p = soup.new_tag("p")
        a = soup.new_tag("a", href=clean_url, target="_blank", rel="noopener")
        a.string = f"View on X/Twitter: {clean_url}"
        p.append(a)

        # Add caption if present
        figcaption = figure.find("figcaption")
        if figcaption:
            p.append(soup.new_tag("br"))
            em = soup.new_tag("em")
            em.string = figcaption.get_text(strip=True)
            p.append(em)

        logger.debug(f"Converted Twitter embed to link: {clean_url}")
        return p


class RedditEmbedProcessor(EmbedProcessorStrategy):
    """Process Reddit embed figures."""

    def can_handle(self, figure: Tag) -> bool:
        class_str = get_attr_str(figure, "class")

        # Check data-sanitized-class too
        sanitized_class = get_attr_str(figure, "data-sanitized-class")

        return (
            "provider-reddit" in class_str
            or "embed-reddit" in class_str
            or "provider-reddit" in sanitized_class
        )

    def process(self, figure: Tag, soup: BeautifulSoup, logger: logging.Logger) -> Optional[Tag]:
        # Find Reddit link
        reddit_link = None
        for link in figure.find_all("a", href=True):
            href = get_attr_str(link, "href")
            if "reddit.com" in href:
                reddit_link = href
                break

        if not reddit_link:
            return None

        # Clean URL
        clean_url = reddit_link.split("?")[0]

        # Create replacement paragraph
        p = soup.new_tag("p")

        # Try to find image
        img_tag = figure.find("img")
        if img_tag:
            img_src = get_attr_str(img_tag, "src") or get_attr_str(img_tag, "data-src")
            if img_src:
                # Image link
                img_link = soup.new_tag("a", href=clean_url, target="_blank", rel="noopener")
                new_img = soup.new_tag("img", src=img_src, alt="Reddit post")
                new_img["style"] = "max-width: 100%; height: auto;"
                img_link.append(new_img)
                p.append(img_link)
                p.append(soup.new_tag("br"))

        # Text link
        a = soup.new_tag("a", href=clean_url, target="_blank", rel="noopener")
        a.string = "View on Reddit"
        p.append(a)

        logger.debug(f"Converted Reddit embed to link: {clean_url}")
        return p


class BlueskyEmbedProcessor(EmbedProcessorStrategy):
    """Process Bluesky embed figures."""

    def can_handle(self, figure: Tag) -> bool:
        # Look for Bluesky links
        for link in figure.find_all("a", href=True):
            if is_bluesky_url(get_attr_str(link, "href")):
                return True
        return False

    def process(self, figure: Tag, soup: BeautifulSoup, logger: logging.Logger) -> Optional[Tag]:
        # Find the Bluesky post link
        bluesky_link = None
        for link in figure.find_all("a", href=True):
            href = get_attr_str(link, "href")
            if is_bluesky_url(href):
                bluesky_link = href
                break

        if not bluesky_link:
            return None

        # Build a rich embed via the public Bluesky API
        embed_html = build_bluesky_embed_html(bluesky_link)
        if not embed_html:
            logger.debug(f"Could not build Bluesky embed for {bluesky_link}")
            return None

        # Parse the embed HTML into a wrapper element
        fragment = BeautifulSoup(embed_html, "html.parser")
        wrapper = soup.new_tag("div")
        wrapper["data-sanitized-class"] = "bluesky-embed"
        for child in list(fragment.children):
            wrapper.append(child)

        logger.debug(f"Converted Bluesky embed: {bluesky_link}")
        return wrapper


class TikTokEmbedProcessor(EmbedProcessorStrategy):
    """Process TikTok embed figures."""

    TIKTOK_EMBED_URL = "https://www.tiktok.com/embed/v3/"

    def can_handle(self, figure: Tag) -> bool:
        class_str = get_attr_str(figure, "class")
        sanitized_class = get_attr_str(figure, "data-sanitized-class")

        return any(
            keyword in class_str or keyword in sanitized_class
            for keyword in ["wp-block-embed-tiktok", "is-provider-tiktok", "embed-tiktok"]
        )

    def process(self, figure: Tag, soup: BeautifulSoup, logger: logging.Logger) -> Optional[Tag]:
        # Extract video ID from TikTok link
        video_id = self._extract_video_id(figure)

        if not video_id:
            return None

        # Create iframe embed
        iframe = soup.new_tag(
            "iframe",
            src=f"{self.TIKTOK_EMBED_URL}{video_id}",
            width="325",
            height="605",
            frameborder="0",
            allow="autoplay; encrypted-media",
            allowfullscreen="true",
        )

        # Wrap in div
        wrapper = soup.new_tag("div")
        wrapper["data-sanitized-class"] = "tiktok-embed"
        wrapper.append(iframe)

        # Add caption if present
        figcaption = figure.find("figcaption")
        if figcaption:
            caption = soup.new_tag("p")
            caption.string = figcaption.get_text(strip=True)
            wrapper.append(caption)

        logger.debug(f"Converted TikTok embed to iframe: {video_id}")
        return wrapper

    def _extract_video_id(self, figure: Tag) -> Optional[str]:
        """Extract TikTok video ID from figure."""
        for link in figure.find_all("a", href=True):
            href = get_attr_str(link, "href")
            if "tiktok.com" in href:
                match = re.search(r"/video/(\d+)", href)
                if match:
                    return match.group(1)
        return None


class YouTubeFallbackProcessor(EmbedProcessorStrategy):
    """Fallback processor for YouTube links without specific class markers."""

    def can_handle(self, figure: Tag) -> bool:
        """Check if figure contains any YouTube links."""
        for link in figure.find_all("a", href=True):
            href = get_attr_str(link, "href")
            if "youtube.com" in href or "youtu.be" in href:
                return True
        return False

    def process(self, figure: Tag, soup: BeautifulSoup, logger: logging.Logger) -> Optional[Tag]:
        """Extract video ID from YouTube link and create iframe."""
        # Find YouTube link
        video_id = None
        for link in figure.find_all("a", href=True):
            href = get_attr_str(link, "href")
            if "youtube.com" in href or "youtu.be" in href:
                video_id = self._extract_video_id(href)
                if video_id:
                    break

        if not video_id:
            logger.debug("No YouTube video ID extracted from link")
            return None

        # Wrap in div. There is no iframe -- see build_youtube_facade_html for
        # why -- so the facade's own markup (data-embed + watch-link anchor) is
        # parsed into the wrapper directly rather than built by hand here.
        wrapper = soup.new_tag("div")
        wrapper["data-sanitized-class"] = "youtube-embed"
        fragment = BeautifulSoup(build_youtube_facade_html(video_id), "html.parser")
        facade = fragment.find("div")
        assert isinstance(facade, Tag)  # build_youtube_facade_html always yields one
        wrapper["data-embed"] = facade["data-embed"]
        for child in list(facade.children):
            wrapper.append(child)

        # Add caption if present
        figcaption = figure.find("figcaption")
        if figcaption:
            caption = soup.new_tag("p")
            caption.string = figcaption.get_text(strip=True)
            wrapper.append(caption)

        logger.debug(f"Converted YouTube link to a facade (fallback): {video_id}")
        return wrapper

    def _extract_video_id(self, url: str) -> Optional[str]:
        """Extract YouTube video ID from URL."""
        # Pattern: youtube.com/watch?v=ID or youtu.be/ID or youtube.com/embed/ID
        match = re.search(
            r"(?:youtube\.com/(?:watch\?v=|embed/)|youtu\.be/)([a-zA-Z0-9_-]{11})", url
        )
        if match:
            return match.group(1)
        return None


def process_embeds(content: Tag, logger: logging.Logger) -> None:
    """
    Process all figure embeds using strategy pattern.

    Args:
        content: BeautifulSoup Tag containing article content
        logger: Logger instance
    """
    processors: List[EmbedProcessorStrategy] = [
        YouTubeEmbedProcessor(),
        TwitterEmbedProcessor(),
        RedditEmbedProcessor(),
        BlueskyEmbedProcessor(),
        TikTokEmbedProcessor(),
        YouTubeFallbackProcessor(),  # Fallback for YouTube links
    ]

    # Find all figures
    figures = content.find_all("figure")
    logger.debug(f"Processing {len(figures)} figure elements")

    # Get the parent soup to create new tags
    soup = content.find_parent()
    if not soup:
        # Fallback if content has no parent
        soup = BeautifulSoup("", "html.parser")
    elif not isinstance(soup, BeautifulSoup):
        # Traverse up to find BeautifulSoup
        curr = content
        while curr.parent:
            curr = curr.parent
        soup = curr if isinstance(curr, BeautifulSoup) else BeautifulSoup("", "html.parser")

    for idx, figure in enumerate(figures, 1):
        # Try each processor
        for processor in processors:
            if processor.can_handle(figure):
                logger.debug(f"Figure {idx}: Using {processor.__class__.__name__}")
                replacement = processor.process(figure, soup, logger)
                if replacement:
                    figure.replace_with(replacement)
                    logger.debug(f"Figure {idx}: Successfully processed")
                else:
                    logger.debug(f"Figure {idx}: Processing returned None, removing figure")
                    figure.decompose()
                break
        else:
            # If no processor handled it, leave figure as-is
            logger.debug(f"Figure {idx}: No processor matched, keeping as-is")
