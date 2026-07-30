"""HTML -> blocks: the Python port of iOS's BlockParser."""

import os

import pytest

from core.aggregators.caschys_blog.aggregator import CaschysBlogAggregator
from core.aggregators.explosm.aggregator import ExplosmAggregator
from core.aggregators.mactechnews.aggregator import MactechnewsAggregator
from core.aggregators.utils.block_parser import blocks_from_html, plain_text
from core.aggregators.utils.content_extractor import extract_main_content
from core.aggregators.utils.html_cleaner import clean_html
from core.blocks.types import (
    Block,
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

_FIXTURES_DIR = os.path.join(os.path.dirname(__file__), "fixtures")


def test_empty_and_blank_html_yields_nothing():
    assert blocks_from_html("") == []
    assert blocks_from_html("   \n  ") == []


def test_paragraph_becomes_a_paragraph_block():
    assert blocks_from_html("<p>Hello</p>") == [Paragraph(runs=[InlineRun(text="Hello")])]


def test_bare_text_is_buffered_into_a_paragraph():
    assert blocks_from_html("Loose text") == [Paragraph(runs=[InlineRun(text="Loose text")])]


def test_whitespace_is_normalized_like_swiftsoup():
    assert blocks_from_html("<p>a\n\n   b</p>") == [Paragraph(runs=[InlineRun(text="a b")])]


def test_headings_map_to_their_level():
    blocks = blocks_from_html("<h1>a</h1><h3>b</h3>")
    assert blocks == [
        Heading(level=1, runs=[InlineRun(text="a")]),
        Heading(level=3, runs=[InlineRun(text="b")]),
    ]


def test_all_six_heading_levels_map_exactly():
    for level in range(1, 7):
        blocks = blocks_from_html(f"<h{level}>a</h{level}>")
        assert blocks == [Heading(level=level, runs=[InlineRun(text="a")])], level


def test_a_bogus_heading_tag_is_treated_as_an_unknown_wrapper():
    """There is no <h7>, so it recurses like any other unknown tag rather than
    producing an out-of-range heading. Level clamping itself is enforced on
    decode (schema) and on write (storage), where out-of-range input is
    actually reachable."""
    assert blocks_from_html("<h7>a</h7>") == [Paragraph(runs=[InlineRun(text="a")])]


def test_inline_tags_buffer_into_one_paragraph():
    blocks = blocks_from_html("<p>plain <strong>bold</strong> <em>it</em></p>")
    assert blocks == [
        Paragraph(
            runs=[
                InlineRun(text="plain "),
                InlineRun(text="bold", bold=True),
                InlineRun(text=" "),
                InlineRun(text="it", italic=True),
            ]
        )
    ]


def test_nested_styles_combine_on_one_run():
    blocks = blocks_from_html("<p><b><i>both</i></b></p>")
    assert blocks == [Paragraph(runs=[InlineRun(text="both", bold=True, italic=True)])]


def test_code_and_strikethrough_map_to_their_flags():
    blocks = blocks_from_html("<p><code>c</code><del>d</del></p>")
    assert blocks == [
        Paragraph(runs=[InlineRun(text="c", code=True), InlineRun(text="d", strikethrough=True)])
    ]


def test_br_becomes_a_newline_run():
    blocks = blocks_from_html("<p>a<br>b</p>")
    assert blocks == [
        Paragraph(runs=[InlineRun(text="a"), InlineRun(text="\n"), InlineRun(text="b")])
    ]


def test_links_become_runs_with_an_absolute_url():
    blocks = blocks_from_html(
        '<p><a href="/rel">here</a></p>', base_url="https://example.com/news/story"
    )
    assert blocks == [Paragraph(runs=[InlineRun(text="here", link="https://example.com/rel")])]


def test_link_without_base_url_is_left_alone():
    blocks = blocks_from_html('<p><a href="/rel">here</a></p>')
    assert blocks == [Paragraph(runs=[InlineRun(text="here", link="/rel")])]


def test_style_carries_through_a_link():
    blocks = blocks_from_html('<p><a href="https://x/"><b>bl</b></a></p>')
    assert blocks == [Paragraph(runs=[InlineRun(text="bl", bold=True, link="https://x/")])]


def test_a_javascript_href_is_dropped_but_the_text_survives():
    """A dangerous scheme must never reach storage -- these `link` values are
    also what a future API serves to the iOS client, not just what admin
    renders."""
    blocks = blocks_from_html('<p><a href="javascript:alert(document.cookie)">here</a></p>')
    assert blocks == [Paragraph(runs=[InlineRun(text="here", link="")])]


def test_http_https_mailto_and_relative_hrefs_all_keep_their_link():
    for href in ("http://x/", "https://x/", "mailto:a@x.test", "/rel"):
        blocks = blocks_from_html(f'<p><a href="{href}">here</a></p>')
        assert blocks == [Paragraph(runs=[InlineRun(text="here", link=href)])], href


def test_dropped_tags_produce_nothing_and_neither_do_their_children():
    """A still-dropped wrapper's children must not leak in as stray paragraphs
    -- that is the whole reason drop-vs-recurse exists.

    Table used to be the example here, but tables now flatten into paragraphs
    instead of being dropped -- see the table tests below."""
    html = "<script><p>cell</p></script><p>real</p>"
    assert blocks_from_html(html) == [Paragraph(runs=[InlineRun(text="real")])]


def test_every_dropped_tag_is_dropped():
    for tag in ("form", "button", "select", "textarea", "noscript", "iframe", "audio", "canvas"):
        assert blocks_from_html(f"<{tag}><p>x</p></{tag}>") == [], tag


def test_header_image_is_suppressed_but_the_rest_of_the_document_is_untouched():
    """<header> is the article's dedicated hero-media slot
    (content_formatter.build_header_html): its plain image is persisted
    separately to Article.icon, so surfacing it again here would duplicate it
    as the article's own leading body block. <header> is recursed into like
    any unknown wrapper -- only the `image` block kind its subtree produces is
    dropped, not the wrapper's content wholesale (see
    test_header_paragraph_survives and test_header_keeps_an_embed_facade_but_drops_its_image
    below for what does survive)."""
    ref = "yana-img://" + "a" * 64
    html = f"<header><img src='{ref}'></header><p>body</p>"
    assert blocks_from_html(html) == [Paragraph(runs=[InlineRun(text="body")])]


def test_header_paragraph_survives():
    """Only the `image` block kind is suppressed from a header's subtree --
    ordinary text content it holds is real and must come through."""
    assert blocks_from_html("<header><p>lead text</p></header>") == [
        Paragraph(runs=[InlineRun(text="lead text")])
    ]


def test_header_keeps_an_embed_facade_but_drops_its_image():
    """The case that pins the rule: a header holding BOTH a plain image and a
    non-image block (here, an embed facade) keeps the embed and drops only
    the image -- the suppression is by block kind, not by dropping the whole
    header subtree."""
    ref = "yana-img://" + "b" * 64
    html = f'<header><img src="{ref}">{YOUTUBE_FACADE}</header>'
    blocks = blocks_from_html(html)
    assert not any(isinstance(block, ImageBlock) for block in blocks)
    assert any(isinstance(block, EmbedBlock) and block.provider == "youtube" for block in blocks)


def test_nested_header_suppresses_its_own_image_without_double_handling():
    ref = "yana-img://" + "c" * 64
    html = f'<header><header><img src="{ref}"></header><p>text</p></header>'
    assert blocks_from_html(html) == [Paragraph(runs=[InlineRun(text="text")])]


def test_table_row_becomes_one_paragraph_with_cells_joined_by_em_dash():
    html = "<table><tr><td>Alice</td><td>30</td></tr></table>"
    assert blocks_from_html(html) == [
        Paragraph(runs=[InlineRun(text="Alice"), InlineRun(text=" — "), InlineRun(text="30")])
    ]


def test_table_header_row_cells_are_bold():
    html = "<table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>30</td></tr></table>"
    assert blocks_from_html(html) == [
        Paragraph(
            runs=[
                InlineRun(text="Name", bold=True),
                InlineRun(text=" — "),
                InlineRun(text="Age", bold=True),
            ]
        ),
        Paragraph(runs=[InlineRun(text="Alice"), InlineRun(text=" — "), InlineRun(text="30")]),
    ]


def test_table_cell_link_survives_as_an_inline_run_with_its_href():
    html = '<table><tr><td><a href="https://example.com/x">link text</a></td></tr></table>'
    assert blocks_from_html(html) == [
        Paragraph(runs=[InlineRun(text="link text", link="https://example.com/x")])
    ]


def test_table_cell_image_becomes_an_image_block_after_the_row_paragraph():
    ref = "yana-img://" + "9" * 64
    html = f'<table><tr><td>row text</td><td><img src="{ref}"></td></tr></table>'
    assert blocks_from_html(html) == [
        Paragraph(runs=[InlineRun(text="row text")]),
        ImageBlock(ref=ref),
    ]


def test_table_row_with_only_an_image_and_no_text_still_yields_the_image():
    ref = "yana-img://" + "8" * 64
    html = f'<table><tr><td><img src="{ref}"></td></tr></table>'
    assert blocks_from_html(html) == [ImageBlock(ref=ref)]


def test_table_empty_row_yields_no_empty_paragraph():
    html = "<table><tr><td>x</td></tr><tr><td></td><td>   </td></tr></table>"
    assert blocks_from_html(html) == [Paragraph(runs=[InlineRun(text="x")])]


def test_table_caption_becomes_a_paragraph_before_the_rows():
    html = "<table><caption>Caption text</caption><tr><td>a</td></tr></table>"
    assert blocks_from_html(html) == [
        Paragraph(runs=[InlineRun(text="Caption text")]),
        Paragraph(runs=[InlineRun(text="a")]),
    ]


def test_a_pure_table_body_still_produces_content():
    """The TorrentFreak regression: an article whose entire body is a table
    must not come out as zero blocks and empty plainText."""
    html = (
        "<table><tbody>"
        "<tr><th>Field</th><th>Value</th></tr>"
        "<tr><td>Seeds</td><td>42</td></tr>"
        "</tbody></table>"
    )
    blocks = blocks_from_html(html)
    assert blocks
    assert plain_text(blocks) != ""


def test_nested_table_rows_flatten_independently_of_the_outer_row():
    """Nested tables are not preserved as nesting -- the inner row becomes its
    own paragraph rather than bleeding its text into the outer cell."""
    html = "<table><tr><td>outer<table><tr><td>inner</td></tr></table></td></tr></table>"
    blocks = blocks_from_html(html)
    assert Paragraph(runs=[InlineRun(text="outer")]) in blocks
    assert Paragraph(runs=[InlineRun(text="inner")]) in blocks
    # The inner table's text must not have leaked into the outer row's own run.
    outer_row = next(b for b in blocks if b.runs and b.runs[0].text.strip() == "outer")
    assert "inner" not in "".join(r.text for r in outer_row.runs)


def test_a_full_document_still_parses_from_body():
    """Regression guard: a genuine full document must still be read from its
    <body>, not the whole soup (which would otherwise leak <head> content like
    <title> into the article body)."""
    html = "<html><head><title>Page Title</title></head><body><p>real</p></body></html>"
    assert blocks_from_html(html) == [Paragraph(runs=[InlineRun(text="real")])]


def test_fragment_with_no_body_is_unaffected():
    html = "<p>a</p><div>b</div>"
    assert blocks_from_html(html) == [
        Paragraph(runs=[InlineRun(text="a")]),
        Paragraph(runs=[InlineRun(text="b")]),
    ]


def test_stray_empty_body_element_does_not_swallow_the_rest_of_the_fragment():
    """The TorrentFreak regression: sanitized content can contain a stray,
    empty <body> element (bs4's html.parser happily creates one from malformed
    input, e.g. mid-table). Selecting that empty <body> as the container --
    which `soup.body or soup` used to do -- discards everything else in the
    fragment. The real article's shape, minimized: a stray `<p><body></body></p>`
    sitting between real paragraphs."""
    html = "<p>before</p><p><body></body></p><p>after</p>"
    assert blocks_from_html(html) == [
        Paragraph(runs=[InlineRun(text="before")]),
        Paragraph(runs=[InlineRun(text="after")]),
    ]


def test_table_bodied_fragment_with_stray_empty_body_still_flattens_rows():
    """End-to-end pin of the real-world TorrentFreak case: a table-only body
    with a stray empty <body> element sitting in the middle of it must still
    flatten every row into a paragraph -- the stray <body> was the actual
    cause of the reported emptiness, not the table-row flattening."""
    html = (
        "<table><tfoot><tr><td>foot</td></tr></tfoot>"
        "<p><body></body></p>"
        "<tr><td><strong>1</strong></td><td>Seeds</td></tr>"
        "<tr><td><strong>2</strong></td><td>Peers</td></tr>"
        "</table>"
    )
    blocks = blocks_from_html(html)
    assert blocks
    text = plain_text(blocks)
    assert "foot" in text
    assert "Seeds" in text
    assert "Peers" in text


def test_stray_nonempty_body_wins_over_sibling_content_like_a_real_document():
    """Pinning the deliberate tradeoff: a non-empty <body> is treated as an
    authoritative document boundary, exactly like a genuine full document, even
    when it is nested oddly and other content sits alongside it. This keeps the
    container-selection rule a simple, predictable binary (does <body> hold
    content, yes/no) instead of a fuzzier "how much would we lose" heuristic
    that risks regressing the ordinary full-document case (see
    test_a_full_document_still_parses_from_body, where content also exists
    outside <body> in the form of <head><title>). The only real-world case
    observed (TorrentFreak) had an EMPTY stray <body> -- this scenario is
    deliberately not the one being fixed."""
    html = "<p>outside</p><div><body><p>inside body</p></body></div>"
    assert blocks_from_html(html) == [Paragraph(runs=[InlineRun(text="inside body")])]


def test_multiple_body_elements_first_empty_falls_back_to_whole_soup():
    """bs4's html.parser can produce more than one <body> from malformed input.
    `soup.body` only ever looks at the first one; when that first one is
    empty, falling back to the whole soup (rather than hunting for a "real"
    body among the rest) is what naturally recovers every other body's content
    too, with no extra special-casing needed."""
    html = "<p>before</p><body></body><p>middle</p><body><p>second body real</p></body><p>after</p>"
    blocks = blocks_from_html(html)
    text = plain_text(blocks)
    assert "before" in text
    assert "middle" in text
    assert "second body real" in text
    assert "after" in text


def test_unknown_wrappers_are_recursed_into():
    html = "<div><section><p>deep</p></section></div>"
    assert blocks_from_html(html) == [Paragraph(runs=[InlineRun(text="deep")])]


def test_comments_are_not_body_text():
    assert blocks_from_html("<!-- hidden --><p>shown</p>") == [
        Paragraph(runs=[InlineRun(text="shown")])
    ]


def test_empty_paragraphs_and_headings_are_omitted():
    assert blocks_from_html("<p></p><p>   </p><h2></h2>") == []


def test_hr_is_a_divider():
    assert blocks_from_html("<hr>") == [Divider()]


def test_plain_text_flattens_in_document_order():
    blocks = blocks_from_html("<h2>Title</h2><p>One</p><p>Two</p>")
    assert plain_text(blocks) == "Title\n\nOne\n\nTwo"


def test_plain_text_skips_empty_segments_and_dividers():
    assert plain_text(blocks_from_html("<p>a</p><hr><p>  </p><p>b</p>")) == "a\n\nb"


def test_plain_text_of_nothing_is_empty():
    assert plain_text([]) == ""


def test_unordered_and_ordered_lists():
    blocks = blocks_from_html("<ul><li>a</li></ul><ol><li>b</li></ol>")
    assert blocks == [
        ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="a")])]]),
        ListBlock(ordered=True, items=[[Paragraph(runs=[InlineRun(text="b")])]]),
    ]


