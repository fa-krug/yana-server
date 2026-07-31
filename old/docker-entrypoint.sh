#!/bin/bash
set -e

echo "=== Yana Django Application Startup ==="

# No database wait step: SQLite is a local file, so there is no server to
# become reachable.

# Run database migrations
echo "Running database migrations..."
python manage.py migrate --noinput || {
    echo "ERROR: Database migration failed"
    exit 1
}

# Collect static files (production)
if [ "$DEBUG" = "False" ]; then
    echo "Collecting static files..."
    python manage.py collectstatic --noinput --clear || {
        echo "WARNING: Static file collection failed, continuing anyway..."
    }
fi

# Create superuser if environment variables are set
if [ -n "$SUPERUSER_USERNAME" ] && [ -n "$SUPERUSER_PASSWORD" ] && [ -n "$SUPERUSER_EMAIL" ]; then
    echo "Checking for superuser..."
    python manage.py shell << EOF
from django.contrib.auth import get_user_model
User = get_user_model()

if not User.objects.filter(username='$SUPERUSER_USERNAME').exists():
    User.objects.create_superuser(
        username='$SUPERUSER_USERNAME',
        email='$SUPERUSER_EMAIL',
        password='$SUPERUSER_PASSWORD'
    )
    print('Superuser created: $SUPERUSER_USERNAME')
else:
    print('Superuser already exists: $SUPERUSER_USERNAME')
EOF
fi

# Execute the main command (supervisord or custom command)
echo "Starting application: $@"
exec "$@"
