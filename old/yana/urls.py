"""Project-level URL configuration."""

from typing import Any, List

from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.shortcuts import redirect
from django.urls import include, path, re_path
from django.views.static import serve


def redirect_to_admin(request, *args, **kwargs):
    return redirect("admin:index")


urlpatterns: List[Any] = [
    path("admin/", admin.site.urls),
    path("", include("core.urls")),
]

# Serve media files via Django in both dev and prod (no Nginx sidecar)
urlpatterns += [
    re_path(r"^media/(?P<path>.*)$", serve, {"document_root": settings.MEDIA_ROOT}),
]

if settings.DEBUG:
    # In DEBUG, serve static files as well (Whitenoise handles this in prod)
    urlpatterns += static(settings.STATIC_URL, document_root=settings.STATIC_ROOT)

# Remove the catch-all redirect to admin to allow PWA to handle routes if needed,
# or keep it but ensure it doesn't conflict.
# Since pwa_index is at "", it should match first.
# But for sub-paths that don't match anything, redirecting to admin is fine.
urlpatterns += [
    re_path(r"^.*$", redirect_to_admin),
]
