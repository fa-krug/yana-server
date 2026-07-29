# <img src="core/static/core/img/logo-icon-only.svg" width="40" height="40" align="center" style="margin-right: 10px;"> Yana - RSS Aggregator

A modern, self-hosted RSS aggregator built with Django. Feeds are fetched by background tasks and managed through the Django admin.

## 🚀 User Guide: Setup & Run

The easiest way to get Yana up and running is using Docker.

### Prerequisites
- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)

### Quick Start

1.  **Create a folder for Yana:**
    ```bash
    mkdir yana
    cd yana
    ```

2.  **Create a `docker-compose.yml` file:**
    Create a new file named `docker-compose.yml` in this directory with the following content:

    ```yaml
    version: "3.8"
    services:
      yana:
        image: sascha384/yana:latest
        container_name: yana
        restart: unless-stopped
        ports:
          - "8000:8000"
        environment:
          - SECRET_KEY=change-me-securely
          - ALLOWED_HOSTS=*
          - TIME_ZONE=UTC
          # Default admin user
          - SUPERUSER_USERNAME=admin
          - SUPERUSER_EMAIL=admin@example.com
          - SUPERUSER_PASSWORD=password
        volumes:
          - yana_data:/app/data
          - yana_media:/app/media

    volumes:
      yana_data:
      yana_media:
    ```

3.  **Start the container:**
    ```bash
    docker-compose up -d
    ```

4.  **Access the application:**
    Open your browser and navigate to `http://localhost:8000/admin`.

### Configuration

Yana is configured via environment variables. You can create a `.env` file in the root directory (copy `.env.example` as a starting point).

**Key Environment Variables:**

| Variable | Description | Default |
|----------|-------------|---------|
| `SECRET_KEY` | Django secret key | `dev-secret-key...` |
| `ALLOWED_HOSTS` | Allowed hostnames | `*` |
| `TIME_ZONE` | Time zone | `UTC` |
| `SUPERUSER_USERNAME` | Admin username (created on startup) | `admin` |
| `SUPERUSER_EMAIL` | Admin email | `admin@example.com` |
| `SUPERUSER_PASSWORD` | Admin password | `password` |

### Default Credentials

If you used the default settings (or didn't change the superuser variables), you can log in with:
-   **Username:** `admin`
-   **Password:** `password`

### Clients

Yana currently has no HTTP API. Content is aggregated by background tasks and
inspected through the Django admin at `http://<your-server-ip>:8000/admin/`.

The Google Reader compatible API was removed: the first-party Yana app for
iOS/macOS is becoming the only client, and a tailored API is being designed to
replace it. Third-party RSS readers are not supported in the meantime.

---

## ✨ Features

-   **Self-Hosted & Private:** Keep your reading habits private. Runs on a single SQLite file with no external services -- no Redis, no database server.
-   **Multi-Source Aggregation:**
    -   Standard RSS/Atom feeds
    -   YouTube channels
    -   Reddit subreddits
    -   Podcasts
    -   Specialized scrapers for websites
-   **Background Processing:** Automatic feed updates using `django-q2`.
-   **Admin Interface:** Manage feeds, view fetching status, and trigger updates directly from the Django admin.

---

## 💻 Developer Guide

If you want to contribute or modify Yana, here is how to set up the development environment.

### Local Development Setup

**Requirements:** Python 3.13+ and [uv](https://docs.astral.sh/uv/).

1.  **Install dependencies:**
    ```bash
    uv sync --all-groups
    ```
    This creates `.venv/` and installs the exact versions pinned in `uv.lock`.
    Omit `--all-groups` to skip the test and lint tooling.

2.  **Run commands:**
    ```bash
    uv run python manage.py runserver
    ```
    `uv run` resolves the environment for you -- no `activate` step. Activating
    `.venv` manually also works if you prefer it.

3.  **Run migrations:**
    ```bash
    uv run python manage.py migrate
    ```

4.  **Create an admin user:**
    ```bash
    uv run python manage.py createsuperuser
    ```

5.  **Start the development server:**
    ```bash
    uv run python manage.py runserver
    ```

### Developing Aggregators

Yana uses a flexible aggregator system. New sources can be added by creating a class in `core/aggregators/`.

**Debugging Aggregators:**

The project includes a powerful CLI tool to test and debug aggregators without waiting for scheduled tasks.

```bash
# Quick test by feed ID (if it exists in DB)
uv run python manage.py test_aggregator 5

# Test by aggregator type with a custom URL (no DB entry needed)
uv run python manage.py test_aggregator heise "https://www.heise.de/"

# Detailed verbose output (raw HTML, logs)
uv run python manage.py test_aggregator 5 --verbose

# Dry-run (don't save articles to DB)
uv run python manage.py test_aggregator 5 --dry-run
```

See **CLAUDE.md** for more detailed debugging workflows.

### Project Architecture

-   **`core/models.py`**: `Feed`, `Article`, `FeedGroup`.
-   **`core/aggregators/`**: Content fetching logic.
    -   `registry.py`: Factory pattern for aggregators.
    -   `base.py`: Base classes for RSS, Full Website, etc.
-   **`core/services/`**: Business logic (aggregation triggers, article maintenance).

### Running Tests

```bash
# Run all tests
uv run python manage.py test

# Run specific test module
uv run python manage.py test core.tests.test_models
```

---

## ❓ Troubleshooting

**Docker Logs:**
If the container isn't starting, check logs:
```bash
docker-compose logs -f
```

**Database Reset (Dev):**
```bash
rm db.sqlite3
uv run python manage.py migrate
```

---

## 🤝 Contributing

Contributions are welcome! Please create a feature branch (`git checkout -b feature/my-feature`) and submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