def test_nested_lists_round_trip_through_items():
    blocks = blocks_from_html("<ul><li>outer<ul><li>inner</li></ul></li></ul>")
    assert blocks == [
        ListBlock(
            ordered=False,
            items=[
                [
                    Paragraph(runs=[InlineRun(text="outer")]),
                    ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="inner")])]]),
                ]
            ],
        )
    ]


def test_only_direct_li_children_become_items():
    blocks = blocks_from_html("<ul><div><li>nested-away</li></div><li>direct</li></ul>")
    assert blocks == [
        ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="direct")])]])
    ]


def test_empty_lists_and_empty_items_are_omitted():
    assert blocks_from_html("<ul></ul>") == []
    assert blocks_from_html("<ul><li></li><li>  </li></ul>") == []
    assert blocks_from_html("<ul><li></li><li>kept</li></ul>") == [
        ListBlock(ordered=False, items=[[Paragraph(runs=[InlineRun(text="kept")])]])
    ]


def test_ordinary_blockquote_wraps_its_blocks():
    blocks = blocks_from_html("<blockquote><p>quoted</p></blockquote>")
    assert blocks == [Blockquote(blocks=[Paragraph(runs=[InlineRun(text="quoted")])])]


def test_empty_blockquote_is_omitted():
    assert blocks_from_html("<blockquote>  </blockquote>") == []


