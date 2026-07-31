from bs4 import BeautifulSoup

from core.aggregators.utils.html_cleaner import (
    _get_base_filename,
    clean_html,
    remove_empty_elements,
    remove_image_by_url,
    sanitize_html_attributes,
)


class TestHtmlCleaner:
    def test_get_base_filename(self):
        assert _get_base_filename("image-780x438.jpg") == "image"
        assert _get_base_filename("image-1280x720-1.jpg") == "image"
        assert _get_base_filename("image-1280x720-1-780x438.jpg") == "image"
        assert _get_base_filename("merkur-1Wef.jpg") == "merkur"
        assert _get_base_filename("simple.png") == "simple"

    def test_sanitize_html_attributes_security(self):
        html = """
        <div>
            <script>alert('xss')</script>
            <object data="dangerous"></object>
            <embed src="dangerous">
            <iframe src="dangerous"></iframe>
            <style>body { color: red; }</style>
            <p onclick="alert('xss')" class="foo" style="color:blue" id="bar" data-test="val" data-src="keep">Text</p>
        </div>
        """
        soup = BeautifulSoup(html, "html.parser")
        sanitize_html_attributes(soup)

        result = str(soup)
        assert "<script>" not in result
        assert "<object" not in result
        assert "<embed" not in result
        assert "<iframe" not in result
        assert "<style>" not in result
        assert "onclick" not in result

        # Check attribute conversion
        assert 'data-sanitized-class="foo"' in result
        assert 'data-sanitized-style="color:blue"' in result
        assert 'data-sanitized-id="bar"' in result
        assert 'data-sanitized-test="val"' in result
        assert 'data-src="keep"' in result

        # Verify original attributes are removed (using more specific check to avoid substring match with data-sanitized-*)
        assert ' class="foo"' not in result
        assert ' style="color:blue"' not in result
        assert ' id="bar"' not in result

    def test_remove_image_by_url_exact(self):
        html = '<div><img src="https://ex.com/a.jpg"><img src="https://ex.com/b.jpg"></div>'
        soup = BeautifulSoup(html, "html.parser")
        remove_image_by_url(soup, "https://ex.com/a.jpg")
        assert "a.jpg" not in str(soup)
        assert "b.jpg" in str(soup)

    def test_remove_image_by_url_responsive(self):
        # Original is 1200x800, article has 780x438
        html = '<div><img src="https://ex.com/myimage-780x438.jpg"></div>'
        soup = BeautifulSoup(html, "html.parser")
        remove_image_by_url(soup, "https://ex.com/myimage-1200x800.jpg")
        assert "myimage-780x438.jpg" not in str(soup)

    def test_remove_image_by_url_merkur_pattern(self):
        html = '<div><img src="https://ex.com/mypicture-1Wef.jpg"></div>'
        soup = BeautifulSoup(html, "html.parser")
        remove_image_by_url(soup, "https://ex.com/mypicture-abc.jpg")
        assert "mypicture-1Wef.jpg" not in str(soup)

    def test_remove_empty_elements(self):
        html = '<div><p>  </p><p>Text</p><div><span></span></div><div><img src="a.jpg"></div></div>'
        soup = BeautifulSoup(html, "html.parser")
        remove_empty_elements(soup, ["p", "div", "span"])

        result = str(soup)
        assert "<p>Text</p>" in result
        assert '<img src="a.jpg"/>' in result
        assert "<p> </p>" not in result
        assert "<span></span>" not in result

    def test_clean_html_comments(self):
        html = "<div><!-- comment --><p>Text</p></div>"
        result = clean_html(html)
        assert "comment" not in result
        assert "<p>Text</p>" in result

    def test_remove_selectors(self):
        from core.aggregators.utils.html_cleaner import remove_selectors

        html = '<div><div class="ads">Ad</div><p>Content</p></div>'
        soup = BeautifulSoup(html, "html.parser")
        remove_selectors(soup, [".ads"])
        assert "Ad" not in str(soup)
        assert "<p>Content</p>" in str(soup)
