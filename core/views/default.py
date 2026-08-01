"""Default views for health checks and proxies."""

from urllib.parse import urlencode, urlparse

from django.conf import settings
from django.db import connection
from django.http import HttpResponse, JsonResponse
from django.views.decorators.clickjacking import xframe_options_exempt
from django.views.decorators.http import require_http_methods

# YouTube requires the embedding page to identify itself via the HTTP Referer
# header; embeds served without one fail with "Error 153 - Video player
# configuration error". Django's SecurityMiddleware defaults SECURE_REFERRER_POLICY
# to "same-origin", which strips the Referer on the cross-origin request to
# youtube-nocookie.com, so the proxy pages must send their own policy.
EMBED_REFERRER_POLICY = "strict-origin-when-cross-origin"


def _embed_response(html, status=200):
    """Build an embed page response with a YouTube-compatible referrer policy."""
    response = HttpResponse(html, content_type="text/html", status=status)
    # Set explicitly so it wins over SecurityMiddleware, which only fills in
    # SECURE_REFERRER_POLICY when the response does not already carry one.
    response["Referrer-Policy"] = EMBED_REFERRER_POLICY
    return response


def _page_origin(request):
    """
    Return the origin of this page as the browser sees it.

    Prefers the scheme from BASE_URL when the request targets that host, because
    a reverse proxy that terminates TLS without setting X-Forwarded-Proto makes
    ``request.scheme`` report "http" for a page the browser loaded over HTTPS.
    A mismatching origin is rejected by the YouTube player.
    """
    host = request.get_host()
    base = urlparse(settings.BASE_URL)

    if base.scheme and base.netloc == host:
        return f"{base.scheme}://{base.netloc}"

    return f"{request.scheme}://{host}"


@xframe_options_exempt
@require_http_methods(["GET"])
def youtube_proxy_view(request):
    """
    Serve embedded YouTube videos via a privacy-enhanced proxy endpoint.

    This endpoint accepts a YouTube video ID and returns an HTML page with
    an embedded YouTube iframe using youtube-nocookie.com for privacy.

    Query Parameters:
        v (required): YouTube video ID
        autoplay (optional): Auto-play video (0 or 1, default: 0)
        loop (optional): Loop video (0 or 1, default: 0)
        mute (optional): Mute audio (0 or 1, default: 0)
        controls (optional): Show controls (0 or 1, default: 1)
        rel (optional): Show related videos (0 or 1, default: 0)
        modestbranding (optional): Minimal YouTube branding (0 or 1, default: 1)
        playsinline (optional): Play inline on mobile (0 or 1, default: 1)
        enablejsapi (optional): Enable the IFrame Player API (0 or 1, default: 0)

    Returns:
        HttpResponse: HTML page with YouTube iframe embed
        400: If video ID is missing
    """
    # Extract video ID (required)
    video_id = request.GET.get("v", "").strip()

    if not video_id:
        return _error_response("Error: Missing video ID parameter (?v=VIDEO_ID)")

    # Extract optional parameters with defaults
    autoplay = request.GET.get("autoplay", "0")
    loop = request.GET.get("loop", "0")
    mute = request.GET.get("mute", "0")
    controls = request.GET.get("controls", "1")
    rel = request.GET.get("rel", "0")
    modestbranding = request.GET.get("modestbranding", "1")
    playsinline = request.GET.get("playsinline", "1")
    enablejsapi = request.GET.get("enablejsapi", "0")

    # Build YouTube embed URL with parameters
    embed_params = {
        "autoplay": autoplay,
        "loop": loop,
        "mute": mute,
        "controls": controls,
        "rel": rel,
        "modestbranding": modestbranding,
        "playsinline": playsinline,
    }

    # The IFrame Player API is off by default: this page does not drive the
    # player from JavaScript, and enabling it makes YouTube validate the
    # "origin" parameter against the embedding page, which fails the whole
    # embed with error 153 whenever the two do not match exactly.
    if enablejsapi == "1":
        embed_params["enablejsapi"] = "1"
        embed_params["origin"] = _page_origin(request)

    # If loop is enabled, add playlist parameter (required by YouTube)
    if loop == "1":
        embed_params["playlist"] = video_id

    embed_url = f"https://www.youtube-nocookie.com/embed/{video_id}?{urlencode(embed_params)}"

    html = _generate_embed_html(embed_url)

    return _embed_response(html)