def test_pre_becomes_a_code_block_with_whitespace_intact():
    blocks = blocks_from_html("<pre>def f():\n    return 1\n</pre>")
    assert blocks == [CodeBlock(text="def f():\n    return 1\n", language="")]


def test_empty_pre_is_omitted():
    assert blocks_from_html("<pre>   </pre>") == []


def test_standalone_img_becomes_an_image_block():
    ref = "yana-img://" + "c" * 64
    assert blocks_from_html(f'<img src="{ref}">') == [ImageBlock(ref=ref)]


def test_img_without_src_is_dropped():
    assert blocks_from_html('<img alt="nothing">') == []


def test_relative_img_src_resolves_against_the_base_url():
    """Defect 1: `_image_block` used to store a bare relative `src` verbatim,
    the same way `<a href>` would if `_resolve_url` didn't exist for it --
    this is why TorrentFreak's refs came out as `/images/proton270.png`."""
    blocks = blocks_from_html(
        '<img src="/images/proton270.png">', base_url="https://torrentfreak.com/article"
    )
    assert blocks == [ImageBlock(ref="https://torrentfreak.com/images/proton270.png")]


def test_img_src_falls_back_to_data_src_then_data_lazy_src():
    """Matches the codebase's existing lazy-load convention (see
    `html_cleaner.remove_image_by_url` / `PageImagesStrategy`): `src` wins
    when present, then `data-src`, then `data-lazy-src`."""
    assert blocks_from_html('<img data-src="https://x/real.png">') == [
        ImageBlock(ref="https://x/real.png")
    ]
    assert blocks_from_html('<img data-lazy-src="https://x/real2.png">') == [
        ImageBlock(ref="https://x/real2.png")
    ]
    assert blocks_from_html('<img src="https://x/wins.png" data-src="https://x/loses.png">') == [
        ImageBlock(ref="https://x/wins.png")
    ]


