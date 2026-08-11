'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
// LMS_DB_PATH lets the automated test suite (tests/role-matrix.test.js) run
// against a throwaway database on a separate port without ever touching the
// real data/lms.sqlite. Unset (the normal case), nothing changes.
const DB_PATH = process.env.LMS_DB_PATH || path.join(DATA_DIR, 'lms.sqlite');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

// NOTE on site numbering: sites.id is a plain INTEGER PRIMARY KEY (no
// AUTOINCREMENT keyword). SQLite still auto-assigns rowid = MAX(id)+1 when an
// insert omits id, so as long as the very first site (the "Unassigned Pool",
// id 100) is inserted explicitly by the seed script, every subsequent site
// created through the app (which never specifies an id) naturally lands in
// the 101-999 range. The CHECK constraint is a backstop against typos.
db.exec(`
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY CHECK(id BETWEEN 100 AND 999),
  name TEXT NOT NULL,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','on_hold','completed')),
  address TEXT,
  district TEXT,
  state TEXT,
  maps_link TEXT
);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  contact TEXT,
  whatsapp TEXT,
  email TEXT,
  address TEXT,
  is_direct INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS worker_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

-- v9.2: fine-grained skill assessment (Zen: "Mason skilled in Foundation,
-- Setting out, plastering, brick work" — more detail than the single overall
-- workers.skill_grade). Categories are scoped to a worker_type (Mason and
-- Helper each get their own relevant list, per Zen's explicit choice), and
-- managed like worker_types itself: admin-only, soft-disable rather than hard
-- delete (matches this app's deletion-safety philosophy everywhere else).
CREATE TABLE IF NOT EXISTS skill_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_type_id INTEGER NOT NULL REFERENCES worker_types(id),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(worker_type_id, name)
);

-- One rating per worker per skill category (general, not tied to a site —
-- per Zen's explicit choice), on the same trainee/skilled/expert scale as the
-- existing overall skill_grade for consistency. Re-rating a worker on a
-- category updates this row in place rather than accumulating a history.
CREATE TABLE IF NOT EXISTS worker_skill_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER NOT NULL REFERENCES workers(id),
  skill_category_id INTEGER NOT NULL REFERENCES skill_categories(id),
  rating TEXT NOT NULL CHECK(rating IN ('trainee','skilled','expert')),
  rated_by INTEGER REFERENCES users(id),
  rated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(worker_id, skill_category_id)
);

-- Role list (v10, per Zen's security/architecture review — seven supported
-- roles only; see src/permissions.js for the full grant matrix, the single
-- source of truth for what each role can actually do):
--   super_admin      — full system administration; the only role that may
--     create/edit/deactivate/reset another super_admin or an admin account
--   admin            — broad operational/administrative access; cannot
--     touch a super_admin account or promote anyone to super_admin
--   hr               — manage workers, attendance oversight
--   labor_manager    — logs payroll runs + site cuts/bonuses/additional
--     payments; internal identifier kept from before this review (see
--     ROLE_LABEL in permissions.js for why), displays as "Labour Manager"
--   audit_manager    — largely read-only: audit/attendance/payroll/reports
--   project_manager, site_engineer — assigned to MULTIPLE sites (see
--     user_site_assignments below), oversight-only: view dashboards/reports
--     for their assigned sites, cannot mark attendance
-- 'supervisor', 'operation_head', and 'ceo' remain in the CHECK constraint
-- below purely so historical rows (deactivated accounts, and anything they
-- attributed — attendance.marked_by, audit_log, etc.) stay valid and
-- readable; none of the three can be assigned to any account going forward
-- (enforced in permissions.js's ROLES list + the /users route validation in
-- app.js, not by removing them here — removing a value a stored row still
-- uses would make that row's role invalid for the CHECK constraint. See the
-- v10 migration further down for how 'super_admin' was added to an
-- already-deployed database.)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','hr','supervisor','project_manager','site_engineer','labor_manager','audit_manager','operation_head','ceo','super_admin')),
  site_id INTEGER REFERENCES sites(id),
  contact TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  -- v10: forced-password-change support for temporary/reset passwords —
  -- checked on every request once logged in (see the change-password gate
  -- in app.js), cleared the moment the user successfully sets a new one.
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Project Managers / Site Engineers can be assigned to many sites at once
-- (a PM might oversee 10+, a Site Engineer 1-3) — a plain many-to-many join,
-- separate from supervisor's single site_id above.
CREATE TABLE IF NOT EXISTS user_site_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, site_id)
);

CREATE TABLE IF NOT EXISTS workers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_code TEXT UNIQUE,
  name TEXT NOT NULL,
  worker_type_id INTEGER REFERENCES worker_types(id),
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  aadhar_number TEXT NOT NULL UNIQUE,
  site_id INTEGER NOT NULL REFERENCES sites(id) DEFAULT 100,
  wage_rate REAL NOT NULL DEFAULT 0,
  overtime_multiplier REAL NOT NULL DEFAULT 1.5,
  contact TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','inactive')) DEFAULT 'active',
  skill_grade TEXT CHECK(skill_grade IN ('trainee','skilled','expert')) DEFAULT 'skilled',
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending','verified')),
  joined_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per worker, per date, per site: a worker who splits a day between
-- two sites gets two rows for that date. hours_worked / leave_hours /
-- overtime_hours can all coexist on one row (e.g. 6h worked + 2h leave).
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id INTEGER NOT NULL REFERENCES workers(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  date TEXT NOT NULL,
  hours_worked REAL NOT NULL DEFAULT 0,
  leave_hours REAL NOT NULL DEFAULT 0,
  overtime_hours REAL NOT NULL DEFAULT 0,
  marked_by INTEGER REFERENCES users(id),
  marked_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(worker_id, date, site_id)
);

-- A site can be marked "off" for a specific date (holiday / no-work day) —
-- payroll generation excludes any attendance on that site+date from pay,
-- regardless of what (if anything) got logged for it.
CREATE TABLE IF NOT EXISTS site_off_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  date TEXT NOT NULL,
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(site_id, date)
);

-- Pay periods are fixed Thursday->Wednesday weeks (enforced in app.js).
-- status: labor_manager (or admin) generates a run at 'pending_verification';
-- audit_manager (or admin) marks it 'verified', then separately 'completed'
-- (i.e. actually paid out).
CREATE TABLE IF NOT EXISTS payroll_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  generated_by INTEGER REFERENCES users(id),
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending_verification' CHECK(status IN ('pending_verification','verified','completed')),
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  completed_by INTEGER REFERENCES users(id),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS payroll_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id),
  worker_id INTEGER NOT NULL REFERENCES workers(id),
  vendor_id INTEGER REFERENCES vendors(id),
  days_present REAL NOT NULL DEFAULT 0,
  leave_hours REAL NOT NULL DEFAULT 0,
  hours_worked REAL NOT NULL DEFAULT 0,
  overtime_hours REAL NOT NULL DEFAULT 0,
  base_pay REAL NOT NULL DEFAULT 0,
  overtime_pay REAL NOT NULL DEFAULT 0
);

-- Itemized adjustments on a worker's payroll item. A positive amount is a
-- deduction; a NEGATIVE amount is an addition (bonus / additional payment /
-- a refund of a mistaken cut) — same mechanism, opposite sign, both shown
-- itemized with their reason on the payroll item detail page.
CREATE TABLE IF NOT EXISTS payroll_deductions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_item_id INTEGER NOT NULL REFERENCES payroll_items(id),
  reason TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A per-site slice of one worker's payroll item, snapshotted at generation
-- time (a worker who split time across sites in the period gets one row per
-- site). This is what lets a payroll run be verified site by site instead of
-- all at once — net_pay already has that site's share of any cut/bonus/
-- additional_payment baked in. Runs generated before this feature has no
-- rows here (a "legacy" run) and falls back to the old whole-run verify.
CREATE TABLE IF NOT EXISTS payroll_item_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_item_id INTEGER NOT NULL REFERENCES payroll_items(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  hours_worked REAL NOT NULL DEFAULT 0,
  overtime_hours REAL NOT NULL DEFAULT 0,
  base_pay REAL NOT NULL DEFAULT 0,
  overtime_pay REAL NOT NULL DEFAULT 0,
  adjustments_total REAL NOT NULL DEFAULT 0,
  net_pay REAL NOT NULL DEFAULT 0,
  UNIQUE(payroll_item_id, site_id)
);

-- One row per site a payroll run touches, once an Audit Manager (or Admin)
-- verifies that site's slice. The run flips from pending_verification to
-- verified automatically once every site it touches has a row here.
CREATE TABLE IF NOT EXISTS payroll_run_site_verifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(payroll_run_id, site_id)
);

-- A site-level financial adjustment logged ahead of payroll for a fixed
-- Thursday->Wednesday pay period (enforced in app.js). Three kinds:
--   cut               — cut_percent of what each worker earned at the site
--                        in the overlapping period is deducted
--   bonus             — same mechanism as cut, but ADDED instead
--   additional_payment — a flat rupee amount (flat_amount), split across the
--                        site's workers proportional to hours worked in the
--                        overlapping period (e.g. refunding a mistaken cut)
-- All three become itemized payroll_deductions rows (bonus/additional_payment
-- as negative amounts) when a payroll run's period overlaps theirs.
CREATE TABLE IF NOT EXISTS site_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  adjustment_type TEXT NOT NULL DEFAULT 'cut' CHECK(adjustment_type IN ('cut','bonus','additional_payment')),
  cut_percent REAL CHECK(cut_percent IS NULL OR (cut_percent > 0 AND cut_percent <= 100)),
  flat_amount REAL CHECK(flat_amount IS NULL OR flat_amount > 0),
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
`);

