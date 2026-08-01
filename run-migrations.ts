import { applyPendingMigrations } from "./src/lib/db/migrate";
applyPendingMigrations();
console.log("Migrations applied");