def test_already_localized_img_src_is_never_run_through_url_resolution():
    """A `yana-img://` ref is not a real URL scheme -- `_resolve_url` must
    special-case it, or every existing `yana-img://` fixture in this suite
    would come out empty (its scheme isn't in `_SAFE_URL_SCHEMES`)."""
    ref = "yana-img://" + "9" * 64
    assert blocks_from_html(f'<img src="{ref}">', base_url="https://example.com/a/b") == [
        ImageBlock(ref=ref)
    ]


def test_data_uri_img_src_is_dropped_not_stored_verbatim():
    """`_resolve_url`'s scheme allowlist rejects `data:` the same way it does
    for a link -- an image with only a data URI src is dropped rather than
    persisting an inlined payload as a block's ref."""
    assert blocks_from_html('<img src="data:image/png;base64,AAAA">') == []


def test_paragraph_wrapping_only_an_image_yields_the_image():
    """The Reddit/Giphy regression guard: inline-run extraction drops images, so
    a <p><img></p> would otherwise vanish entirely."""
    ref = "yana-img://" + "d" * 64
    assert blocks_from_html(f'<p><img src="{ref}"></p>') == [ImageBlock(ref=ref)]


def test_paragraph_with_text_and_an_image_yields_text_then_image():
    ref = "yana-img://" + "e" * 64
    blocks = blocks_from_html(f'<p>caption text<img src="{ref}"></p>')
    assert blocks == [Paragraph(runs=[InlineRun(text="caption text")]), ImageBlock(ref=ref)]


