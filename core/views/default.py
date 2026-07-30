"""Default views for health checks."""

from django.db import connection
from django.http import JsonResponse
from django.views.decorators.http import require_http_methods


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
