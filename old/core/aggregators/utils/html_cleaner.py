"""HTML cleaning and sanitization utilities."""

import re
from typing import List, Optional, Union

from bs4 import BeautifulSoup, Comment, Tag

from .bs4_utils import get_attr_str


def _get_base_filename(filename: str) -> str:
    """
    Extract base filename without extension and without responsive variant suffixes.

    Handles patterns like:
    - "image-780x438.jpg" -> "image"
    - "image-1280x720-1.jpg" -> "image"
    - "image-1280x720-1-780x438.jpg" -> "image"
    - "image.jpg" -> "image"

    Args:
        filename: Full filename with extension

    Returns:
        Base filename without extension and without dimension suffixes
    """
    # Remove extension
    name_without_ext = filename.rsplit(".", 1)[0] if "." in filename else filename

    # Remove all responsive variant suffixes from the end
    # Matches patterns like: -780x438, -1280x720, -1280x720-1, -1280x720-1-780x438
    # Pattern: any number of (-NxN or -N) at the end
    base = re.sub(r"(?:-\d+x\d+|-\d+)*$", "", name_without_ext)

    # Also handle alphanumeric variant suffixes (e.g. Merkur's -1Wef)
    # Matches a dash followed by a 3-6 character alphanumeric hash at the end
    base = re.sub(r"-[a-zA-Z0-9]{3,6}$", "", base)

    return base


def clean_html(html: str) -> str:
    """
    Basic HTML sanitization.

    Args:
        html: HTML content to clean

    Returns:
        Cleaned HTML string
    """
    soup = BeautifulSoup(html, "html.parser")

    # Remove comments
    for comment in soup.find_all(string=lambda text: isinstance(text, Comment)):
        comment.extract()

    return str(soup)


def remove_selectors(soup: Union[BeautifulSoup, Tag], selectors: List[str]) -> None:
    """
    Remove elements matching CSS selectors from soup.

    Args:
        soup: BeautifulSoup or Tag object
        selectors: List of CSS selectors to remove
    """
    for selector in selectors:
        for elem in soup.select(selector):
            elem.decompose()


def remove_empty_elements(soup: Union[BeautifulSoup, Tag], tags: List[str]) -> None:
    """
    Remove empty elements (no text and no images).

    Args:
        soup: BeautifulSoup or Tag object
        tags: List of tag names to check (e.g., ['p', 'div'])
    """
    for tag_name in tags:
        for elem in soup.find_all(tag_name):
            # Check if empty (no text and no media elements)
            if not elem.get_text(strip=True) and not elem.find(["img", "iframe", "video"]):
                elem.decompose()


def clean_data_attributes(
    soup: Union[BeautifulSoup, Tag], keep: Optional[List[str]] = None
) -> None:
    """
    Remove data attributes except those in the keep list.

    Args:
        soup: BeautifulSoup or Tag object
        keep: List of data attributes to preserve (e.g., ['data-src', 'data-srcset'])
    """
    if keep is None:
        keep = ["data-src", "data-srcset"]

    for elem in soup.find_all(True):
        attrs_to_remove = []
        for attr in elem.attrs:
            if attr.startswith("data-") and attr not in keep:
                attrs_to_remove.append(attr)

        for attr in attrs_to_remove:
            del elem[attr]


def remove_image_by_url(soup: Union[BeautifulSoup, Tag], image_url: Optional[str]) -> None:
    """
    Remove the first image with the specified URL from the soup.

    Used to remove header images from the article content after extracting them.
    Handles exact URL matches, filename matches, and responsive image variants.

    Args:
        soup: BeautifulSoup or Tag object
        image_url: URL of the image to remove (optional, does nothing if None)
    """
    if not image_url:
        return

    # Skip if image_url is a data URI (already embedded image)
    if image_url.startswith("data:"):
        return

    # Extract the filename/path from the image URL for flexible matching
    image_path = image_url.split("/")[-1] if "/" in image_url else image_url
    # Get base filename without extension for responsive variant matching
    image_base = _get_base_filename(image_path)

    for img in soup.find_all("img"):
        img_src = (
            get_attr_str(img, "src")
            or get_attr_str(img, "data-src")
            or get_attr_str(img, "data-lazy-src")
        )
        if not img_src or img_src.startswith("data:"):
            continue

        # Try exact match first
        if img_src == image_url:
            img.decompose()
            return

        # Try matching by filename/path for relative vs absolute URLs
        img_path = img_src.split("/")[-1] if "/" in img_src else img_src
        if (
            img_path
            and img_path == image_path
            and len(img_path) > 3
            and img_path not in ["image.jpg", "photo.jpg", "pic.jpg"]
        ):
            img.decompose()
            return

        # Try matching responsive image variants (e.g., -780x438 suffixes)
        img_base = _get_base_filename(img_path)
        if (
            img_base
            and img_base == image_base
            and len(img_base) > 3
            and img_base not in ["image", "photo", "pic"]
        ):
            img.decompose()
            return