def test_figure_pairs_an_image_with_its_figcaption():
    ref = "yana-img://" + "f" * 64
    blocks = blocks_from_html(f'<figure><img src="{ref}"><figcaption>Shot</figcaption></figure>')
    assert blocks == [ImageBlock(ref=ref, caption=[InlineRun(text="Shot")])]


def test_figure_without_an_image_is_recursed():
    assert blocks_from_html("<figure><p>text only</p></figure>") == [
        Paragraph(runs=[InlineRun(text="text only")])
    ]


def test_figure_with_two_images_yields_both():
    """A <figure> is not always one image -- the second must not be dropped.
    The figcaption, which describes the figure as a whole, attaches only to
    the first image; there is nowhere to put a shared caption twice."""
    ref1 = "yana-img://" + "1" * 64
    ref2 = "yana-img://" + "2" * 64
    html = f'<figure><img src="{ref1}"><img src="{ref2}"><figcaption>Two</figcaption></figure>'
    assert blocks_from_html(html) == [
        ImageBlock(ref=ref1, caption=[InlineRun(text="Two")]),
        ImageBlock(ref=ref2),
    ]


def test_figure_with_a_figcaption_and_no_media_becomes_a_paragraph():
    """A <figcaption> with nothing to attach to must still surface as text,
    not vanish -- the same rule that keeps the video-only case below alive."""
    assert blocks_from_html("<figure><figcaption>only a caption</figcaption></figure>") == [
        Paragraph(runs=[InlineRun(text="only a caption")])
    ]


def test_figure_with_leading_text_and_an_image_keeps_the_text():
    """The defect: the old shortcut returned only the recovered image blocks,
    discarding any text in the figure that wasn't inside a <figcaption>."""
    ref = "yana-img://" + "7" * 64
    html = f'<figure><p>lead text<img src="{ref}"></p></figure>'
    assert blocks_from_html(html) == [
        Paragraph(runs=[InlineRun(text="lead text")]),
        ImageBlock(ref=ref),
    ]


def test_figure_with_leading_text_and_a_video_keeps_the_text():
    """Same defect, video flavor -- also confirms EmbedBlock survives the walk."""
    html = '<figure><p>lead text<video src="https://v/x.mp4"></video></p></figure>'
    blocks = blocks_from_html(html)
    assert blocks == [
        Paragraph(runs=[InlineRun(text="lead text")]),
        EmbedBlock(provider="video", external_url="https://v/x.mp4"),
    ]


def test_figure_with_leading_paragraph_and_trailing_figcaption_keeps_both():
    """The figcaption must still find and attach to the image even though a
    <p> comes before it in document order."""
    ref = "yana-img://" + "8" * 64
    html = f"<figure><p>lead</p><img src='{ref}'><figcaption>cap</figcaption></figure>"
    assert blocks_from_html(html) == [
        Paragraph(runs=[InlineRun(text="lead")]),
        ImageBlock(ref=ref, caption=[InlineRun(text="cap")]),
    ]


def test_figure_with_a_video_and_a_figcaption_moves_the_caption_to_a_paragraph():
    """EmbedBlock has no caption slot, so a figcaption on a video-only figure
    would otherwise be lost outright -- it must surface as a trailing
    paragraph instead."""
    html = '<figure><video src="https://v/y.mp4"></video><figcaption>cap</figcaption></figure>'
    assert blocks_from_html(html) == [
        EmbedBlock(provider="video", external_url="https://v/y.mp4"),
        Paragraph(runs=[InlineRun(text="cap")]),
    ]


def test_lightbox_wrapped_image_with_no_paragraph_ancestor_survives():
    """A body image wrapped in a plain <a> (a lightbox link, with no <p> or
    <figure> ancestor) must not vanish -- MacTechNews wraps every body image
    exactly this way."""
    ref = "yana-img://" + "3" * 64
    html = f'<a href="https://example.com/full" rel="lightbox"><img src="{ref}"></a>'
    assert blocks_from_html(html) == [ImageBlock(ref=ref)]


def test_inline_wrapped_image_keeps_its_surrounding_text_in_order():
    """Media can't live inside a text run, so an image found while buffering
    inline content is deferred to the paragraph's next flush -- it must not
    fragment the paragraph, and the text must still come out whole."""
    ref = "yana-img://" + "4" * 64
    html = f'before <a href="https://example.com/full"><img src="{ref}"></a> after'
    assert blocks_from_html(html) == [
        Paragraph(runs=[InlineRun(text="before "), InlineRun(text=" after")]),
        ImageBlock(ref=ref),
    ]


def test_noscript_wrapped_image_in_a_paragraph_is_not_emitted():
    """<noscript> is a DROPPED_TAGS member -- its subtree never holds real
    content, so an image tucked inside it (a lazy-load fallback) must not be
    recovered, even though the <p> branch splits real images out of the text
    it wraps."""
    ref = "yana-img://" + "5" * 64
    html = f'<p><noscript><img src="{ref}"></noscript></p>'
    assert blocks_from_html(html) == []


