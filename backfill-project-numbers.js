'use strict';
// One-time, safe-to-re-run helper: for every site whose Name is purely
// numeric (e.g. "140", "145") and which doesn't already have a
// project_number set, copy that numeric name into project_number — since
// several of Zen's existing sites were using the Name field as a project
// number workaround before this feature existed.
//
// Defensive against duplicates: if a candidate number is already taken by
// another site (whether from an earlier run of this script or a number an
// admin already typed in via Edit), that site is SKIPPED, not overwritten,
// and printed in a "skipped" list at the end so it can be resolved by hand.
// Never touches the Name field itself — sites keep their existing name;
// only the new project_number column is filled in.
//
// Usage:
//   DATABASE_URL="<your Neon connection string>" node backfill-project-numbers.js
//
// Safe to run more than once — already-numbered sites are left untouched.

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Set DATABASE_URL to your Postgres connection string before running this script.');
  process.exit(1);
}

function wantsSsl(connectionString) {
  if (process.env.PGSSLMODE === 'disable') return false;
  if (/localhost|127\.0\.0\.1/.test(connectionString)) return false;
  return true;
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: wantsSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false,
});

async function main() {
  const { rows: sites } = await pool.query('SELECT id, name, project_number FROM sites ORDER BY id');

  const taken = new Set(sites.filter((s) => s.project_number != null).map((s) => Number(s.project_number)));

  const filled = [];
  const skippedTaken = [];
  const skippedNotNumeric = [];
  const alreadySet = [];

  for (const s of sites) {
    if (s.project_number != null) {
      alreadySet.push(s);
      continue;
    }
    const trimmed = (s.name || '').trim();
    if (!/^\d+$/.test(trimmed)) {
      skippedNotNumeric.push(s);
      continue;
    }
    const candidate = parseInt(trimmed, 10);
    if (taken.has(candidate)) {
      skippedTaken.push({ ...s, candidate });
      continue;
    }
    await pool.query('UPDATE sites SET project_number = $1 WHERE id = $2', [candidate, s.id]);
    taken.add(candidate);
    filled.push({ ...s, candidate });
  }

  console.log(`\nFilled in ${filled.length} project number(s):`);
  for (const s of filled) console.log(`  site ${s.id} "${s.name}" -> project_number ${s.candidate}`);

  if (skippedTaken.length) {
    console.log(`\nSkipped ${skippedTaken.length} site(s) — their numeric name is already taken by another site's project_number:`);
    for (const s of skippedTaken) console.log(`  site ${s.id} "${s.name}" wanted ${s.candidate}, but that's already in use — resolve manually via Edit`);
  }

  if (skippedNotNumeric.length) {
    console.log(`\nSkipped ${skippedNotNumeric.length} site(s) — name isn't purely numeric, so nothing to infer:`);
    for (const s of skippedNotNumeric) console.log(`  site ${s.id} "${s.name}"`);
  }

  if (alreadySet.length) {
    console.log(`\n${alreadySet.length} site(s) already had a project_number set and were left untouched.`);
  }

  console.log('\nDone.');
  await pool.end();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
