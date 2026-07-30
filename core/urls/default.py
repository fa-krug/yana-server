"""Default URL configuration for core app."""

from django.urls import path

from core import views

urlpatterns = [
    path("health/", views.health_check, name="health_check"),
]