def test_noscript_wrapped_image_in_an_inline_element_is_not_emitted():
    html = 'before <a href="https://x/"><noscript><img src="yana-img://a"></noscript></a> after'
    blocks = blocks_from_html(html)
    assert not any(isinstance(block, ImageBlock) for block in blocks)


def test_noscript_wrapped_image_in_a_figure_is_not_emitted():
    html = '<figure><noscript><img src="yana-img://a"></noscript></figure>'
    assert blocks_from_html(html) == []


def test_image_duplicated_inside_noscript_next_to_the_real_tag_in_a_link():
    """The exact reproduction: `<noscript><img></noscript>` next to a
    lazy-loading `<img>` is a standard publisher pattern, and both used to be
    emitted -- once each, both pointing at the same image."""
    ref = "yana-img://A"
    html = f'<div><a href="https://x/"><noscript><img src="{ref}"></noscript><img src="{ref}"></a></div>'  # noqa: E501
    assert blocks_from_html(html) == [ImageBlock(ref=ref)]


def test_image_duplicated_inside_noscript_next_to_the_real_tag_in_a_paragraph():
    """Same defect, but reachable through the <p> branch, which has had it
    all along -- not something the inline branch introduced."""
    ref = "yana-img://B"
    html = f'<p><noscript><img src="{ref}"></noscript><img src="{ref}"></p>'
    assert blocks_from_html(html) == [ImageBlock(ref=ref)]


def test_image_nested_several_levels_inside_a_dropped_subtree_is_skipped():
    """The ancestor walk must not stop at the immediate parent -- the image
    can be nested arbitrarily deep inside the dropped subtree."""
    html = (
        '<p><noscript><a href="https://x/"><span><img src="yana-img://a"></span></a></noscript></p>'  # noqa: E501
    )
    assert blocks_from_html(html) == []


def test_video_is_recovered_from_a_paragraph():
    html = '<p>caption<video src="https://v/x.mp4"></video></p>'
    blocks = blocks_from_html(html)
    assert [type(block) for block in blocks] == [Paragraph, EmbedBlock]
    assert blocks[1].external_url == "https://v/x.mp4"


def test_video_is_recovered_from_an_inline_element():
    """The worse half of the defect: previously *everything* was lost, not
    just the video -- a publisher wrapping a video in a link is ordinary
    markup, same class of loss the image-recovery paths already guard
    against."""
    html = '<div><a href="https://x/"><video src="https://v/y.mp4"></video></a></div>'
    blocks = blocks_from_html(html)
    assert blocks == [EmbedBlock(provider="video", external_url="https://v/y.mp4")]


def test_block_level_video_still_becomes_an_embed_block():
    """Control case: this path must keep working unchanged."""
    blocks = blocks_from_html('<video src="https://v/z.mp4"></video>')
    assert blocks == [EmbedBlock(provider="video", external_url="https://v/z.mp4")]


def test_paragraph_recovers_image_then_video_in_document_order():
    ref = "yana-img://" + "6" * 64
    html = f'<p>text<img src="{ref}"><video src="https://v/w.mp4"></video></p>'
    blocks = blocks_from_html(html)
    assert [type(block) for block in blocks] == [Paragraph, ImageBlock, EmbedBlock]
    assert blocks[1].ref == ref
    assert blocks[2].external_url == "https://v/w.mp4"


def test_plain_text_walks_lists_quotes_captions_and_code():
    html = (
        "<ul><li>item</li></ul>"
        "<blockquote><p>quote</p></blockquote>"
        '<figure><img src="yana-img://a"><figcaption>cap</figcaption></figure>'
        "<pre>code</pre>"
    )
    assert plain_text(blocks_from_html(html)) == "item\n\nquote\n\ncap\n\ncode"


# The current facade shape (Task 12): no iframe, id carried in a
# data-sanitized-embed attribute plus a visible watch-link anchor. Pre-Task-12
# stored content used a proxy iframe as the sole id source instead -- see
# LEGACY_PROXY_FACADE below for that shape.
YOUTUBE_FACADE = (
    '<div data-sanitized-class="youtube-embed-container" '
    'data-sanitized-embed="https://www.youtube.com/embed/dQw4w9WgXcQ">'
    '<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">Watch on YouTube</a>'
    "</div>"
)


def test_youtube_facade_is_found_through_an_unsanitized_class():
    html = YOUTUBE_FACADE.replace("data-sanitized-class", "class").replace(
        "data-sanitized-embed", "data-embed"
    )
    assert blocks_from_html(html)[0].provider == "youtube"


def test_youtube_facade_is_found_inside_a_header_wrapper():
    """<header> is recursed into like any unknown wrapper -- only its `image`
    blocks are suppressed (see test_header_keeps_an_embed_facade_but_drops_its_image),
    so an embed facade with no image alongside it must still be found. Reddit
    renders its YouTube/tweet posts exactly this way, with no Article.icon
    counterpart for the embed itself, so this is real content, not a
    duplicate."""
    html = f'<header style="x">{YOUTUBE_FACADE}</header>'
    assert blocks_from_html(html)[0].provider == "youtube"


