#!/bin/sh
set -e

echo "=== Yana startup ==="

# No database wait: SQLite is a local file, so nothing has to become reachable.
echo "Applying migrations..."
node -e "
const Database = require('better-sqlite3');
const { drizzle } = require('drizzle-orm/better-sqlite3');
const { migrate } = require('drizzle-orm/better-sqlite3/migrator');
const db = drizzle(new Database(process.env.DATABASE_PATH));
migrate(db, { migrationsFolder: './drizzle' });
console.log('Migrations applied.');
" || { echo 'ERROR: migration failed'; exit 1; }

echo "Starting: $@"
exec "$@"