def sanitize_class_names(soup: Union[BeautifulSoup, Tag]) -> None:
    """
    Convert all class attributes to data-sanitized-class attributes.

    This prevents CSS conflicts by moving class names to data attributes.

    Args:
        soup: BeautifulSoup or Tag object
    """
    for elem in soup.find_all(True):
        if "class" in elem.attrs:
            # Move to data-sanitized-class
            elem["data-sanitized-class"] = get_attr_str(elem, "class")

            # Remove original class attribute
            del elem["class"]


def sanitize_html_attributes(soup: Union[BeautifulSoup, Tag]) -> None:
    """
    Sanitize HTML by renaming attributes to data-sanitized-* format.

    Similar to TypeScript sanitizeHtml() function. This function:
    - Removes script, object, embed elements
    - Removes style and iframe elements
    - Converts class → data-sanitized-class
    - Converts style → data-sanitized-style
    - Converts id → data-sanitized-id
    - Converts other data-* attributes → data-sanitized-* (except data-src, data-srcset)

    Args:
        soup: BeautifulSoup or Tag object to sanitize in-place
    """
    # Remove dangerous elements
    for tag in soup.find_all(["script", "object", "embed"]):
        tag.decompose()

    # Remove style elements
    for tag in soup.find_all("style"):
        tag.decompose()

    # Remove every iframe. Nothing renders Article.content any more, and video
    # embeds reach the client as typed `embed` blocks carrying a canonical
    # public URL -- so there is no iframe worth keeping and no proxy endpoint
    # left to point one at.
    for tag in soup.find_all("iframe"):
        tag.decompose()

    # Rename attributes for all elements
    for elem in soup.find_all(True):
        # Remove on* attributes (XSS prevention)
        attrs_to_delete = [attr for attr in elem.attrs if attr.lower().startswith("on")]
        for attr in attrs_to_delete:
            del elem[attr]

        # Convert class → data-sanitized-class
        if "class" in elem.attrs:
            elem["data-sanitized-class"] = get_attr_str(elem, "class")
            del elem["class"]

        # Convert style → data-sanitized-style
        if "style" in elem.attrs:
            style_value = elem["style"]
            elem["data-sanitized-style"] = style_value
            del elem["style"]

        # Convert id → data-sanitized-id
        if "id" in elem.attrs:
            id_value = elem["id"]
            elem["data-sanitized-id"] = id_value
            del elem["id"]

        # Convert other data-* attributes → data-sanitized-*
        # Keep data-src and data-srcset unchanged
        attrs_to_rename = []
        for attr in elem.attrs:
            if (
                attr.startswith("data-")
                and attr not in ["data-src", "data-srcset"]
                and not attr.startswith("data-sanitized-")
            ):
                attrs_to_rename.append(attr)

        for attr in attrs_to_rename:
            new_attr = f"data-sanitized-{attr[5:]}"  # Remove "data-" prefix
            elem[new_attr] = elem[attr]
            del elem[attr]


def remove_sanitized_attributes(soup: Union[BeautifulSoup, Tag]) -> None:
    """
    Remove all data-sanitized-* attributes from elements.

    Used after sanitization to clean up HTML (Merkur-specific behavior).

    Args:
        soup: BeautifulSoup or Tag object to clean in-place
    """
    for elem in soup.find_all(True):
        attrs_to_remove = []
        for attr in elem.attrs:
            if attr.startswith("data-sanitized-"):
                attrs_to_remove.append(attr)

        for attr in attrs_to_remove:
            del elem[attr]
