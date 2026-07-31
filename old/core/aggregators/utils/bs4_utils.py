"""BeautifulSoup utility functions for type-safe attribute access."""

from typing import Any, List


def get_attr_str(tag: Any, attr: str, default: str = "") -> str:
    """
    Get a tag attribute as a string, even if BeautifulSoup returns a list.

    Args:
        tag: BeautifulSoup Tag object
        attr: Attribute name
        default: Default value if attribute is missing

    Returns:
        Attribute value as a string
    """
    val = tag.get(attr)
    if val is None:
        return default
    if isinstance(val, list):
        return " ".join(val)
    return str(val)


def get_attr_list(tag: Any, attr: str) -> List[str]:
    """
    Get a tag attribute as a list, even if BeautifulSoup returns a string.

    Args:
        tag: BeautifulSoup Tag object
        attr: Attribute name

    Returns:
        Attribute value as a list of strings
    """
    val = tag.get(attr)
    if val is None:
        return []
    if isinstance(val, list):
        return [str(item) for item in val]
    return [str(val)]
