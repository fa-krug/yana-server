"""Core application URL configuration."""

from django.urls import include, path

from .default import urlpatterns as default_urlpatterns

# Start with default core app URLs
urlpatterns = default_urlpatterns
