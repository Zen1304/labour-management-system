'use strict';
const { Pool } = require('pg');

// Postgres connection. Neon (production) requires SSL; a local Postgres used
// for development/testing does not offer it. Detect localhost/127.0.0.1 in
// the connection string (or an explicit PGSSLMODE=disable escape hatch) and
// skip SSL only in that case — everything else (Neon, Render-hosted PG,
// etc.) gets SSL with rejectUnauthorized:false (Neon's certs are valid but
// this keeps things working across various managed-PG SSL setups without
// needing the CA bundle wired in).
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/lms_test';

function wantsSsl(connectionString) {
  if (process.env.PGSSLMODE === 'disable') return false;
  if (/localhost|127\.0\.0\.1/.test(connectionString)) return false;
  return true;
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: wantsSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  // Idle client errors (e.g. a dropped connection) shouldn't crash the
  // whole process — the pool will create a fresh connection on next use.
  console.error('Unexpected Postgres pool error:', err);
});

// SQLite's datetime('now') produced 'YYYY-MM-DD HH:MM:SS' strings, and the
// rest of the app (string slicing/comparison/display) depends on that exact
// format. All *_at/*_date TEXT columns below have no DB-side default now —
// every INSERT that needs "now" calls this helper explicitly from JS.
function nowSqliteStyle() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// NOTE on site numbering: sites.id is a plain INTEGER PRIMARY KEY. A
// dedicated sequence (starting at 101, well past the seeded "Unassigned
// Pool" id 100) backs the DEFAULT, so inserts that omit id still auto-number
// sequentially, exactly mirroring SQLite's old rowid-assignment behavior.
// The CHECK constraint remains a backstop against typos / out-of-range ids.
async function init() {
  await pool.query(`
CREATE SEQUENCE IF NOT EXISTS sites_id_seq START 101;

CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY DEFAULT nextval('sites_id_seq') CHECK(id BETWEEN 100 AND 999),
  name TEXT NOT NULL,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','on_hold','completed')),
  address TEXT,
  district TEXT,
  state TEXT,
  maps_link TEXT
);

ALTER SEQUENCE sites_id_seq OWNED BY sites.id;

CREATE TABLE IF NOT EXISTS vendors (
  id SERIAL PRIMARY KEY,
  vendor_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  contact TEXT,
  whatsapp TEXT,
  email TEXT,
  address TEXT,
  is_direct INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS worker_types (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
`);
  // skill_categories/worker_skill_ratings reference workers(id)/users(id),
  // which don't exist yet at this point — Postgres (unlike SQLite by
  // default) validates FK targets at CREATE TABLE time, so those two tables
  // are defined further below, after workers/users exist.
  await pool.query(`
-- Role list (v10): seven supported roles (super_admin, admin, hr,
-- labor_manager, audit_manager, project_manager, site_engineer) — see
-- src/permissions.js for the full grant matrix, the single source of truth
-- for what each role can actually do. 'supervisor', 'operation_head', and
-- 'ceo' remain in the CHECK purely so any legacy attribution stays valid;
-- none of the three can be assigned to any account going forward (enforced
-- in permissions.js + the /users route, not here).
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','hr','supervisor','project_manager','site_engineer','labor_manager','audit_manager','operation_head','ceo','super_admin')),
  site_id INTEGER REFERENCES sites(id),
  contact TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  -- forced-password-change support for temporary/reset passwords — checked
  -- on every request once logged in, cleared the moment the user
  -- successfully sets a new one.
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- Project Managers / Site Engineers can be assigned to many sites at once —
-- a plain many-to-many join, separate from a single site_id.
CREATE TABLE IF NOT EXISTS user_site_assignments (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  created_at TEXT NOT NULL,
  UNIQUE(user_id, site_id)
);

CREATE TABLE IF NOT EXISTS workers (
  id SERIAL PRIMARY KEY,
  worker_code TEXT,
  name TEXT NOT NULL,
  worker_type_id INTEGER REFERENCES worker_types(id),
  vendor_id INTEGER NOT NULL REFERENCES vendors(id),
  aadhar_number TEXT NOT NULL UNIQUE,
  site_id INTEGER NOT NULL REFERENCES sites(id) DEFAULT 100,
  wage_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
  overtime_multiplier DOUBLE PRECISION NOT NULL DEFAULT 1.5,
  contact TEXT,
  status TEXT NOT NULL CHECK(status IN ('active','inactive')) DEFAULT 'active',
  skill_grade TEXT CHECK(skill_grade IN ('trainee','skilled','expert')) DEFAULT 'skilled',
  verification_status TEXT NOT NULL DEFAULT 'pending' CHECK(verification_status IN ('pending','verified')),
  joined_date TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workers_worker_code ON workers(worker_code) WHERE worker_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS skill_categories (
  id SERIAL PRIMARY KEY,
  worker_type_id INTEGER NOT NULL REFERENCES worker_types(id),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(worker_type_id, name)
);

CREATE TABLE IF NOT EXISTS worker_skill_ratings (
  id SERIAL PRIMARY KEY,
  worker_id INTEGER NOT NULL REFERENCES workers(id),
  skill_category_id INTEGER NOT NULL REFERENCES skill_categories(id),
  rating TEXT NOT NULL CHECK(rating IN ('trainee','skilled','expert')),
  rated_by INTEGER REFERENCES users(id),
  rated_at TEXT NOT NULL,
  UNIQUE(worker_id, skill_category_id)
);

-- One row per worker, per date, per site: a worker who splits a day between
-- two sites gets two rows for that date.
CREATE TABLE IF NOT EXISTS attendance (
  id SERIAL PRIMARY KEY,
  worker_id INTEGER NOT NULL REFERENCES workers(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  date TEXT NOT NULL,
  hours_worked DOUBLE PRECISION NOT NULL DEFAULT 0,
  leave_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  overtime_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  marked_by INTEGER REFERENCES users(id),
  marked_at TEXT NOT NULL,
  UNIQUE(worker_id, date, site_id)
);

-- A site can be marked "off" for a specific date (holiday / no-work day) —
-- payroll generation excludes any attendance on that site+date from pay.
CREATE TABLE IF NOT EXISTS site_off_days (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  date TEXT NOT NULL,
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE(site_id, date)
);

-- Pay periods are fixed Thursday->Wednesday weeks (enforced in app.js).
CREATE TABLE IF NOT EXISTS payroll_runs (
  id SERIAL PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  generated_by INTEGER REFERENCES users(id),
  generated_at TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending_verification' CHECK(status IN ('pending_verification','verified','completed')),
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  completed_by INTEGER REFERENCES users(id),
  completed_at TEXT,
  -- A run can be "flagged" (superseded/voided) so its wage period frees up
  -- for regeneration.
  flagged INTEGER NOT NULL DEFAULT 0,
  flagged_by INTEGER REFERENCES users(id),
  flagged_at TEXT,
  flagged_reason TEXT
);

CREATE TABLE IF NOT EXISTS payroll_items (
  id SERIAL PRIMARY KEY,
  payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id),
  worker_id INTEGER NOT NULL REFERENCES workers(id),
  vendor_id INTEGER REFERENCES vendors(id),
  days_present DOUBLE PRECISION NOT NULL DEFAULT 0,
  leave_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  hours_worked DOUBLE PRECISION NOT NULL DEFAULT 0,
  overtime_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  base_pay DOUBLE PRECISION NOT NULL DEFAULT 0,
  overtime_pay DOUBLE PRECISION NOT NULL DEFAULT 0
);

-- Itemized adjustments on a worker's payroll item. A positive amount is a
-- deduction; a NEGATIVE amount is an addition (bonus / additional payment /
-- a refund of a mistaken cut).
CREATE TABLE IF NOT EXISTS payroll_deductions (
  id SERIAL PRIMARY KEY,
  payroll_item_id INTEGER NOT NULL REFERENCES payroll_items(id),
  reason TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- A per-site slice of one worker's payroll item, snapshotted at generation
-- time. Lets a payroll run be verified site by site instead of all at once.
CREATE TABLE IF NOT EXISTS payroll_item_sites (
  id SERIAL PRIMARY KEY,
  payroll_item_id INTEGER NOT NULL REFERENCES payroll_items(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  hours_worked DOUBLE PRECISION NOT NULL DEFAULT 0,
  overtime_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  base_pay DOUBLE PRECISION NOT NULL DEFAULT 0,
  overtime_pay DOUBLE PRECISION NOT NULL DEFAULT 0,
  adjustments_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  net_pay DOUBLE PRECISION NOT NULL DEFAULT 0,
  UNIQUE(payroll_item_id, site_id)
);

-- One row per site a payroll run touches, once an Audit Manager (or Admin)
-- verifies that site's slice. The run flips from pending_verification to
-- verified automatically once every site it touches has a row here.
CREATE TABLE IF NOT EXISTS payroll_run_site_verifications (
  id SERIAL PRIMARY KEY,
  payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id),
  site_id INTEGER NOT NULL REFERENCES sites(id),
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT NOT NULL,
  UNIQUE(payroll_run_id, site_id)
);

-- A site-level financial adjustment logged ahead of payroll for a fixed
-- Thursday->Wednesday pay period. Three kinds: cut, bonus, additional_payment.
CREATE TABLE IF NOT EXISTS site_performance (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  adjustment_type TEXT NOT NULL DEFAULT 'cut' CHECK(adjustment_type IN ('cut','bonus','additional_payment')),
  cut_percent DOUBLE PRECISION CHECK(cut_percent IS NULL OR (cut_percent > 0 AND cut_percent <= 100)),
  flat_amount DOUBLE PRECISION CHECK(flat_amount IS NULL OR flat_amount > 0),
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- A generic audit trail — one row per significant mutation across the app.
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  details TEXT,
  created_at TEXT NOT NULL
);

-- Simple login-attempt lockout: a failed username+password combo increments
-- a counter; too many failures within a short window locks that username out
-- for a cooldown period, regardless of source IP.
CREATE TABLE IF NOT EXISTS login_attempts (
  username TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_attendance_worker ON attendance(worker_id);
CREATE INDEX IF NOT EXISTS idx_attendance_site_date ON attendance(site_id, date);
CREATE INDEX IF NOT EXISTS idx_workers_site ON workers(site_id);
CREATE INDEX IF NOT EXISTS idx_workers_vendor ON workers(vendor_id);
CREATE INDEX IF NOT EXISTS idx_workers_type ON workers(worker_type_id);
CREATE INDEX IF NOT EXISTS idx_payroll_items_run ON payroll_items(payroll_run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_items_worker ON payroll_items(worker_id);
CREATE INDEX IF NOT EXISTS idx_payroll_item_sites_item ON payroll_item_sites(payroll_item_id);
CREATE INDEX IF NOT EXISTS idx_skill_ratings_worker ON worker_skill_ratings(worker_id);

-- /payroll/generate's duplicate-period check is application-level only
-- (SELECT-then-INSERT). This partial unique index is a backstop against a
-- race creating two runs for the same week, mirroring the app's own
-- "AND flagged = 0" condition exactly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_runs_period_unflagged
  ON payroll_runs(period_start, period_end) WHERE flagged = 0;
`);

  // Default skill categories for Mason & Helper, per Zen's explicit list —
  // idempotent seed data (ON CONFLICT DO NOTHING against the
  // UNIQUE(worker_type_id, name) constraint), safe to run on every boot.
  const DEFAULT_SKILL_CATEGORIES = {
    mason: ['Brickwork', 'Plastering', 'Centering', 'Shuttering & Setting-Out', 'Ability to Calculate & Read Drawings'],
    helper: ['Brickwork', 'Plastering', 'Centering', 'Shuttering & Setting-Out', 'Ability to Calculate & Read Drawings'],
  };
  const { rows: workerTypes } = await pool.query('SELECT id, name FROM worker_types');
  for (const t of workerTypes) {
    const defaults = DEFAULT_SKILL_CATEGORIES[String(t.name).trim().toLowerCase()];
    if (!defaults) continue;
    for (const catName of defaults) {
      await pool.query(
        'INSERT INTO skill_categories (worker_type_id, name, created_at) VALUES ($1, $2, $3) ON CONFLICT (worker_type_id, name) DO NOTHING',
        [t.id, catName, nowSqliteStyle()]
      );
    }
  }
}

const ready = init().catch((err) => {
  console.error('Failed to initialize database schema:', err);
  process.exit(1);
});

module.exports = { pool, ready, nowSqliteStyle };
