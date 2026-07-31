"""Guard tests: images are stored, never inlined as base64.

Spec 4 replaced every ``data:image/...;base64,...`` producer with the
content-addressed store. These assert absence so a future change cannot
silently reintroduce inlining -- the failure mode that inflated every image by
~33% and stored the same picture once per article.
"""

from pathlib import Path

import core

PRODUCTION_ROOT = Path(core.__file__).parent

# The backfill decodes existing data URIs; it is the one module allowed to
# mention them.
ALLOWED_DATA_URI_MENTIONS = {
    PRODUCTION_ROOT / "management" / "commands" / "migrate_inline_images.py",
}


def production_modules():
    for path in sorted(PRODUCTION_ROOT.rglob("*.py")):
        if "tests" in path.parts or path.name.startswith("tests_"):
            continue
        if "migrations" in path.parts:
            continue
        yield path


def test_no_production_module_encodes_images_as_base64():
    offenders = [
        str(path.relative_to(PRODUCTION_ROOT))
        for path in production_modules()
        if "b64encode" in path.read_text()
    ]

    assert offenders == [], f"base64 encoding is back in {offenders}"


def test_only_the_backfill_mentions_base64_data_uris():
    offenders = [
        str(path.relative_to(PRODUCTION_ROOT))
        for path in production_modules()
        if ";base64," in path.read_text() and path not in ALLOWED_DATA_URI_MENTIONS
    ]

    assert offenders == [], f"base64 data URIs are back in {offenders}"


def test_the_base64_feature_flag_is_gone():
    from core.aggregators.services import config

    assert not hasattr(config, "ENABLE_BASE64_ENCODING")


def test_the_data_uri_helpers_are_gone():
    from core.aggregators.services.image_extraction import compression

    assert not hasattr(compression, "compress_and_encode_image")
    assert not hasattr(compression, "create_image_element")