// Lightweight migration for databases created before a column existed.
// CREATE TABLE IF NOT EXISTS above is a no-op on an already-existing table,
// so any column added after the initial release has to be backfilled here.
function columnExists(table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
}
// Checks the actual CREATE TABLE text on file for a marker string — used to
// detect whether a table still has an OLD schema (e.g. an old CHECK
// constraint) that ALTER TABLE ADD COLUMN can't fix, meaning it needs the
// full rebuild-and-swap treatment below.
function schemaHasMarker(table, marker) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table);
  return !!(row && row.sql && row.sql.includes(marker));
}

if (!columnExists('sites', 'status')) {
  db.exec(`ALTER TABLE sites ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','on_hold','completed'))`);
}
if (!columnExists('workers', 'skill_grade')) {
  db.exec(`ALTER TABLE workers ADD COLUMN skill_grade TEXT CHECK(skill_grade IN ('trainee','skilled','expert')) DEFAULT 'skilled'`);
}
if (!columnExists('vendors', 'active')) {
  db.exec(`ALTER TABLE vendors ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);
}
if (!columnExists('vendors', 'whatsapp')) {
  db.exec(`ALTER TABLE vendors ADD COLUMN whatsapp TEXT`);
}
if (!columnExists('vendors', 'email')) {
  db.exec(`ALTER TABLE vendors ADD COLUMN email TEXT`);
}
if (!columnExists('vendors', 'address')) {
  db.exec(`ALTER TABLE vendors ADD COLUMN address TEXT`);
}
if (!columnExists('workers', 'verification_status')) {
  db.exec(
    `ALTER TABLE workers ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending','verified'))`
  );
}
if (!columnExists('workers', 'worker_code')) {
  // SQLite can't add a UNIQUE column with ALTER TABLE, so add it plain and
  // enforce uniqueness with a separate index instead.
  db.exec(`ALTER TABLE workers ADD COLUMN worker_code TEXT`);
}
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_worker_code ON workers(worker_code) WHERE worker_code IS NOT NULL`);
// Backfill worker_code for any pre-existing rows (fresh installs get every
// worker coded on creation; upgrades from an older db need a one-time catch-up
// so nobody on record is left without an ID). Ordered by id so codes stay
// stable and monotonic across repeated runs.
{
  const uncoded = db.prepare('SELECT id FROM workers WHERE worker_code IS NULL ORDER BY id').all();
  if (uncoded.length > 0) {
    // Matches the current "W#####" format (v9.1) — any code assigned here
    // gets swept into the renumbering pass below anyway if it hasn't run yet,
    // but there's no reason to hand out a format that's about to be replaced.
    const maxRow = db
      .prepare(`SELECT MAX(CAST(SUBSTR(worker_code, 2) AS INTEGER)) m FROM workers WHERE worker_code GLOB 'W[0-9][0-9][0-9][0-9][0-9]'`)
      .get();
    let next = (maxRow && maxRow.m ? maxRow.m : 0) + 1;
    const updateCode = db.prepare('UPDATE workers SET worker_code = ? WHERE id = ?');
    for (const row of uncoded) {
      updateCode.run('W' + String(next).padStart(5, '0'), row.id);
      next++;
    }
  }
}

// ---- v8 migrations ----

// Sites: optional geo/address fields — plain nullable columns, no constraint
// changes, so a simple ADD COLUMN is safe.
if (!columnExists('sites', 'address')) db.exec(`ALTER TABLE sites ADD COLUMN address TEXT`);
if (!columnExists('sites', 'district')) db.exec(`ALTER TABLE sites ADD COLUMN district TEXT`);
if (!columnExists('sites', 'state')) db.exec(`ALTER TABLE sites ADD COLUMN state TEXT`);
if (!columnExists('sites', 'maps_link')) db.exec(`ALTER TABLE sites ADD COLUMN maps_link TEXT`);

// Payroll runs: approval workflow columns. New nullable/defaulted columns,
// safe via ADD COLUMN. Existing runs predate this workflow entirely, so
// they're backfilled straight to 'completed' (already-settled history) —
// only runs generated after this migration start at 'pending_verification'.
if (!columnExists('payroll_runs', 'status')) {
  db.exec(
    `ALTER TABLE payroll_runs ADD COLUMN status TEXT NOT NULL DEFAULT 'pending_verification' CHECK(status IN ('pending_verification','verified','completed'))`
  );
  db.exec(`ALTER TABLE payroll_runs ADD COLUMN verified_by INTEGER REFERENCES users(id)`);
  db.exec(`ALTER TABLE payroll_runs ADD COLUMN verified_at TEXT`);
  db.exec(`ALTER TABLE payroll_runs ADD COLUMN completed_by INTEGER REFERENCES users(id)`);
  db.exec(`ALTER TABLE payroll_runs ADD COLUMN completed_at TEXT`);
  db.exec(`UPDATE payroll_runs SET status = 'completed' WHERE status = 'pending_verification'`);
}

// Payroll runs: a run can be "flagged" (superseded/voided) so its wage
// period frees up for regeneration — a period otherwise can't be generated
// twice while an unflagged run for it still exists (see generatePayroll's
// duplicate-period guard in app.js). New nullable/defaulted columns, safe
// via ADD COLUMN.
if (!columnExists('payroll_runs', 'flagged')) {
  db.exec(`ALTER TABLE payroll_runs ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0`);
  db.exec(`ALTER TABLE payroll_runs ADD COLUMN flagged_by INTEGER REFERENCES users(id)`);
  db.exec(`ALTER TABLE payroll_runs ADD COLUMN flagged_at TEXT`);
  db.exec(`ALTER TABLE payroll_runs ADD COLUMN flagged_reason TEXT`);
}

// Users: new role list + mandatory-going-forward contact phone. SQLite can't
// alter an existing CHECK constraint or add a NOT-NULL-free column mid-table
// via ALTER TABLE, so this rebuilds the table under a temp name, copies every
// row across untouched (contact simply starts NULL for existing users — the
// app requires it be filled in next time their profile is saved), drops the
// old table, and renames the new one into place. Wrapped in a transaction
// with foreign_keys off so no other table's REFERENCES users(id) is disturbed
// mid-flight. Guarded so it only runs once, on a database that still has the
// old 3-role CHECK constraint (a fresh install's CREATE TABLE above already
// has the new schema, so this block is a no-op for it).
if (!schemaHasMarker('users', 'labor_manager')) {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN TRANSACTION;');
  db.exec(`
    CREATE TABLE users_v8_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','hr','supervisor','project_manager','site_engineer','labor_manager','audit_manager','operation_head','ceo')),
      site_id INTEGER REFERENCES sites(id),
      contact TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`
    INSERT INTO users_v8_new (id, username, password_hash, salt, name, role, site_id, active, created_at)
    SELECT id, username, password_hash, salt, name, role, site_id, active, created_at FROM users;
  `);
  db.exec('DROP TABLE users;');
  db.exec('ALTER TABLE users_v8_new RENAME TO users;');
  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys = ON;');
}