def test_youtube_facade_external_url_never_points_at_the_proxy():
    """Task 12 deletes the proxy views; nothing stored may reference them.

    Now a static regression guard against reintroducing the proxy, not a check
    on a live path -- there is no proxy id source left to accidentally match.
    """
    embed = blocks_from_html(YOUTUBE_FACADE)[0]
    assert "youtube-proxy" not in embed.external_url
    assert embed.external_url.startswith("https://www.youtube.com/watch?v=")


def test_youtube_facade_takes_its_thumbnail_from_a_poster_image():
    ref = "yana-img://" + "1" * 64
    html = (
        '<div data-sanitized-class="youtube-embed">'
        f'<img src="{ref}">'
        '<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>'
        "</div>"
    )
    assert blocks_from_html(html)[0].thumbnail_ref == ref


def test_youtube_facade_falls_back_to_a_data_embed_attribute():
    html = (
        '<div data-sanitized-class="youtube-embed" '
        'data-sanitized-data-embed-content="https://www.youtube.com/embed/abcdefghijk"></div>'
    )
    assert blocks_from_html(html) == [
        EmbedBlock(provider="youtube", external_url="https://www.youtube.com/watch?v=abcdefghijk")
    ]


def test_youtube_facade_falls_back_to_a_watch_link():
    html = (
        '<div data-sanitized-class="youtube-embed">'
        '<a href="https://www.youtube.com/watch?v=abcdefghijk">watch</a>'
        "</div>"
    )
    assert blocks_from_html(html)[0].external_url == "https://www.youtube.com/watch?v=abcdefghijk"


