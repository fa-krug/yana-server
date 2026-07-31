"""The pinned wire format: version 1 of the Yana content format."""

import json
from pathlib import Path

import pytest

from core.blocks.schema import (
    UnsupportedFormatVersion,
    decode_block,
    decode_document,
    encode_block,
    encode_document,
)
from core.blocks.types import (
    FORMAT_VERSION,
    Blockquote,
    CodeBlock,
    Divider,
    EmbedBlock,
    Heading,
    ImageBlock,
    InlineRun,
    ListBlock,
    Paragraph,
)

GOLDEN = Path(__file__).parent / "fixtures" / "blocks_golden_v1.json"

EVERY_KIND = [
    Paragraph(runs=[InlineRun(text="Hi", bold=True, link="https://example.com/a")]),
    Heading(level=2, runs=[InlineRun(text="Title")]),
    ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="one")])], []]),
    Blockquote(blocks=[Paragraph(runs=[InlineRun(text="quoted", italic=True)])]),
    ImageBlock(ref="yana-img://" + "a" * 64, caption=[InlineRun(text="cap")]),
    EmbedBlock(
        provider="youtube",
        external_url="https://www.youtube.com/watch?v=abc123",
        thumbnail_ref="yana-img://" + "b" * 64,
        title="A video",
    ),
    CodeBlock(text="print('x')"),
    Divider(),
]


def test_every_kind_round_trips():
    payload = encode_document(EVERY_KIND)
    assert payload["version"] == FORMAT_VERSION
    assert decode_document(payload) == EVERY_KIND


def test_document_survives_a_json_round_trip():
    assert decode_document(json.loads(json.dumps(encode_document(EVERY_KIND)))) == EVERY_KIND


def test_styles_encode_as_a_string_array():
    run = InlineRun(text="x", bold=True, strikethrough=True)
    encoded = encode_block(Paragraph(runs=[run]))
    assert encoded["runs"][0]["styles"] == ["bold", "strikethrough"]


def test_unknown_style_name_is_ignored_not_fatal():
    decoded = decode_block(
        {"type": "paragraph", "runs": [{"text": "x", "styles": ["bold", "wat"]}]}
    )
    assert decoded == Paragraph(runs=[InlineRun(text="x", bold=True)])


def test_unknown_block_type_is_skipped_and_neighbours_survive():
    payload = {
        "version": 1,
        "blocks": [
            {"type": "divider"},
            {"type": "table", "rows": []},
            {"type": "paragraph", "runs": [{"text": "after"}]},
        ],
    }
    assert decode_document(payload) == [Divider(), Paragraph(runs=[InlineRun(text="after")])]


def test_missing_optional_keys_decode_with_defaults():
    assert decode_block({"type": "codeBlock", "text": "x"}) == CodeBlock(text="x", language="")
    assert decode_block({"type": "embed", "externalURL": "https://x/"}) == EmbedBlock(
        provider="generic", external_url="https://x/", thumbnail_ref="", title=""
    )
    assert decode_block({"type": "paragraph"}) == Paragraph(runs=[])


def test_optional_strings_encode_as_null():
    encoded = encode_block(CodeBlock(text="x"))
    assert encoded == {"type": "codeBlock", "text": "x", "language": None}
    embed = encode_block(EmbedBlock(provider="tweet", external_url="https://x.com/a/status/1"))
    assert embed["thumbnailRef"] is None
    assert embed["title"] is None
    assert encode_block(Paragraph(runs=[InlineRun(text="x")]))["runs"][0]["link"] is None


def test_code_block_wire_type_is_camel_case():
    assert encode_block(CodeBlock(text="x"))["type"] == "codeBlock"


def test_heading_level_is_clamped_on_decode():
    assert decode_block({"type": "heading", "level": 9, "runs": []}).level == 6
    assert decode_block({"type": "heading", "level": 0, "runs": []}).level == 1


def test_unknown_provider_falls_back_to_generic():
    decoded = decode_block({"type": "embed", "provider": "vimeo", "externalURL": "https://v/1"})
    assert decoded.provider == "generic"


def test_unsupported_version_raises():
    with pytest.raises(UnsupportedFormatVersion):
        decode_document({"version": 99, "blocks": []})


def test_golden_fixture_decodes_to_the_expected_tree():
    """The shared contract check -- the iOS side tests against this same file."""
    payload = json.loads(GOLDEN.read_text())
    assert decode_document(payload) == EVERY_KIND


def test_golden_fixture_matches_what_we_encode():
    assert json.loads(GOLDEN.read_text()) == encode_document(EVERY_KIND)
