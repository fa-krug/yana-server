"""HTML -> blocks: the Python port of iOS's BlockParser."""

from core.aggregators.utils.block_parser import blocks_from_html, plain_text
from core.blocks.types import (
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
    """Table cells must not leak in as stray paragraphs -- that is the whole
    reason drop-vs-recurse exists."""
    html = "<table><tbody><tr><td><p>cell</p></td></tr></tbody></table><p>real</p>"
    assert blocks_from_html(html) == [Paragraph(runs=[InlineRun(text="real")])]


def test_every_dropped_tag_is_dropped():
    for tag in ("form", "button", "select", "textarea", "noscript", "iframe", "audio", "canvas"):
        assert blocks_from_html(f"<{tag}><p>x</p></{tag}>") == [], tag


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


def test_plain_text_walks_lists_quotes_captions_and_code():
    html = (
        "<ul><li>item</li></ul>"
        "<blockquote><p>quote</p></blockquote>"
        '<figure><img src="yana-img://a"><figcaption>cap</figcaption></figure>'
        "<pre>code</pre>"
    )
    assert plain_text(blocks_from_html(html)) == "item\n\nquote\n\ncap\n\ncode"


YOUTUBE_FACADE = (
    '<div data-sanitized-class="youtube-embed-container">'
    '<iframe src="https://yana.example/api/youtube-proxy?v=dQw4w9WgXcQ"></iframe>'
    "</div>"
)


def test_youtube_proxy_facade_becomes_a_youtube_embed():
    assert blocks_from_html(YOUTUBE_FACADE) == [
        EmbedBlock(
            provider="youtube",
            external_url="https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        )
    ]


def test_youtube_facade_is_found_through_an_unsanitized_class():
    html = YOUTUBE_FACADE.replace("data-sanitized-class", "class")
    assert blocks_from_html(html)[0].provider == "youtube"


def test_youtube_facade_is_found_inside_a_header_wrapper():
    html = f'<header style="x">{YOUTUBE_FACADE}</header>'
    assert blocks_from_html(html)[0].provider == "youtube"


def test_youtube_facade_external_url_never_points_at_the_proxy():
    """Task 12 deletes the proxy views; nothing stored may reference them."""
    embed = blocks_from_html(YOUTUBE_FACADE)[0]
    assert "youtube-proxy" not in embed.external_url
    assert embed.external_url.startswith("https://www.youtube.com/watch?v=")


def test_youtube_facade_takes_its_thumbnail_from_a_poster_image():
    ref = "yana-img://" + "1" * 64
    html = (
        '<div data-sanitized-class="youtube-embed">'
        f'<img src="{ref}">'
        '<iframe src="/api/youtube-proxy?v=abcdefghijk"></iframe>'
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


def test_dailymotion_proxy_facade_becomes_a_dailymotion_embed():
    html = (
        '<div data-sanitized-class="dailymotion-embed-container">'
        '<iframe src="https://yana.example/api/dailymotion-proxy?v=x8abcde"></iframe>'
        "</div>"
    )
    assert blocks_from_html(html) == [
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


def test_video_fallback_text_never_leaks_into_a_paragraph():
    html = "<p>before</p><video><source src='https://v/x.mp4'>Your browser…</video>"
    blocks = blocks_from_html(html)
    assert [type(block) for block in blocks] == [Paragraph, EmbedBlock]
    assert "browser" not in plain_text(blocks)


def test_tagesschau_style_video_header_is_found_through_its_wrappers():
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


def test_blockquote_linking_elsewhere_stays_a_blockquote():
    html = '<blockquote><p><a href="https://example.com/a">link</a></p></blockquote>'
    assert isinstance(blocks_from_html(html)[0], Blockquote)


def test_plain_text_uses_an_embed_title():
    html = (
        '<blockquote><p>tweet text</p><a href="https://x.com/w/status/1">View on X</a></blockquote>'
    )
    assert "tweet text" in plain_text(blocks_from_html(html))