// v10: add 'super_admin' to the role CHECK constraint (a genuinely new role
// — see permissions.js). Same rebuild-and-swap technique as the block above,
// for the same reason (SQLite can't ALTER an existing CHECK). Every existing
// row's role value is untouched and still satisfies the new, wider
// constraint, so nothing here changes who's active or what role anyone
// currently has — this migration only makes 'super_admin' a legal value
// going forward. Guarded so it only runs once, on a database that doesn't
// yet have 'super_admin' in this table's CHECK.
if (!schemaHasMarker('users', 'super_admin')) {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN TRANSACTION;');
  db.exec(`
    CREATE TABLE users_v10_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','hr','supervisor','project_manager','site_engineer','labor_manager','audit_manager','operation_head','ceo','super_admin')),
      site_id INTEGER REFERENCES sites(id),
      contact TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`
    INSERT INTO users_v10_new (id, username, password_hash, salt, name, role, site_id, contact, active, created_at)
    SELECT id, username, password_hash, salt, name, role, site_id, contact, active, created_at FROM users;
  `);
  db.exec('DROP TABLE users;');
  db.exec('ALTER TABLE users_v10_new RENAME TO users;');
  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys = ON;');
}

// v10: forced-password-change support. A plain ADD COLUMN (no CHECK, has a
// default) — unlike the role widening above, this doesn't need a rebuild.
if (!columnExists('users', 'must_change_password')) {
  db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`);
}