def _error_response(message):
    """Generate an error response page."""
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <title>YouTube Error - Yana</title>
    <link rel="icon" type="image/png" href="/static/core/img/icon.png">
    <link rel="apple-touch-icon" href="/static/core/img/apple-touch-icon.png">
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        html, body {{ width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: #000; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }}
        .error-message {{ color: #fff; text-align: center; padding: 20px; }}
        .error-message p {{ font-size: 18px; margin-bottom: 10px; }}
        .error-message code {{ background: #222; padding: 10px 15px; border-radius: 4px; display: inline-block; font-family: monospace; }}
    </style>
</head>
<body>
    <div class="error-message">
        <p>{message}</p>
        <code>GET /api/youtube-proxy?v=VIDEO_ID</code>
    </div>
</body>
</html>"""
    return _embed_response(html, status=400)


def _generate_embed_html(embed_url):
    """Generate HTML page with YouTube embed."""
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <meta name="referrer" content="strict-origin-when-cross-origin">
    <title>YouTube Video - Yana</title>
    <link rel="icon" type="image/png" href="/static/core/img/icon.png">
    <link rel="apple-touch-icon" href="/static/core/img/apple-touch-icon.png">
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}

        html, body {{
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: #000;
        }}

        .youtube-embed-container {{
            position: relative;
            width: 100%;
            height: 100%;
            padding-bottom: 56.25%;  /* 16:9 aspect ratio */
        }}

        .youtube-embed-container iframe {{
            border: 0;
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
        }}

        @media (max-width: 512px) {{
            .youtube-embed-container {{
                height: 100%;
                padding-bottom: 0;
            }}
        }}
    </style>
</head>
<body>
    <div class="youtube-embed-container">
        <iframe
            src="{embed_url}"
            width="560"
            height="315"
            allowfullscreen
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerpolicy="strict-origin-when-cross-origin"
        ></iframe>
    </div>
</body>
</html>"""
    return html


@xframe_options_exempt
@require_http_methods(["GET"])
def dailymotion_proxy_view(request):
    """
    Serve embedded Dailymotion videos via a proxy endpoint.

    Returns an HTML page with an embedded Dailymotion player iframe.

    Query Parameters:
        v (required): Dailymotion video ID

    Returns:
        HttpResponse: HTML page with Dailymotion iframe embed
        400: If video ID is missing
    """
    video_id = request.GET.get("v", "").strip()

    if not video_id:
        return _error_response("Error: Missing video ID parameter (?v=VIDEO_ID)")

    embed_url = f"https://geo.dailymotion.com/player.html?video={video_id}"

    html = _generate_dailymotion_embed_html(embed_url)

    return _embed_response(html)


def _generate_dailymotion_embed_html(embed_url):
    """Generate HTML page with Dailymotion embed."""
    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
    <meta name="referrer" content="strict-origin-when-cross-origin">
    <title>Dailymotion Video - Yana</title>
    <link rel="icon" type="image/png" href="/static/core/img/icon.png">
    <link rel="apple-touch-icon" href="/static/core/img/apple-touch-icon.png">
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}

        html, body {{
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: #000;
        }}

        .dailymotion-embed-container {{
            position: relative;
            width: 100%;
            height: 100%;
            padding-bottom: 56.25%;  /* 16:9 aspect ratio */
        }}

        .dailymotion-embed-container iframe {{
            border: 0;
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
        }}

        @media (max-width: 512px) {{
            .dailymotion-embed-container {{
                height: 100%;
                padding-bottom: 0;
            }}
        }}
    </style>
</head>
<body>
    <div class="dailymotion-embed-container">
        <iframe
            src="{embed_url}"
            width="560"
            height="315"
            allowfullscreen
            allow="autoplay; web-share"
            referrerpolicy="strict-origin-when-cross-origin"
        ></iframe>
    </div>
</body>
</html>"""
    return html


@require_http_methods(["GET"])
def health_check(request):
    """
    Health check endpoint for Docker and monitoring services.

    Returns a JSON response indicating the health status of the application,
    including database connectivity status.

    Returns:
        200: Application is healthy
        503: Application is unhealthy (database unreachable or other issues)
    """
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
        return JsonResponse({"status": "healthy", "database": "connected"})
    except Exception as e:
        return JsonResponse({"status": "unhealthy", "error": str(e)}, status=503)