def test_a_facade_with_no_iframe_still_yields_an_embed():
    """Post-proxy markup: the id lives in data-embed and in a watch link, with
    no iframe anywhere."""
    html = (
        '<div data-sanitized-class="youtube-embed-container" '
        'data-sanitized-embed="https://www.youtube.com/embed/dQw4w9WgXcQ">'
        '<a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">Watch on YouTube</a>'
        "</div>"
    )
    assert blocks_from_html(html) == [
        EmbedBlock(provider="youtube", external_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    ]


def test_a_dailymotion_facade_with_no_iframe_still_yields_an_embed():
    html = (
        '<div data-sanitized-class="dailymotion-embed-container" '
        'data-sanitized-embed="https://www.dailymotion.com/embed/video/x8abcde">'
        '<a href="https://www.dailymotion.com/video/x8abcde">Watch on Dailymotion</a>'
        "</div>"
    )
    assert blocks_from_html(html) == [
        EmbedBlock(provider="dailymotion", external_url="https://www.dailymotion.com/video/x8abcde")
    ]


# Pre-Task-12 stored Article.content may have only a proxy iframe as the id
# source (no data-embed, no watch link -- that is exactly what the old
# create_youtube_embed_html/proxy_youtube_embeds/mein_mmo producers emitted).
# Task 12 removed the proxy views and stopped producing this markup, but the
# id-extraction regexes stay as a legacy fallback: Task 10's backfill (plus
# the admin re-convert action and `convert_articles_to_blocks --force`)
# re-parses stored Article.content rather than re-fetching from the source, so
# the whole pre-Task-12 corpus depends on this shape still resolving to an
# embed. Do not delete these regexes or this test as "dead code" -- they are
# live for exactly this stored-content case until Article.content itself is
# retired (a follow-up release per the spec).
LEGACY_PROXY_FACADE = (
    '<div data-sanitized-class="youtube-embed-container">'
    '<iframe src="https://yana.example/api/youtube-proxy?v=dQw4w9WgXcQ"></iframe>'
    "</div>"
)

LEGACY_DAILYMOTION_PROXY_FACADE = (
    '<div class="dailymotion-embed-container">'
    '<iframe src="https://yana.example/api/dailymotion-proxy?v=x8abcde"></iframe>'
    "</div>"
)


def test_a_legacy_proxy_only_facade_still_yields_an_embed():
    """Stored content from before the proxy was removed has no data-embed and
    no watch link -- the proxy iframe's src is the only id source. Re-parsing
    it (backfill / re-convert / --force) must still recover the embed."""
    assert blocks_from_html(LEGACY_PROXY_FACADE) == [
        EmbedBlock(provider="youtube", external_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    ]


def test_a_legacy_dailymotion_proxy_only_facade_still_yields_an_embed():
    assert blocks_from_html(LEGACY_DAILYMOTION_PROXY_FACADE) == [
        EmbedBlock(provider="dailymotion", external_url="https://www.dailymotion.com/video/x8abcde")
    ]


def test_unrecognizable_facade_recurses_instead_of_vanishing():
    html = '<div data-sanitized-class="youtube-embed"><p>Caption survives</p></div>'
    assert blocks_from_html(html) == [Paragraph(runs=[InlineRun(text="Caption survives")])]


def test_tiktok_and_bluesky_wrappers_recurse():
    for cls in ("tiktok-embed", "bluesky-embed"):
        html = f'<div data-sanitized-class="{cls}"><p>cap</p></div>'
        assert blocks_from_html(html) == [Paragraph(runs=[InlineRun(text="cap")])], cls


def test_video_with_a_source_becomes_a_video_embed():
    poster = "yana-img://" + "2" * 64
    html = (
        f'<video controls poster="{poster}">'
        '<source src="https://v.example/clip.mp4" type="video/mp4">'
        "Your browser does not support the video element."
        "</video>"
    )
    assert blocks_from_html(html) == [
        EmbedBlock(
            provider="video", external_url="https://v.example/clip.mp4", thumbnail_ref=poster
        )
    ]


def test_video_falls_back_to_its_own_src():
    html = '<video src="https://v.example/clip.m3u8"></video>'
    assert blocks_from_html(html)[0].external_url == "https://v.example/clip.m3u8"


def test_video_without_a_playable_source_is_dropped():
    assert blocks_from_html("<video controls>no source</video>") == []


def test_video_with_an_unsafe_src_is_dropped_not_embedded_without_a_link():
    """An unplayable stream URL is `no embed`, not `an embed with no link` --
    the latter would be a video card that goes nowhere."""
    assert blocks_from_html('<video src="javascript:alert(1)"></video>') == []


def test_video_fallback_text_never_leaks_into_a_paragraph():
    html = "<p>before</p><video><source src='https://v/x.mp4'>Your browser…</video>"
    blocks = blocks_from_html(html)
    assert [type(block) for block in blocks] == [Paragraph, EmbedBlock]
    assert "browser" not in plain_text(blocks)


def test_tagesschau_style_video_header_is_found_through_its_wrappers():
    """core/aggregators/tagesschau/media_processor.py builds a
    <header class="media-header"> around the article's video/audio player and
    the aggregator explicitly nulls out the ordinary header data to avoid a
    redundant build_header_html() header -- meaning this <header>'s content is
    the *only* place that player markup lives, with no Article.icon
    counterpart. Only `image` blocks are suppressed from a header's subtree,
    so this `video` embed must still be found."""
    html = (
        '<header data-sanitized-class="media-header">'
        '<div data-sanitized-class="media-player">'
        '<video controls><source src="https://v/x.mp4" type="video/mp4"></video>'
        "</div></header>"
    )
    assert blocks_from_html(html)[0].provider == "video"


def test_tweet_blockquote_becomes_a_tweet_embed():
    html = (
        "<blockquote><p><strong>@who</strong> · "
        '<a href="https://x.com/who/status/1">View on X</a></p>'
        "<p>the tweet body</p></blockquote>"
    )
    embed = blocks_from_html(html)[0]
    assert embed.provider == "tweet"
    assert embed.external_url == "https://x.com/who/status/1"
    assert "the tweet body" in embed.title


def test_twitter_and_fxtwitter_hosts_are_recognized():
    for host in ("twitter.com", "mobile.twitter.com", "api.fxtwitter.com"):
        html = f'<blockquote><a href="https://{host}/w/status/1">t</a></blockquote>'
        assert blocks_from_html(html)[0].provider == "tweet", host


def test_a_javascript_scheme_disguised_as_a_twitter_host_is_not_a_tweet_embed():
    """`urlparse("javascript://twitter.com/...")` reports hostname
    `twitter.com`, so the host check alone would wrongly accept this -- the
    scheme must be checked too, and checked first."""
    html = '<blockquote><a href="javascript://twitter.com/%0aalert(1)">t</a></blockquote>'
    blocks = blocks_from_html(html)
    assert not any(isinstance(block, EmbedBlock) for block in blocks)


def test_blockquote_linking_elsewhere_stays_a_blockquote():
    html = '<blockquote><p><a href="https://example.com/a">link</a></p></blockquote>'
    assert isinstance(blocks_from_html(html)[0], Blockquote)


def test_plain_text_uses_an_embed_title():
    html = (
        '<blockquote><p>tweet text</p><a href="https://x.com/w/status/1">View on X</a></blockquote>'
    )
    assert "tweet text" in plain_text(blocks_from_html(html))


def _count_image_blocks(blocks: list[Block]) -> int:
    total = 0
    for block in blocks:
        if isinstance(block, ImageBlock):
            total += 1
        elif isinstance(block, ListBlock):
            for item in block.items:
                total += _count_image_blocks(item)
        elif isinstance(block, Blockquote):
            total += _count_image_blocks(block.blocks)
    return total


@pytest.mark.parametrize(
    "fixture_name, aggregator_cls",
    [
        ("mactechnews.html", MactechnewsAggregator),
        ("caschys_blog.html", CaschysBlogAggregator),
        ("explosm.html", ExplosmAggregator),
    ],
)
def test_real_fixtures_keep_every_body_image(fixture_name, aggregator_cls):
    """Regression guard for the lightbox/inline-image loss: every <img> that
    survives the aggregator's own extraction (content selectors, then its
    ``selectors_to_remove``) must also survive into the block tree. MacTechNews
    wraps every body image in a lightbox anchor with no <p>/<figure> ancestor,
    which is exactly the shape that used to vanish."""
    with open(os.path.join(_FIXTURES_DIR, fixture_name)) as f:
        html = f.read()

    extracted = extract_main_content(
        html,
        aggregator_cls.content_selectors,
        aggregator_cls.selectors_to_remove,
        first_match_only=aggregator_cls.uses_first_content_match,
    )
    cleaned = clean_html(extracted)
    img_count = cleaned.count("<img")
    assert img_count > 0

    blocks = blocks_from_html(cleaned, base_url="https://example.com/article")
    assert _count_image_blocks(blocks) == img_count