// Site performance: now covers cut / bonus / a flat additional_payment, so
// cut_percent has to become nullable (an additional_payment row has no
// percentage) and a new flat_amount column is needed. Same rebuild-and-swap
// technique as users above, for the same reason (loosening an existing CHECK/
// NOT NULL constraint isn't something ALTER TABLE can do). Every pre-existing
// row is a plain wage cut, so it maps straight across as adjustment_type='cut'.
if (!schemaHasMarker('site_performance', 'adjustment_type')) {
  db.exec('PRAGMA foreign_keys = OFF;');
  db.exec('BEGIN TRANSACTION;');
  db.exec(`
    CREATE TABLE site_performance_v8_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id),
      period_start TEXT NOT NULL,
      period_end TEXT NOT NULL,
      adjustment_type TEXT NOT NULL DEFAULT 'cut' CHECK(adjustment_type IN ('cut','bonus','additional_payment')),
      cut_percent REAL CHECK(cut_percent IS NULL OR (cut_percent > 0 AND cut_percent <= 100)),
      flat_amount REAL CHECK(flat_amount IS NULL OR flat_amount > 0),
      reason TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.exec(`
    INSERT INTO site_performance_v8_new (id, site_id, period_start, period_end, adjustment_type, cut_percent, flat_amount, reason, created_by, created_at)
    SELECT id, site_id, period_start, period_end, 'cut', cut_percent, NULL, reason, created_by, created_at FROM site_performance;
  `);
  db.exec('DROP TABLE site_performance;');
  db.exec('ALTER TABLE site_performance_v8_new RENAME TO site_performance;');
  db.exec('COMMIT;');
  db.exec('PRAGMA foreign_keys = ON;');
}

// ---- v8.2 migrations ----

// A generic audit trail — one row per significant mutation across the app
// (worker/vendor/user/site create-edit-disable, payroll generate/verify/
// complete/flag, site-performance/site-off create-remove, etc). `details` is
// free-text (usually "what changed" or the affected record's name) rather
// than a structured diff, kept intentionally simple. New table, no migration
// needed.
db.exec(`
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Simple login-attempt lockout: a failed username+password combo increments
// a counter; too many failures within a short window locks that username out
// for a cooldown period, regardless of source IP (keeps it simple for a
// small internal user base).
db.exec(`
CREATE TABLE IF NOT EXISTS login_attempts (
  username TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);
`);

// ---- v9 migrations ----

// Small key/value table for one-off migration markers that can't be inferred
// safely from data shape alone (e.g. a renumbering pass that must run exactly
// once, even if a later manual edit makes the data look "not yet migrated"
// again). New table, no data to migrate into it.
db.exec(`
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);
function metaGet(key) {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key);
  return row ? row.value : null;
}
function metaSet(key, value) {
  db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// Regular vendor codes move from "VEN-001"-style (3-digit) to "V0001"-style
// (4-digit, no dash), per Zen's request, to match the worker_code ("WRK-0001")
// and Direct-vendor ("B0001") numbering conventions. Existing vendors are
// renumbered too (not just new ones going forward) — vendor_code isn't a
// foreign key anywhere in the schema (workers/payroll reference vendor_id,
// the integer), so this is a display-value-only change with no cascading
// effect on data integrity. The built-in Direct vendor (is_direct = 1) keeps
// its own fixed code untouched. Renumbered in id order (creation order) so
// the result is stable and reproducible. Guarded by a schema_meta marker
// (rather than re-checking the data shape) so it runs exactly once, ever —
// even if a vendor's code is later hand-edited on the Vendor edit page into
// something that no longer matches the new "V####" pattern, this migration
// won't fire again and clobber that deliberate edit.
if (!metaGet('vendor_code_v9_renumbered')) {
  const regularVendors = db.prepare('SELECT id FROM vendors WHERE is_direct = 0 ORDER BY id').all();
  const updateCode = db.prepare('UPDATE vendors SET vendor_code = ? WHERE id = ?');
  let next = 1;
  for (const v of regularVendors) {
    updateCode.run('V' + String(next).padStart(4, '0'), v.id);
    next++;
  }
  metaSet('vendor_code_v9_renumbered', '1');
}

// ---- v9.1 migration ----

// Worker codes move from "WRK-0001"-style (4-digit) to "W00001"-style
// (5-digit, no dash), per Zen's explicit request to "reassign all Worker
// IDs." Same treatment as the vendor renumbering above: ALL existing workers
// are renumbered (not just new ones going forward), in id (creation) order,
// safe because worker_code is not a foreign key anywhere — attendance and
// payroll_items both reference worker_id, the integer (confirmed by reading
// every "REFERENCES workers" in this file) — so this is a display-value-only
// change with no cascading effect on data integrity. Guarded by its own
// schema_meta marker so it runs exactly once, ever — a worker_code hand-typed
// or edited later into some other shape is never clobbered by a re-run
// (worker_code has no edit UI today, but the marker-not-data-shape guard is
// the same defensive pattern as the vendor migration regardless).
if (!metaGet('worker_code_v9_1_renumbered')) {
  const allWorkers = db.prepare('SELECT id FROM workers ORDER BY id').all();
  const updateCode = db.prepare('UPDATE workers SET worker_code = ? WHERE id = ?');
  let next = 1;
  for (const w of allWorkers) {
    updateCode.run('W' + String(next).padStart(5, '0'), w.id);
    next++;
  }
  metaSet('worker_code_v9_1_renumbered', '1');
}

// ---- v9.3 migration ----

// Default skill categories for Mason & Helper, per Zen's explicit list — so
// the admin doesn't have to type these in by hand via "Manage skill
// categories" before anyone can rate a worker. Both worker types share the
// same 5-category set.
//
// Deliberately NOT marker-gated like the renumbering migrations above.
// INSERT OR IGNORE against the UNIQUE(worker_type_id, name) constraint is
// naturally idempotent — once a category row exists (even later disabled by
// an admin), this is a permanent no-op for it, so a marker would add nothing.
// Running it on every boot also self-heals the seed.js -> server.js two-
// process startup order: seed.js's own require of this module fires before
// its seed() function has inserted the Mason/Helper worker_types rows, so
// this block is a no-op there; server.js's later, separate require of this
// module (same database, new process) finds those rows and seeds the
// categories then. Any other worker type is untouched — an admin adds its
// categories by hand.
const DEFAULT_SKILL_CATEGORIES = {
  mason: ['Brickwork', 'Plastering', 'Centering', 'Shuttering & Setting-Out', 'Ability to Calculate & Read Drawings'],
  helper: ['Brickwork', 'Plastering', 'Centering', 'Shuttering & Setting-Out', 'Ability to Calculate & Read Drawings'],
};
{
  const insertDefaultCat = db.prepare('INSERT OR IGNORE INTO skill_categories (worker_type_id, name) VALUES (?, ?)');
  for (const t of db.prepare('SELECT id, name FROM worker_types').all()) {
    const defaults = DEFAULT_SKILL_CATEGORIES[String(t.name).trim().toLowerCase()];
    if (!defaults) continue;
    for (const catName of defaults) insertDefaultCat.run(t.id, catName);
  }
}

// ---- v9.4: indexes + a defense-in-depth constraint ----
//
// SQLite does NOT auto-index foreign keys. These tables are the ones that
// grow continuously (attendance is written every marking day; payroll_items
// every pay period) and are filtered/joined on worker_id/site_id/
// payroll_run_id constantly across the app (attendance history, payroll
// lists, per-worker rating lookups). At today's scale (a few hundred
// workers) a full scan is invisible, but this is cheap to add now and avoids
// a slow-query surprise later as history accumulates. CREATE INDEX IF NOT
// EXISTS is idempotent, so this is safe to run on every boot.
db.exec(`
CREATE INDEX IF NOT EXISTS idx_attendance_worker ON attendance(worker_id);
CREATE INDEX IF NOT EXISTS idx_attendance_site_date ON attendance(site_id, date);
CREATE INDEX IF NOT EXISTS idx_workers_site ON workers(site_id);
CREATE INDEX IF NOT EXISTS idx_workers_vendor ON workers(vendor_id);
CREATE INDEX IF NOT EXISTS idx_workers_type ON workers(worker_type_id);
CREATE INDEX IF NOT EXISTS idx_payroll_items_run ON payroll_items(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_items_worker ON payroll_items(worker_id);
CREATE INDEX IF NOT EXISTS idx_payroll_item_sites_item ON payroll_item_sites(payroll_item_id);
CREATE INDEX IF NOT EXISTS idx_skill_ratings_worker ON worker_skill_ratings(worker_id);
`);

// /payroll/generate's duplicate-period check (app.js) is application-level
// only: SELECT-then-INSERT with no DB constraint behind it. It's safe today
// only because nothing awaits between the check and the insert — a future
// change that added an await in between (e.g. an external audit call) could
// let two concurrent "Generate payroll" submits create two runs for the same
// week with nothing to catch it. This partial unique index closes that gap
// as a backstop, mirroring the app's own "AND flagged = 0" condition exactly
// (a flagged run intentionally doesn't block regenerating that period).
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_runs_period_unflagged
  ON payroll_runs(period_start, period_end) WHERE flagged = 0;
`);

module.exports = db;
