"""Content formatting utilities."""

from typing import Optional

from .twitter import build_tweet_embed_html, is_twitter_url
from .youtube import create_youtube_embed_html, extract_youtube_video_id


def build_header_html(
    header_image_url: Optional[str],
    title: str,
    header_caption_html: Optional[str] = None,
) -> Optional[str]:
    """
    Build the article's lead-media header, or None when none can be rendered.

    Returning None instead of "" is load-bearing: callers strip a body's
    duplicate image only once a header actually exists for it. Conflating "no
    header" with "empty header" is what made direct-image Reddit posts lose
    their only image.

    Args:
        header_image_url: Image URL (including a ``yana-img://<hash>`` reference
            into the content-addressed image store), YouTube URL, or Twitter/X URL
        title: Article title (used for image alt text)
        header_caption_html: Optional HTML to display below the header media

    Returns:
        A <header> block, or None (no URL, or an embed that could not be built)
    """
    if not header_image_url:
        return None

    youtube_video_id = extract_youtube_video_id(header_image_url)
    if youtube_video_id:
        youtube_embed = create_youtube_embed_html(youtube_video_id, header_caption_html or "")
        return "\n".join(
            [
                '<header style="margin-bottom: 1.5em; text-align: center;">',
                youtube_embed,
                "</header>",
            ]
        )

    if is_twitter_url(header_image_url):
        tweet_embed = build_tweet_embed_html(header_image_url)
        if not tweet_embed:
            return None
        return "\n".join(['<header style="margin-bottom: 1.5em;">', tweet_embed, "</header>"])

    header_parts = [
        '<header style="margin-bottom: 1.5em; text-align: center;">',
        f'<img src="{header_image_url}" alt="{title}" style="max-width: 100%; height: auto; border-radius: 8px;">',
    ]
    if header_caption_html:
        header_parts.append(header_caption_html)
    header_parts.append("</header>")
    return "\n".join(header_parts)


def format_article_content(
    content: str,
    title: str,
    url: str,
    header_image_url: Optional[str] = None,
    header_caption_html: Optional[str] = None,
    comments_content: Optional[str] = None,
    header_html: Optional[str] = None,
) -> str:
    """
    Format article content with an optional header, the main content, and optional comments.

    Note: Title, author, and date are NOT added to the content as these
    are typically handled by the RSS reader client.

    Args:
        content: Main article content HTML
        title: Article title (used for image alt text)
        url: Article URL. Retained for call-site compatibility only -- no longer
            rendered. The source link used to live in a <footer> here, which
            block conversion turned into a junk paragraph holding a bare URL at
            the end of every article. Nothing renders Article.content directly
            any more, and Article.identifier already carries the URL.
        header_image_url: Optional URL of a header image
        header_caption_html: Optional HTML to display below the header image
        comments_content: Optional HTML content for the comments section
        header_html: Pre-built header block, used verbatim when given. Callers
            that must know whether a header rendered build it themselves with
            build_header_html() and pass the result here.

    Returns:
        Formatted HTML string
    """
    parts = []

    header = (
        header_html
        if header_html is not None
        else build_header_html(header_image_url, title, header_caption_html)
    )
    if header:
        parts.append(header)

    # Main content section
    parts.append(f'<section data-sanitized-class="article-content">{content}</section>')

    # Comments section
    if comments_content:
        parts.append(
            f'<section data-sanitized-class="article-comments">{comments_content}</section>'
        )

    return "\n\n".join(parts)
