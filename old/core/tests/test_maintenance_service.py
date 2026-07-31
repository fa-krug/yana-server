from unittest.mock import MagicMock, patch

from django.test import TestCase

from core.services.maintenance_service import MaintenanceService


class TestMaintenanceService(TestCase):
    def test_optimize_sqlite_success(self):
        """Test successful SQLite optimization."""
        with patch("django.db.connection.cursor") as mock_cursor:
            # Setup mock
            mock_cursor_context = MagicMock()
            mock_cursor.return_value.__enter__.return_value = mock_cursor_context

            # Call service
            result = MaintenanceService.optimize_sqlite()

            # Verify result
            self.assertTrue(result["success"])
            self.assertEqual(result["message"], "SQLite optimization completed successfully")

            # Verify PRAGMA optimize was called
            mock_cursor_context.execute.assert_called_once_with("PRAGMA optimize")

    def test_optimize_sqlite_failure(self):
        """Test SQLite optimization failure handling."""
        with patch("django.db.connection.cursor") as mock_cursor:
            # Setup mock to raise exception
            mock_cursor.side_effect = Exception("Database error")

            # Call service
            result = MaintenanceService.optimize_sqlite()

            # Verify result
            self.assertFalse(result["success"])
            self.assertEqual(result["message"], "SQLite optimization failed")
            self.assertEqual(result["error"], "Database error")
