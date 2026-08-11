'use strict';
// The app now runs on Postgres (Neon in production), not a local SQLite
// file, so a file-copy backup no longer makes sense. Neon provides its own
// point-in-time restore and database branching features — use those
// instead. This script is kept as a harmless no-op because `npm run backup`
// still references it.

console.log("Postgres-hosted databases don't need this file-copy backup — use Neon's built-in point-in-time restore/branching instead.");
