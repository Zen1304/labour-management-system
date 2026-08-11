'use strict';
// ---------------------------------------------------------------------------
// Heavy role-matrix test suite (v10).
//
// Boots the app against a THROWAWAY database (LMS_DB_PATH) on its own port,
// then checks, for every one of the 7 approved roles:
//   1. GET access to every page (exact 200/403 expected, per role)
//   2. POST access to every gated action (allow AND deny cases)
//   3. UI gating — buttons/forms a role can't use must be absent from its HTML
//   4. End-to-end flows: PM multi-site assignment save + scoping, payroll
//      generate→verify→complete→flag lifecycle, pay-period snapping,
//      duplicate-Aadhar rejection, no-worker-hard-delete, V#### vendor codes
//   5. v10: role reduction — 'supervisor'/'operation_head'/'ceo' are no
//      longer selectable/assignable/loginable; Super Admin protections;
//      forced password-change-on-first-login; deactivated-account login
//      denial.
//
// IMPORTANT: the EXPECT tables below are written out BY HAND, independently
// of src/permissions.js. That's deliberate — if someone fat-fingers the
// central matrix, this suite fails loudly instead of inheriting the mistake.
//
// Run:  node tests/role-matrix.test.js       (from the app root)
// Exits non-zero on any failure. Never touches data/lms.sqlite.
// ---------------------------------------------------------------------------

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DB = path.join(ROOT, 'data', 'test-lms.sqlite');
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
// NODE_ENV deliberately forced to 'test', never left as whatever the
// invoking shell happens to have (or 'production' under some CI setups) —
// src/csrf.js requires CSRF_SECRET to be explicitly configured in
// production and refuses to boot without it, which this throwaway-db test
// server should never be subject to.
const ENV = Object.assign({}, process.env, { LMS_DB_PATH: TEST_DB, PORT: String(PORT), NODE_ENV: 'test' });

// Seeded logins for all 7 approved roles (see src/seed.js — v10).
const LOGINS = {
  super_admin: ['superadmin1', 'superadmin123'],
  admin: ['admin', 'admin123'],
  hr: ['hr', 'hr123'],
  project_manager: ['pm1', 'pm123'],
  site_engineer: ['se1', 'se123'],
  labor_manager: ['labormanager1', 'labor123'],
  audit_manager: ['auditmanager1', 'audit123'],
};
const ROLES = Object.keys(LOGINS);

// ---- Expected GET access per page per role (hand-written, see header) ----
const ALL = ROLES;
// Mirrors permissions.js's OVERSIGHT group exactly (super_admin included as
// a strict superset of admin everywhere, per the v10 role-hierarchy design).
const OVERSIGHT = ['super_admin', 'admin', 'hr', 'labor_manager', 'audit_manager'];
const ADMIN_FULL = ['super_admin', 'admin'];
const ATTENDANCE_MARK = ['super_admin', 'admin', 'hr', 'labor_manager'];
const PAGE_EXPECT = {
  '/': ALL,
  '/account/change-password': ALL,
  '/workers': ALL,
  '/workers/new': ['super_admin', 'admin', 'hr', 'labor_manager'],
  '/skill-assessments': ['super_admin', 'admin', 'hr', 'labor_manager'],
  '/skill-assessments/categories': ADMIN_FULL,
  '/attendance': ATTENDANCE_MARK,
  '/attendance/site-off': ATTENDANCE_MARK,
  '/attendance/single-entry': ATTENDANCE_MARK,
  '/attendance/history': ALL,
  '/payroll': OVERSIGHT,
  '/payroll/new': ['super_admin', 'admin', 'labor_manager'],
  '/analytics': OVERSIGHT,
  '/site-performance': OVERSIGHT,
  '/sites': ADMIN_FULL,
  '/vendors': ADMIN_FULL,
  '/worker-types': ADMIN_FULL,
  '/users': ADMIN_FULL,
  '/site-assignments': ADMIN_FULL,
  '/audit-log': ADMIN_FULL,
};

// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---- CSRF plumbing for the test client -----------------------------------
// Every POST in this app (login included, v9.8) now requires a `_csrf`
// field matching the requester's own session (or, pre-login, an anonymous
// identity cookie). The token is embedded as <meta name="csrf-token"> on
// every server-rendered page and is constant for a given identity/cookie
// for as long as that session lives, so it's cheap to fetch once per cookie
// and reuse — no framework/browser needed, just a regex over the HTML the
// app already sends.
function extractCsrfToken(html) {
  const m = (html || '').match(/<meta name="csrf-token" content="([^"]*)">/);
  return m ? m[1] : '';
}
function extractSetCookie(res, name) {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  for (const line of all) {
    const m = line.match(new RegExp(`${name}=([^;]+)`));
    if (m) return `${name}=${m[1]}`;
  }
  return '';
}

const csrfTokenCache = new Map();
// Tokens are derived purely from the identity carried in `cookie` (the
// session), so any authenticated page's response carries the same value —
// fetching the dashboard once per distinct cookie string and caching it
// avoids an extra request before every single post() call in this suite.
async function csrfTokenFor(cookie) {
  if (csrfTokenCache.has(cookie)) return csrfTokenCache.get(cookie);
  // v10: /account/change-password, not /, since a must_change_password
  // session gets redirected away from / (and everywhere else) — the
  // change-password screen is the one page guaranteed to render normally
  // (200, with the usual <meta name="csrf-token">) for ANY logged-in
  // session regardless of that flag's state.
  const res = await fetch(`${BASE}/account/change-password`, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  const token = extractCsrfToken(await res.text());
  csrfTokenCache.set(cookie, token);
  return token;
}

async function loginWithCreds(username, password) {
  const getRes = await fetch(`${BASE}/login`, { redirect: 'manual' });
  const getBody = await getRes.text();
  const anonCookie = extractSetCookie(getRes, 'csrf_anon');
  const token = extractCsrfToken(getBody);
  const res = await fetch(`${BASE}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: anonCookie },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&_csrf=${encodeURIComponent(token)}`,
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/session=([^;]+)/);
  return m ? `session=${m[1]}` : null;
}

async function login(role) {
  const [u, p] = LOGINS[role];
  const cookie = await loginWithCreds(u, p);
  if (!cookie) throw new Error(`login failed for ${role} (username ${u})`);
  return cookie;
}

async function get(pathname, cookie) {
  const res = await fetch(`${BASE}${pathname}`, { redirect: 'manual', headers: { Cookie: cookie } });
  return { status: res.status, body: await res.text(), location: res.headers.get('location') };
}

async function post(pathname, data, cookie) {
  const token = await csrfTokenFor(cookie);
  return postRaw(pathname, Object.assign({}, data, { _csrf: token }), cookie);
}

// The un-protected primitive — used by the post() helper above (which
// always attaches a valid token) AND directly by the CSRF-specific tests
// below, which need to send a missing, blank, wrong, or cross-session token
// on purpose.
async function postRaw(pathname, data, cookie) {
  const body = Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body,
  });
  return { status: res.status, body: await res.text(), location: res.headers.get('location') };
}

function openDb() {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(TEST_DB);
}

async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}/login`);
      if (res.status === 200) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server never became ready');
}

async function main() {
  // ---- Boot: fresh throwaway db, seed, spawn server ----
  fs.rmSync(TEST_DB, { force: true });
  await new Promise((resolve, reject) => {
    const seed = spawn(process.execPath, ['src/seed.js'], { cwd: ROOT, env: ENV, stdio: 'ignore' });
    seed.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('seed failed'))));
  });

  // Simulate a pre-v9/v9.1 database — a fresh seed already gets the current
  // "V####"/"W#####" codes straight from nextVendorCode()/nextWorkerCode(),
  // so without this there'd be nothing for the renumbering migrations to
  // actually migrate. Rewrite every regular vendor/worker back to the old
  // "VEN-xxx"/"WRK-xxxx" style and drop the schema_meta markers, so booting
  // the server below exercises the real migration path against old-format
  // data — the same scenario as Zen's actual pre-upgrade database.
  {
    const { DatabaseSync } = require('node:sqlite');
    const seedDb = new DatabaseSync(TEST_DB);
    seedDb.exec('DROP TABLE IF EXISTS schema_meta');
    let vn = 1;
    for (const v of seedDb.prepare('SELECT id FROM vendors WHERE is_direct = 0 ORDER BY id').all()) {
      seedDb.prepare('UPDATE vendors SET vendor_code = ? WHERE id = ?').run('VEN-' + String(vn).padStart(3, '0'), v.id);
      vn++;
    }
    let wn = 1;
    for (const w of seedDb.prepare('SELECT id FROM workers ORDER BY id').all()) {
      seedDb.prepare('UPDATE workers SET worker_code = ? WHERE id = ?').run('WRK-' + String(wn).padStart(4, '0'), w.id);
      wn++;
    }
    seedDb.close();
  }

  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: ENV, stdio: 'ignore' });
  try {
    await waitForServer();

    // Migrations ran as part of server boot (db.js requires them at module
    // load). Confirm every vendor/worker actually moved to the new format —
    // this is the regression test for the exact "old data doesn't migrate"
    // class of bug, not just "new records get the new format" (which was
    // already covered further down but doesn't exercise the migration path).
    {
      const db = openDb();
      const leftoverVendors = db.prepare(`SELECT COUNT(*) c FROM vendors WHERE is_direct = 0 AND vendor_code NOT GLOB 'V[0-9][0-9][0-9][0-9]'`).get().c;
      check('all regular vendors migrated to V#### format', leftoverVendors === 0, `${leftoverVendors} still old-format`);
      const leftoverWorkers = db.prepare(`SELECT COUNT(*) c FROM workers WHERE worker_code NOT GLOB 'W[0-9][0-9][0-9][0-9][0-9]'`).get().c;
      check('all workers migrated to W##### format', leftoverWorkers === 0, `${leftoverWorkers} still old-format`);
      const directVendor = db.prepare('SELECT vendor_code FROM vendors WHERE is_direct = 1').get();
      check('Direct vendor code untouched by renumbering', directVendor.vendor_code === 'B0001', directVendor.vendor_code);
      const usersRoleCheckSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`).get().sql;
      check("users table's role CHECK constraint includes 'super_admin' (v10 migration ran)", usersRoleCheckSql.includes('super_admin'), usersRoleCheckSql);
      check("users table has a must_change_password column (v10 migration ran)", !!db.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'must_change_password'));
    }

    const cookies = {};
    for (const role of ROLES) cookies[role] = await login(role);

    // =====================================================================
    console.log('\n[0] v10: exactly the seven approved roles can log in');
    {
      for (const role of ROLES) {
        check(`login succeeds for ${role} (${LOGINS[role][0]})`, typeof cookies[role] === 'string' && cookies[role].startsWith('session='));
      }
      // 'super_admin' really is a DISTINCT role from 'admin' here, not an alias.
      const superAdminRow = openDb().prepare(`SELECT role FROM users WHERE username = 'superadmin1'`).get();
      check("superadmin1's stored role is exactly 'super_admin'", superAdminRow.role === 'super_admin', superAdminRow.role);
    }

    // =====================================================================
    console.log('\n[1] GET access matrix — every page × every role');
    for (const [page, allowedRoles] of Object.entries(PAGE_EXPECT)) {
      for (const role of ROLES) {
        const expected = allowedRoles.includes(role) ? 200 : 403;
        const { status } = await get(page, cookies[role]);
        check(`GET ${page} as ${role} → ${expected}`, status === expected, `got ${status}`);
      }
    }

    // =====================================================================
    console.log('\n[2] UI gating — forbidden actions absent from rendered HTML');
    {
      // Attendance history: × delete forms only for the attendance.delete roles.
      for (const role of ROLES) {
        const { status, body } = await get('/attendance/history', cookies[role]);
        if (status !== 200) continue;
        const hasDelete = /\/attendance\/\d+\/delete/.test(body);
        const should = ATTENDANCE_MARK.includes(role);
        check(`history delete button ${should ? 'present' : 'absent'} for ${role}`, hasDelete === should);
      }
      // Site performance: form + Edit/Remove only for siteperf.manage roles.
      for (const role of OVERSIGHT) {
        const { body } = await get('/site-performance', cookies[role]);
        const hasForm = body.includes('site-perf-form');
        const should = ['super_admin', 'admin', 'labor_manager'].includes(role);
        check(`site-perf form ${should ? 'present' : 'absent'} for ${role}`, hasForm === should);
      }
      // Worker edit page: verify button only admin/hr (+ super_admin); no Delete button for anyone.
      const db = openDb();
      const workerId = db.prepare('SELECT id FROM workers ORDER BY id LIMIT 1').get().id;
      for (const role of ['super_admin', 'admin', 'hr', 'labor_manager']) {
        const { body } = await get(`/workers/${workerId}/edit`, cookies[role]);
        const hasVerify = body.includes('toggle-verification');
        const shouldVerify = role !== 'labor_manager';
        check(`worker-edit verify button ${shouldVerify ? 'present' : 'absent'} for ${role}`, hasVerify === shouldVerify);
        check(`worker-edit has NO hard-delete for ${role}`, !body.includes(`/workers/${workerId}/delete`));
        check(`worker-edit explains deactivate-only for ${role}`, body.includes('never permanently deleted'));
      }
      // Nav: payroll group only for oversight; admin group only for admin.full roles.
      for (const role of ROLES) {
        const { body } = await get('/', cookies[role]);
        const hasPayrollNav = body.includes('href="/payroll"');
        check(`nav payroll ${OVERSIGHT.includes(role) ? 'shown' : 'hidden'} for ${role}`, hasPayrollNav === OVERSIGHT.includes(role));
        const hasAdminNav = body.includes('href="/users"');
        check(`nav admin ${ADMIN_FULL.includes(role) ? 'shown' : 'hidden'} for ${role}`, hasAdminNav === ADMIN_FULL.includes(role));
      }
    }

    // =====================================================================
    console.log('\n[3] Attendance: mark & delete permissions (v10: no more single-site supervisor clamp)');
    {
      const db = openDb();
      const entry = db.prepare('SELECT id FROM attendance ORDER BY id LIMIT 1').get();
      for (const role of ['project_manager', 'site_engineer', 'audit_manager']) {
        const { status } = await post(`/attendance/${entry.id}/delete`, {}, cookies[role]);
        check(`attendance delete denied for ${role}`, status === 403, `got ${status}`);
      }
      const before = db.prepare('SELECT COUNT(*) c FROM attendance').get().c;
      const { status: delOk } = await post(`/attendance/${entry.id}/delete`, {}, cookies.labor_manager);
      const after = openDb().prepare('SELECT COUNT(*) c FROM attendance').get().c;
      check('attendance delete allowed for labor_manager', delOk === 302, `got ${delOk}`);
      check('attendance row actually removed', after === before - 1, `${before} -> ${after}`);
      // Marking: PM/SE/audit_manager denied — none of them carry attendance.mark.
      const w = db.prepare(`SELECT id FROM workers WHERE site_id = 101 AND status = 'active' LIMIT 1`).get();
      for (const role of ['project_manager', 'site_engineer', 'audit_manager']) {
        const { status } = await post('/attendance/entry', { worker_id: w.id, site_id: 101, date: '2026-08-08', hours: 4, leave: 0, ot: 0 }, cookies[role]);
        check(`attendance mark denied for ${role}`, status === 403, `got ${status}`);
      }
      // v10: attendance.mark is company-wide for admin/hr/labor_manager/super_admin
      // now (the old single-site 'supervisor' clamp is gone along with the role)
      // — any of them can mark any active site.
      const { status: markOk } = await post('/attendance/entry', { worker_id: w.id, site_id: 101, date: '2026-08-08', hours: 4, leave: 0, ot: 0 }, cookies.admin);
      check('attendance mark allowed for admin (any site)', markOk === 302, `got ${markOk}`);
      const { status: capHit, body: capBody } = await post('/attendance/entry', { worker_id: w.id, site_id: 101, date: '2026-08-08', hours: 8, leave: 0, ot: 3 }, cookies.admin);
      check('11-hour day rejected (10h cap)', capHit === 400, `got ${capHit}`);

      // ---- v9.6: single-entry split onto its own page ----
      // The bulk grid stays the primary workflow on /attendance; the
      // one-worker form moved to /attendance/single-entry. These check the
      // split held: the form is gone from the bulk page, present on the new
      // one, both are reachable from each other, and a rejected submission
      // re-renders the new page (not the grid) with the values still filled.
      const { body: bulkBody } = await get('/attendance?site_id=101', cookies.admin);
      check(
        'v9.6: single-entry form no longer on the bulk attendance page',
        !bulkBody.includes('action="/attendance/entry"'),
        'entry form still rendered on /attendance'
      );
      check('v9.6: bulk page keeps its own grid save form', bulkBody.includes('action="/attendance"'), 'bulk form missing');
      check(
        'v9.6: bulk page links to the single-entry page',
        bulkBody.includes('/attendance/single-entry'),
        'no link to single-entry page'
      );
      const { body: seBody } = await get('/attendance/single-entry', cookies.admin);
      check('v9.6: single-entry page renders the entry form', seBody.includes('action="/attendance/entry"'), 'entry form missing');
      check('v9.6: single-entry page links back to site attendance', seBody.includes('Back to site attendance'), 'no back link');
      check(
        'v9.6: single-entry page explains it is for corrections/split-site cases',
        /correction/i.test(seBody) && /split/i.test(seBody),
        'purpose text missing'
      );
      check('v9.6: rejected submission re-renders the single-entry page', capBody.includes('action="/attendance/entry"'), 'not the single-entry page');
      check(
        'v9.6: rejected submission keeps the typed values',
        capBody.includes('value="8"') && capBody.includes('value="3"'),
        'values not preserved'
      );
      // Success path returns to the single-entry page with a confirmation.
      const { status: seOk, location: seLoc } = await post(
        '/attendance/entry',
        { worker_id: w.id, site_id: 101, date: '2026-08-22', hours: 6, leave: 0, ot: 0 },
        cookies.admin
      );
      check('v9.6: successful single entry redirects (302)', seOk === 302, `got ${seOk}`);
      check(
        'v9.6: success returns to the single-entry page with a confirmation',
        !!seLoc && seLoc.startsWith('/attendance/single-entry') && seLoc.includes('saved='),
        `location ${seLoc}`
      );
      const { body: savedBody } = await get(seLoc, cookies.admin);
      check('v9.6: confirmation message shown on return', savedBody.includes('flash-success') && /Entry saved/.test(savedBody), 'no success flash');
      const seRowCount = openDb()
        .prepare('SELECT COUNT(*) c FROM attendance WHERE worker_id = ? AND date = ? AND site_id = ?')
        .get(w.id, '2026-08-22', 101).c;
      check('v9.6: single entry actually persisted', seRowCount === 1, `count ${seRowCount}`);
      // The GET page is gated by the same role list as the rest of
      // attendance-marking (PAGE_EXPECT covers the allow side).
      for (const role of ['project_manager', 'site_engineer', 'audit_manager']) {
        const { status } = await get('/attendance/single-entry', cookies[role]);
        check(`v10: /attendance/single-entry denied for ${role}`, status === 403, `got ${status}`);
      }

      // ---- v9.7 business rules (still enforced, exercised via admin/hr now
      // that the site-scoped 'supervisor' clamp they were originally written
      // against no longer exists as a role) ----
      const ownWorker = db.prepare(`SELECT id FROM workers WHERE site_id = 101 AND status = 'active' LIMIT 1`).get();
      const badWorkerId = 999999;
      const { status: ghostStatus, body: ghostBody } = await post(
        '/attendance/entry',
        { worker_id: badWorkerId, site_id: 101, date: '2026-08-31', hours: 5, leave: 0, ot: 0 },
        cookies.hr
      );
      check('v9.7: nonexistent worker rejected (400)', ghostStatus === 400, `got ${ghostStatus}`);
      check(
        'v9.7: rejection message leaks no worker/site detail',
        /isn&#39;t available for attendance|isn't available for attendance/.test(ghostBody) && !ghostBody.includes(String(badWorkerId)),
        'message leaked detail'
      );
      const toDeactivate = db.prepare(`SELECT id FROM workers WHERE site_id = 101 AND status = 'active' LIMIT 1`).get();
      openDb().prepare(`UPDATE workers SET status = 'inactive' WHERE id = ?`).run(toDeactivate.id);
      const { status: inactiveStatus } = await post(
        '/attendance/entry',
        { worker_id: toDeactivate.id, site_id: 101, date: '2026-08-31', hours: 5, leave: 0, ot: 0 },
        cookies.hr
      );
      check('v9.7: inactive worker rejected server-side (400)', inactiveStatus === 400, `got ${inactiveStatus}`);
      openDb().prepare(`UPDATE workers SET status = 'active' WHERE id = ?`).run(toDeactivate.id);
      for (const badDate of ['NOT-A-DATE', '2026-02-31', '']) {
        const { status } = await post(
          '/attendance/entry',
          { worker_id: ownWorker.id, site_id: 101, date: badDate, hours: 5, leave: 0, ot: 0 },
          cookies.hr
        );
        check(`v9.7: invalid date "${badDate || '(empty)'}" rejected`, status === 400, `got ${status}`);
      }
      const { status: poolStatus } = await post(
        '/attendance/entry',
        { worker_id: ownWorker.id, site_id: 100, date: '2026-09-03', hours: 5, leave: 0, ot: 0 },
        cookies.admin
      );
      check('v9.7: attendance against the Unassigned Pool rejected', poolStatus === 400, `got ${poolStatus}`);
      const site102OrigStatus = db.prepare('SELECT status FROM sites WHERE id = 102').get().status;
      openDb().prepare(`UPDATE sites SET status = 'completed' WHERE id = 102`).run();
      const { status: completedStatus } = await post(
        '/attendance/entry',
        { worker_id: ownWorker.id, site_id: 102, date: '2026-09-03', hours: 5, leave: 0, ot: 0 },
        cookies.admin
      );
      check('v9.7: attendance at a completed site rejected', completedStatus === 400, `got ${completedStatus}`);
      openDb().prepare(`UPDATE sites SET status = ? WHERE id = 102`).run(site102OrigStatus);
      // Bulk grid: injected nonexistent worker rejected, all-or-nothing.
      const bulkBefore = openDb().prepare('SELECT COUNT(*) c FROM attendance').get().c;
      const { status: bulkGhost } = await post(
        '/attendance',
        {
          date: '2026-09-05',
          site_id: 101,
          [`hours_${ownWorker.id}`]: 8,
          [`leave_${ownWorker.id}`]: 0,
          [`ot_${ownWorker.id}`]: 0,
          [`hours_${badWorkerId}`]: 8,
          [`leave_${badWorkerId}`]: 0,
          [`ot_${badWorkerId}`]: 0,
        },
        cookies.admin
      );
      check('v9.7: bulk grid rejects an injected nonexistent worker (400)', bulkGhost === 400, `got ${bulkGhost}`);
      const bulkAfter = openDb().prepare('SELECT COUNT(*) c FROM attendance').get().c;
      check('v9.7: rejected bulk save writes nothing at all (no partial rows)', bulkAfter === bulkBefore, `${bulkBefore} -> ${bulkAfter}`);
      const { status: bulkStillOk } = await post(
        '/attendance',
        { date: '2026-09-06', site_id: 101, [`hours_${ownWorker.id}`]: 8, [`leave_${ownWorker.id}`]: 0, [`ot_${ownWorker.id}`]: 0 },
        cookies.admin
      );
      const bulkSaved = openDb()
        .prepare('SELECT hours_worked FROM attendance WHERE worker_id = ? AND date = ? AND site_id = ?')
        .get(ownWorker.id, '2026-09-06', 101);
      check('v9.7: legitimate bulk save still succeeds', bulkStillOk === 302, `got ${bulkStillOk}`);
      check('v9.7: legitimate bulk save persisted correct hours', !!bulkSaved && bulkSaved.hours_worked === 8, `got ${bulkSaved && bulkSaved.hours_worked}`);
    }

    // =====================================================================
    console.log('\n[4] Site assignments: single-form save, persistence, scoping, feedback');
    {
      const db = openDb();
      const pmId = db.prepare(`SELECT id FROM users WHERE username = 'pm1'`).get().id;
      const seId = db.prepare(`SELECT id FROM users WHERE username = 'se1'`).get().id;
      const { status: denied } = await post('/site-assignments', {}, cookies.labor_manager);
      check('site-assignments save denied for labor_manager', denied === 403, `got ${denied}`);
      // One submit reassigns BOTH people: pm1 -> {101,103}, se1 -> {102}.
      const payload = {};
      payload[`u${pmId}_site_101`] = 'on';
      payload[`u${pmId}_site_103`] = 'on';
      payload[`u${seId}_site_102`] = 'on';
      const { status: saveOk } = await post('/site-assignments', payload, cookies.admin);
      check('site-assignments save (both people, one submit) → 302', saveOk === 302, `got ${saveOk}`);
      const pmSites = openDb().prepare('SELECT site_id FROM user_site_assignments WHERE user_id = ? ORDER BY site_id').all(pmId).map((r) => r.site_id);
      const seSites = openDb().prepare('SELECT site_id FROM user_site_assignments WHERE user_id = ? ORDER BY site_id').all(seId).map((r) => r.site_id);
      check('pm1 assignments persisted exactly {101,103}', JSON.stringify(pmSites) === '[101,103]', JSON.stringify(pmSites));
      check('se1 assignments persisted exactly {102}', JSON.stringify(seSites) === '[102]', JSON.stringify(seSites));
      // Save confirmation flash renders on redirect target.
      const { body: confirmBody } = await get('/site-assignments?saved=Farah%20Sheikh%3A%202%20site(s)', cookies.admin);
      check('save confirmation flash renders', confirmBody.includes('flash-success') && confirmBody.includes('Saved.'));
      // The saved scope actually applies: pm1's worker list covers 101+103 only.
      const { body: pmWorkers } = await get('/workers', cookies.project_manager);
      const w102 = openDb().prepare(`SELECT name FROM workers WHERE site_id = 102 AND status='active' LIMIT 1`).get();
      const w101 = openDb().prepare(`SELECT name FROM workers WHERE site_id = 101 AND status='active' LIMIT 1`).get();
      check('pm1 sees a site-101 worker', pmWorkers.includes(w101.name), w101.name);
      check('pm1 does NOT see a site-102 worker', !pmWorkers.includes(w102.name), w102.name);
      // Users page surfaces the PM's assigned sites inline.
      const { body: usersBody } = await get('/users', cookies.admin);
      check('users page shows pm1 assigned sites "101, 103"', usersBody.includes('101, 103'));
    }

    // =====================================================================
    console.log('\n[5] Site performance: manage vs view');
    {
      for (const role of ['hr', 'audit_manager', 'project_manager', 'site_engineer']) {
        const { status } = await post('/site-performance', { site_id: 101, adjustment_type: 'cut', cut_percent: 10, period_start: '2026-08-09', period_end: '2026-08-09' }, cookies[role]);
        check(`site-perf create denied for ${role}`, status === 403, `got ${status}`);
      }
      const { status: ok } = await post('/site-performance', { site_id: 101, adjustment_type: 'cut', cut_percent: 10, period_start: '2026-08-10', period_end: '2026-08-10', reason: 'matrix test' }, cookies.labor_manager);
      check('site-perf create allowed for labor_manager', ok === 302, `got ${ok}`);
      const row = openDb().prepare('SELECT * FROM site_performance ORDER BY id DESC LIMIT 1').get();
      check('site-perf period snapped to Thu-Wed (2026-08-06..2026-08-12)', row.period_start === '2026-08-06' && row.period_end === '2026-08-12', `${row.period_start}..${row.period_end}`);
    }

    // =====================================================================
    console.log('\n[6] Payroll lifecycle: generate → per-site verify → complete → flag');
    {
      for (const role of ['hr', 'audit_manager', 'project_manager', 'site_engineer']) {
        const { status } = await post('/payroll/generate', { period_start: '2026-08-09', period_end: '2026-08-09' }, cookies[role]);
        check(`payroll generate denied for ${role}`, status === 403, `got ${status}`);
      }
      const { status: genOk } = await post('/payroll/generate', { period_start: '2026-08-09', period_end: '2026-08-09', notes: 'matrix test' }, cookies.labor_manager);
      check('payroll generate allowed for labor_manager', genOk === 302, `got ${genOk}`);
      const run = openDb().prepare('SELECT * FROM payroll_runs ORDER BY id DESC LIMIT 1').get();
      check('payroll period snapped to Thu-Wed', run.period_start === '2026-08-06' && run.period_end === '2026-08-12', `${run.period_start}..${run.period_end}`);
      const { status: dup } = await post('/payroll/generate', { period_start: '2026-08-11', period_end: '2026-08-11' }, cookies.labor_manager);
      check('duplicate period (same snapped week) rejected', dup === 400, `got ${dup}`);
      // Deductions: HR sees no form and is denied on POST; labor_manager allowed.
      const item = openDb().prepare('SELECT id FROM payroll_items WHERE payroll_run_id = ? LIMIT 1').get(run.id);
      const { body: hrItemBody } = await get(`/payroll/items/${item.id}`, cookies.hr);
      check('add-deduction form absent for hr', !hrItemBody.includes('Add deduction'));
      const { status: dedDenied } = await post(`/payroll/items/${item.id}/deductions`, { reason: 'x', amount: 10 }, cookies.hr);
      check('add-deduction denied for hr', dedDenied === 403, `got ${dedDenied}`);
      const { status: dedOk } = await post(`/payroll/items/${item.id}/deductions`, { reason: 'Advance repayment', amount: 100 }, cookies.labor_manager);
      check('add-deduction allowed for labor_manager', dedOk === 302, `got ${dedOk}`);
      // Per-site verify: labor_manager denied; audit_manager verifies each site; run flips.
      const sites = openDb().prepare('SELECT DISTINCT site_id FROM payroll_item_sites pis JOIN payroll_items pi ON pi.id = pis.payroll_item_id WHERE pi.payroll_run_id = ? ORDER BY site_id').all(run.id).map((r) => r.site_id);
      check('run has per-site breakdown rows', sites.length > 0, `sites: ${sites.join(',')}`);
      const { status: verDenied } = await post(`/payroll/${run.id}/sites/${sites[0]}/verify`, {}, cookies.labor_manager);
      check('site verify denied for labor_manager', verDenied === 403, `got ${verDenied}`);
      const { status: compEarly } = await post(`/payroll/${run.id}/complete`, {}, cookies.audit_manager);
      const stEarly = openDb().prepare('SELECT status FROM payroll_runs WHERE id = ?').get(run.id).status;
      check('complete before full verification does not complete', stEarly !== 'completed', `status ${stEarly} (POST ${compEarly})`);
      for (const s of sites) {
        const { status } = await post(`/payroll/${run.id}/sites/${s}/verify`, {}, cookies.audit_manager);
        check(`audit_manager verifies site ${s}`, status === 302, `got ${status}`);
      }
      const stVerified = openDb().prepare('SELECT status FROM payroll_runs WHERE id = ?').get(run.id).status;
      check('run auto-flips to verified after last site', stVerified === 'verified', `status ${stVerified}`);
      const { status: compOk } = await post(`/payroll/${run.id}/complete`, {}, cookies.audit_manager);
      const stDone = openDb().prepare('SELECT status FROM payroll_runs WHERE id = ?').get(run.id).status;
      check('audit_manager completes verified run', compOk === 302 && stDone === 'completed', `POST ${compOk}, status ${stDone}`);
      // Flag: audit_manager denied; labor_manager allowed; period regenerable after.
      const { status: flagDenied } = await post(`/payroll/${run.id}/flag`, { reason: 'x' }, cookies.audit_manager);
      check('flag denied for audit_manager', flagDenied === 403, `got ${flagDenied}`);
      const { status: flagOk } = await post(`/payroll/${run.id}/flag`, { reason: 'matrix test regen' }, cookies.labor_manager);
      const flagged = openDb().prepare('SELECT flagged FROM payroll_runs WHERE id = ?').get(run.id).flagged;
      check('flag allowed for labor_manager', flagOk === 302 && flagged === 1, `POST ${flagOk}, flagged ${flagged}`);
      const { status: regenOk } = await post('/payroll/generate', { period_start: '2026-08-07', period_end: '2026-08-07' }, cookies.admin);
      check('flagged period regenerable (as admin)', regenOk === 302, `got ${regenOk}`);
    }

    // =====================================================================
    console.log('\n[6b] Architecture hardening: FK indexes + payroll period race backstop (v9.4)');
    {
      const db = openDb();
      const indexNames = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map((r) => r.name);
      for (const idx of [
        'idx_attendance_worker',
        'idx_attendance_site_date',
        'idx_workers_site',
        'idx_workers_vendor',
        'idx_workers_type',
        'idx_payroll_items_run',
        'idx_payroll_items_worker',
        'idx_payroll_item_sites_item',
        'idx_skill_ratings_worker',
        'idx_payroll_runs_period_unflagged',
      ]) {
        check(`index ${idx} exists`, indexNames.includes(idx));
      }
      // The duplicate-period check in /payroll/generate is application-level
      // (SELECT then INSERT); idx_payroll_runs_period_unflagged is the DB-level
      // backstop for a race between two concurrent submits. Prove it's a real
      // constraint, not just a comment, by trying to violate it directly at
      // the DB layer (bypassing the app's own pre-check entirely).
      const anyUnflaggedRun = db.prepare('SELECT period_start, period_end FROM payroll_runs WHERE flagged = 0 LIMIT 1').get();
      let raceBlocked = false;
      try {
        db.prepare('INSERT INTO payroll_runs (period_start, period_end, flagged) VALUES (?, ?, 0)').run(
          anyUnflaggedRun.period_start,
          anyUnflaggedRun.period_end
        );
      } catch (e) {
        raceBlocked = /UNIQUE/i.test(e.message || '');
      }
      check('idx_payroll_runs_period_unflagged actually rejects a duplicate unflagged period at the DB layer', raceBlocked);
    }

    // =====================================================================
    console.log('\n[7] Workers: manage/verify split, dedupe, no hard delete, ID formats');
    {
      for (const role of ['project_manager', 'site_engineer', 'audit_manager']) {
        const { status } = await post('/workers', { name: 'X', worker_type_id: 1, vendor_id: 1, aadhar_number: '999900001111', wage_rate: 100, contact: '9876543210' }, cookies[role]);
        check(`worker create denied for ${role}`, status === 403, `got ${status}`);
      }
      const { status: createOk } = await post('/workers', { name: 'Matrix Test Worker', worker_type_id: 1, vendor_id: 1, aadhar_number: '999900001111', wage_rate: 500, overtime_multiplier: 1.5, contact: '9876543210', skill_grade: 'skilled' }, cookies.labor_manager);
      check('worker create allowed for labor_manager', createOk === 302, `got ${createOk}`);
      const newW = openDb().prepare(`SELECT * FROM workers WHERE aadhar_number = '999900001111'`).get();
      check('new worker got W##### code (v9.1)', /^W\d{5}$/.test(newW.worker_code), newW.worker_code);
      check('new worker landed in Pool (site 100)', newW.site_id === 100, `site ${newW.site_id}`);
      const { status: dupA } = await post('/workers', { name: 'Dup', worker_type_id: 1, vendor_id: 1, aadhar_number: '999900001111', wage_rate: 500, contact: '9876543210' }, cookies.hr);
      const dupCount = openDb().prepare(`SELECT COUNT(*) c FROM workers WHERE aadhar_number = '999900001111'`).get().c;
      check('duplicate Aadhar rejected on create', dupA === 400 && dupCount === 1, `POST ${dupA}, count ${dupCount}`);
      const { status: verDenied } = await post(`/workers/${newW.id}/toggle-verification`, {}, cookies.labor_manager);
      check('verification toggle denied for labor_manager', verDenied === 403, `got ${verDenied}`);
      const { status: verOk } = await post(`/workers/${newW.id}/toggle-verification`, {}, cookies.hr);
      const verStatus = openDb().prepare('SELECT verification_status FROM workers WHERE id = ?').get(newW.id).verification_status;
      check('verification toggle allowed for hr', verOk === 302 && verStatus === 'verified', `POST ${verOk}, status ${verStatus}`);
      const { status: hardDel } = await post(`/workers/${newW.id}/delete`, {}, cookies.admin);
      check('worker hard-delete route is GONE (404 even for admin)', hardDel === 404, `got ${hardDel}`);
      // Labor manager assigns the worker to a real site via edit (the v8.4 grant).
      const { status: assignOk } = await post(`/workers/${newW.id}`, { name: 'Matrix Test Worker', worker_type_id: 1, vendor_id: 1, aadhar_number: '999900001111', site_id: 102, status: 'active', wage_rate: 500, overtime_multiplier: 1.5, contact: '9876543210', skill_grade: 'skilled', joined_date: '2026-08-01' }, cookies.labor_manager);
      const assignedSite = openDb().prepare('SELECT site_id FROM workers WHERE id = ?').get(newW.id).site_id;
      check('labor_manager assigns worker to site 102', assignOk === 302 && assignedSite === 102, `POST ${assignOk}, site ${assignedSite}`);
    }

    // =====================================================================
    console.log('\n[8] Admin surfaces: vendors (V#### codes), sites, users');
    {
      const { status: vDenied } = await post('/vendors', { name: 'Nope', contact: '9876543210' }, cookies.labor_manager);
      check('vendor create denied for labor_manager', vDenied === 403, `got ${vDenied}`);
      const { status: vOk } = await post('/vendors', { name: 'Matrix Vendor', contact: '9876543210' }, cookies.admin);
      const newV = openDb().prepare(`SELECT * FROM vendors WHERE name = 'Matrix Vendor'`).get();
      check('vendor create allowed for admin', vOk === 302 && !!newV, `POST ${vOk}`);
      check('new vendor got V#### code', newV && /^V\d{4}$/.test(newV.vendor_code), newV && newV.vendor_code);
      const { status: uDenied } = await post('/users', { name: 'N', username: 'n@x.example', password: 'password8', role: 'hr', contact: '9876543210' }, cookies.labor_manager);
      check('user create denied for labor_manager', uDenied === 403, `got ${uDenied}`);
      const { status: sDenied } = await post('/sites', { name: 'Nope' }, cookies.hr);
      check('site create denied for hr', sDenied === 403, `got ${sDenied}`);

      // v10 follow-up: accounts created with the exact placeholder contact
      // number (used by migrate-v10-accounts.js when a real number wasn't
      // available yet) get a visible "needs real number" flag on the Users
      // page — read-only, never auto-changes the number itself.
      await post('/users', { name: 'Placeholder Contact', username: 'placeholder-contact@x.example', password: 'password8', role: 'hr', contact: '9800000000' }, cookies.admin);
      await post('/users', { name: 'Real Contact', username: 'real-contact@x.example', password: 'password8', role: 'hr', contact: '9876500004' }, cookies.admin);
      const { body: usersPageBody } = await get('/users', cookies.admin);
      const placeholderRow = usersPageBody.split('Placeholder Contact')[1] || '';
      const realRow = usersPageBody.split('Real Contact')[1] || '';
      check('account with the placeholder contact number is flagged "needs real number"', placeholderRow.slice(0, 400).includes('needs real number'));
      check('account with a real contact number is NOT flagged', !realRow.slice(0, 400).includes('needs real number'));
    }

    // =====================================================================
    console.log('\n[8b] Sites: no hard delete, ever (v9) — archive-only, history stays searchable');
    {
      const { status: createOk } = await post('/sites', { name: 'Matrix Site' }, cookies.admin);
      check('site create allowed for admin', createOk === 302, `got ${createOk}`);
      const site = openDb().prepare(`SELECT * FROM sites WHERE name = 'Matrix Site'`).get();
      check('new site created', !!site);
      // Old route is gone entirely — even a genuinely empty, zero-dependency
      // site 404s on delete now, for every role including admin.
      const { status: delAdmin } = await post(`/sites/${site.id}/delete`, {}, cookies.admin);
      check('site delete route is GONE (404 even for admin, even with zero deps)', delAdmin === 404, `got ${delAdmin}`);
      const stillThere = openDb().prepare('SELECT id FROM sites WHERE id = ?').get(site.id);
      check('site was not deleted', !!stillThere);
      // No Delete button/form anywhere in the Sites list HTML for anyone.
      const { body: sitesBody } = await get('/sites', cookies.admin);
      check('Sites list has NO delete form for any site', !sitesBody.includes('/delete"'));
      check('Sites list explains archive-only via Completed status', sitesBody.includes('never permanently deleted'));
      // Mark it Completed (the only retirement path) and confirm it stays
      // fully visible + its attendance stays filterable by period.
      const { status: completeOk } = await post(`/sites/${site.id}`, { name: 'Matrix Site', status: 'completed' }, cookies.admin);
      check('mark site Completed allowed for admin', completeOk === 302, `got ${completeOk}`);
      const { body: sitesAfter } = await get('/sites', cookies.admin);
      check('Completed site still listed on Sites page', sitesAfter.includes('Matrix Site'));
      const { body: histBody } = await get('/attendance/history', cookies.admin);
      check(`Completed site still selectable in Attendance History's site filter`, histBody.includes(`value="${site.id}"`) && histBody.includes('(Completed)'));
    }

    // =====================================================================
    console.log('\n[9] Skill assessments: default + custom categories, ratings, gating (v9.2/9.3)');
    {
      const db = openDb();
      const DEFAULT_CATS = ['Brickwork', 'Plastering', 'Centering', 'Shuttering & Setting-Out', 'Ability to Calculate & Read Drawings'];
      const masonType = db.prepare(`SELECT id FROM worker_types WHERE name = 'Mason'`).get();
      const helperType = db.prepare(`SELECT id FROM worker_types WHERE name = 'Helper'`).get();
      // v9.3: Mason & Helper come pre-seeded with the same 5-category default
      // list on boot, so no admin setup is required before either can be rated.
      for (const [label, typeId] of [
        ['Mason', masonType.id],
        ['Helper', helperType.id],
      ]) {
        const names = db
          .prepare('SELECT name FROM skill_categories WHERE worker_type_id = ? AND active = 1 ORDER BY name')
          .all(typeId)
          .map((r) => r.name);
        check(`${label} pre-seeded with 5 default categories`, names.length === 5, `${names.length}: ${names.join(', ')}`);
        check(`${label} default categories match Zen's list`, DEFAULT_CATS.every((c) => names.includes(c)), names.join(', '));
      }
      const mason = openDb().prepare('SELECT id FROM workers WHERE worker_type_id = ? LIMIT 1').get(masonType.id);
      const { body: zeroSetupBody } = await get(`/skill-assessments?worker_id=${mason.id}`, cookies.admin);
      check(
        'Mason worker shows all 5 rating dropdowns with zero admin setup',
        (zeroSetupBody.match(/name="rating_\d+"/g) || []).length === 5
      );

      // Category management is admin.full-only. Uses Electrician (no default
      // categories) so this exercises custom add/reject independently of the
      // v9.3 pre-seeding above.
      const elecType = db.prepare(`SELECT id FROM worker_types WHERE name = 'Electrician'`).get();
      for (const role of ['hr', 'labor_manager', 'project_manager', 'site_engineer', 'audit_manager']) {
        const { status } = await post('/skill-assessments/categories', { worker_type_id: elecType.id, name: `Nope-${role}` }, cookies[role]);
        check(`skill-category create denied for ${role}`, status === 403, `got ${status}`);
      }
      const { status: catOk } = await post('/skill-assessments/categories', { worker_type_id: elecType.id, name: 'Wiring' }, cookies.admin);
      check('skill-category create allowed for admin', catOk === 302, `got ${catOk}`);
      await post('/skill-assessments/categories', { worker_type_id: elecType.id, name: 'Panel fitting' }, cookies.admin);
      const cats = openDb().prepare('SELECT * FROM skill_categories WHERE worker_type_id = ? ORDER BY name').all(elecType.id);
      check('2 custom skill categories created for Electrician', cats.length === 2, `${cats.length}`);
      // Duplicate name rejected with a clear error, no new row.
      const { status: dupCat } = await post('/skill-assessments/categories', { worker_type_id: elecType.id, name: 'Wiring' }, cookies.admin);
      const catsAfterDup = openDb().prepare('SELECT COUNT(*) c FROM skill_categories WHERE worker_type_id = ?').get(elecType.id).c;
      check('duplicate skill-category name rejected', dupCat === 400 && catsAfterDup === 2, `POST ${dupCat}, count ${catsAfterDup}`);
      // GET/POST rate access: admin, hr, labor_manager (+ super_admin) allowed; everyone else denied.
      const elec = openDb().prepare('SELECT id FROM workers WHERE worker_type_id = ? LIMIT 1').get(elecType.id);
      for (const role of ROLES) {
        const should = ['super_admin', 'admin', 'hr', 'labor_manager'].includes(role);
        const { status: getStatus } = await get(`/skill-assessments?worker_id=${elec.id}`, cookies[role]);
        check(`skill-assessments GET ${should ? 'allowed' : 'denied'} for ${role}`, getStatus === (should ? 200 : 403), `got ${getStatus}`);
      }
      for (const role of ['project_manager', 'site_engineer', 'audit_manager']) {
        const { status } = await post('/skill-assessments/rate', { worker_id: elec.id, [`rating_${cats[0].id}`]: 'expert' }, cookies[role]);
        check(`skill-assessments rate denied for ${role}`, status === 403, `got ${status}`);
      }
      // Rate, then confirm persistence + prefill on reload.
      const { status: rateOk } = await post(
        '/skill-assessments/rate',
        { worker_id: elec.id, [`rating_${cats[0].id}`]: 'expert', [`rating_${cats[1].id}`]: 'trainee' },
        cookies.labor_manager
      );
      check('skill-assessments rate allowed for labor_manager', rateOk === 302, `got ${rateOk}`);
      const ratings = openDb().prepare('SELECT skill_category_id, rating FROM worker_skill_ratings WHERE worker_id = ?').all(elec.id);
      check('2 ratings persisted', ratings.length === 2, `${ratings.length}`);
      const { body: rateForm } = await get(`/skill-assessments?worker_id=${elec.id}`, cookies.admin);
      check('rating form prefilled with saved expert rating', new RegExp(`name="rating_${cats[0].id}"[\\s\\S]*?value="expert"\\s+selected`).test(rateForm));
      const { body: listBody } = await get(`/skill-assessments?worker_type_id=${elecType.id}`, cookies.admin);
      check('worker list shows 2/2 rated summary', listBody.includes('2/2 rated'));
      // Disabling a category removes it from the rating form and the summary count.
      const { status: toggleOff } = await post(`/skill-assessments/categories/${cats[1].id}/toggle`, {}, cookies.admin);
      check('category toggle allowed for admin', toggleOff === 302, `got ${toggleOff}`);
      const { body: formAfterToggle } = await get(`/skill-assessments?worker_id=${elec.id}`, cookies.admin);
      check('disabled category dropped from rating form', !formAfterToggle.includes(`name="rating_${cats[1].id}"`));
      const { body: listAfterToggle } = await get(`/skill-assessments?worker_type_id=${elecType.id}`, cookies.admin);
      check('worker list shows 1/1 rated after category disabled', listAfterToggle.includes('1/1 rated'));
      await post(`/skill-assessments/categories/${cats[1].id}/toggle`, {}, cookies.admin); // restore for cleanliness
      // A worker type with genuinely zero categories (no defaults, none added
      // by this test) gets a clear message, not a crash.
      const weldType = db.prepare(`SELECT id FROM worker_types WHERE name = 'Welder'`).get();
      const welder = openDb().prepare('SELECT id FROM workers WHERE worker_type_id = ? LIMIT 1').get(weldType.id);
      const { status: zeroStatus, body: zeroBody } = await get(`/skill-assessments?worker_id=${welder.id}`, cookies.admin);
      check('worker with 0 categories for their type renders cleanly (no 500)', zeroStatus === 200);
      check('no-categories message shown', zeroBody.includes('No skill categories defined yet'));
      // Rating a worker for a category belonging to a different worker type is silently ignored.
      const { status: crossOk } = await post('/skill-assessments/rate', { worker_id: welder.id, [`rating_${cats[0].id}`]: 'expert' }, cookies.admin);
      const crossCount = openDb().prepare('SELECT COUNT(*) c FROM worker_skill_ratings WHERE worker_id = ?').get(welder.id).c;
      check('rating for wrong worker-type category ignored, not saved', crossOk === 302 && crossCount === 0, `count ${crossCount}`);
      // Category management (v9.4) is its own page, not glued onto the daily
      // rating workflow — admin.full-only, linked from /skill-assessments, and
      // absent from that page's HTML entirely for a role that can rate but
      // can't manage categories (hr, labor_manager).
      for (const role of ['hr', 'labor_manager', 'project_manager', 'site_engineer', 'audit_manager']) {
        const { status } = await get('/skill-assessments/categories', cookies[role]);
        check(`skill-assessments/categories GET denied for ${role}`, status === 403, `got ${status}`);
      }
      const { status: catsPageOk, body: catsPageBody } = await get('/skill-assessments/categories', cookies.admin);
      check('skill-assessments/categories GET allowed for admin', catsPageOk === 200, `got ${catsPageOk}`);
      check('categories page lists Mason with its 5 categories', catsPageBody.includes('Mason'));
      const { body: mainPageAdmin } = await get('/skill-assessments', cookies.admin);
      check('main page links to /skill-assessments/categories for admin', mainPageAdmin.includes('href="/skill-assessments/categories"'));
      const { body: mainPageHr } = await get('/skill-assessments', cookies.hr);
      check('main page has NO manage-categories link for hr (can rate, not manage)', !mainPageHr.includes('/skill-assessments/categories'));
      const { status: addRedirect, location: addLocation } = await post(
        '/skill-assessments/categories',
        { worker_type_id: elecType.id, name: 'Conduit fitting' },
        cookies.admin
      );
      check(
        'adding a category redirects to the categories page',
        addRedirect === 302 && addLocation === '/skill-assessments/categories',
        `status ${addRedirect}, location ${addLocation}`
      );
      // Renaming a category (v9.5): admin.full-only, persists, rejects a
      // duplicate name within the same worker type, and 404s on a bad id.
      const conduitCat = openDb().prepare(`SELECT id FROM skill_categories WHERE worker_type_id = ? AND name = 'Conduit fitting'`).get(elecType.id);
      for (const role of ['hr', 'labor_manager', 'project_manager', 'audit_manager']) {
        const { status } = await post(`/skill-assessments/categories/${conduitCat.id}/rename`, { name: `Nope-${role}` }, cookies[role]);
        check(`skill-category rename denied for ${role}`, status === 403, `got ${status}`);
      }
      const { status: renameOk } = await post(`/skill-assessments/categories/${conduitCat.id}/rename`, { name: 'Conduit installation' }, cookies.admin);
      const renamed = openDb().prepare('SELECT name FROM skill_categories WHERE id = ?').get(conduitCat.id);
      check('skill-category rename allowed for admin, persisted', renameOk === 302 && renamed.name === 'Conduit installation', `POST ${renameOk}, name "${renamed.name}"`);
      const { status: renameDup } = await post(`/skill-assessments/categories/${conduitCat.id}/rename`, { name: 'Wiring' }, cookies.admin);
      const stillRenamed = openDb().prepare('SELECT name FROM skill_categories WHERE id = ?').get(conduitCat.id);
      check(
        'skill-category rename into an existing name rejected, original name kept',
        renameDup === 400 && stillRenamed.name === 'Conduit installation',
        `POST ${renameDup}, name "${stillRenamed.name}"`
      );
      const { status: renameMissing } = await post('/skill-assessments/categories/999999/rename', { name: 'X' }, cookies.admin);
      check('rename of nonexistent category is a clean 404, not a 500', renameMissing === 404, `got ${renameMissing}`);
      const { body: renamePageBody } = await get('/skill-assessments/categories', cookies.admin);
      check('renamed category shows its new name on the categories page', renamePageBody.includes('Conduit installation'));
      // Nav link only for admin/hr/labor_manager (and super_admin).
      for (const role of ['admin', 'hr', 'labor_manager', 'audit_manager', 'project_manager']) {
        const { body } = await get('/', cookies[role]);
        const should = ['admin', 'hr', 'labor_manager'].includes(role);
        check(`nav "Skill assessments" ${should ? 'shown' : 'hidden'} for ${role}`, body.includes('Skill assessments') === should);
      }
    }

    // =====================================================================
    console.log('\n[10] Light/dark theme toggle (v9.5)');
    {
      // No cookie yet -> light by default, rendered as data-theme="light".
      const { body: defaultBody } = await get('/', cookies.admin);
      check('defaults to light theme with no cookie', defaultBody.includes(`data-theme="light"`));
      check('sidebar has a theme toggle link to dark', defaultBody.includes('/theme/toggle?theme=dark'));
      // Toggling sets a cookie and redirects back to the given return path,
      // never off-app even if asked to (open-redirect guard).
      const { status: toggleStatus, location: toggleLocation } = await get('/theme/toggle?theme=dark&return=/workers', cookies.admin);
      check('theme toggle redirects to the requested return path', toggleStatus === 302 && toggleLocation === '/workers', `status ${toggleStatus}, location ${toggleLocation}`);
      const { status: openRedirectStatus, location: openRedirectLocation } = await get('/theme/toggle?theme=dark&return=//evil.example.com', cookies.admin);
      check(
        'theme toggle refuses an off-app return path (protocol-relative //) and falls back to /',
        openRedirectStatus === 302 && openRedirectLocation === '/',
        `location ${openRedirectLocation}`
      );
      // Simulate the browser actually carrying the cookie on the next request.
      const darkCookie = cookies.admin + '; theme=dark';
      const { body: darkBody } = await get('/', darkCookie);
      check('page renders data-theme="dark" once the theme cookie is set', darkBody.includes(`data-theme="dark"`));
      check('sidebar toggle now points back to light', darkBody.includes('/theme/toggle?theme=light'));
      // Works pre-login too (the login page has its own floating toggle).
      const { body: loginDark } = await get('/login', 'theme=dark');
      check('login page (logged out) also respects the theme cookie', loginDark.includes(`data-theme="dark"`) && loginDark.includes('theme-toggle-floating'));
    }

    // =====================================================================
    console.log('\n[11] Full page sweep: no 500s anywhere, any role');
    {
      for (const role of ROLES) {
        for (const page of Object.keys(PAGE_EXPECT)) {
          const { status } = await get(page, cookies[role]);
          check(`no 500 on ${page} as ${role}`, status !== 500, `got ${status}`);
        }
      }
    }

    // =====================================================================
    console.log('\n[12] CSRF protection (v9.8)');
    {
      const workerCountBefore = () => openDb().prepare('SELECT COUNT(*) c FROM workers').get().c;

      // ---- POST /login itself is protected ----
      {
        const getRes = await fetch(`${BASE}/login`, { redirect: 'manual' });
        const anonCookie = extractSetCookie(getRes, 'csrf_anon');
        const noToken = await fetch(`${BASE}/login`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: anonCookie },
          body: `username=admin&password=admin123`,
        });
        check('login with no _csrf field is rejected', noToken.status === 403, `got ${noToken.status}`);
        const badToken = await fetch(`${BASE}/login`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: anonCookie },
          body: `username=admin&password=admin123&_csrf=${'0'.repeat(64)}`,
        });
        check('login with a wrong _csrf value is rejected', badToken.status === 403, `got ${badToken.status}`);
        // Neither rejected attempt should have logged anyone in.
        check('rejected login attempts issue no session cookie', !(noToken.headers.get('set-cookie') || '').includes('session=') && !(badToken.headers.get('set-cookie') || '').includes('session='));
        // Sanity: a fresh anon cookie + its real token logs in fine — proves
        // the two rejections above failed on the token, not on something
        // incidental (cookie, credentials, route). (Covered end-to-end
        // anyway by every cookies[role] = await login(role) call earlier in
        // this suite, which already goes through the real token path.)
        check('sanity: login() itself (used by every earlier section) already proves a valid token works', typeof cookies.admin === 'string' && cookies.admin.startsWith('session='));
      }

      // ---- Missing/invalid token on an authenticated mutation ----
      {
        const before = workerCountBefore();
        const payload = 'name=CSRFTest&worker_type_id=1&vendor_id=1&aadhar_number=999911112222&wage_rate=100&contact=9876500000';
        const missing = await fetch(`${BASE}/workers`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies.admin },
          body: payload, // deliberately no &_csrf=...
        });
        check('POST /workers with a missing _csrf field is rejected', missing.status === 403, `got ${missing.status}`);
        const invalid = await fetch(`${BASE}/workers`, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookies.admin },
          body: `${payload}&_csrf=${'a'.repeat(64)}`,
        });
        check('POST /workers with an invalid _csrf value is rejected', invalid.status === 403, `got ${invalid.status}`);
        check('no worker row was written by either rejected request', workerCountBefore() === before, `before=${before} after=${workerCountBefore()}`);
      }

      // ---- Cross-session token ----
      {
        const adminToken = await csrfTokenFor(cookies.admin);
        const hrToken = await csrfTokenFor(cookies.hr);
        check('sanity: admin and hr sessions have different tokens', adminToken !== hrToken && adminToken && hrToken);
        const before = workerCountBefore();
        const res = await postRaw(
          '/workers',
          { name: 'CrossSession', worker_type_id: 1, vendor_id: 1, aadhar_number: '999922223333', wage_rate: 100, contact: '9876511111', _csrf: hrToken },
          cookies.admin // admin's session cookie, but hr's token
        );
        check('a token minted for a different session is rejected', res.status === 403, `got ${res.status}`);
        check('no worker row was written by the cross-session attempt', workerCountBefore() === before);
      }

      // ---- An action-only form (no other fields) still needs a real token ----
      {
        const wt = openDb().prepare('SELECT id, active FROM worker_types LIMIT 1').get();
        const before = openDb().prepare('SELECT active FROM worker_types WHERE id = ?').get(wt.id).active;
        const res = await postRaw(`/worker-types/${wt.id}/toggle`, {}, cookies.admin);
        check('a toggle-only POST with no _csrf field is rejected', res.status === 403, `got ${res.status}`);
        const after = openDb().prepare('SELECT active FROM worker_types WHERE id = ?').get(wt.id).active;
        check('the toggle-only POST made no change when rejected', after === before, `before=${before} after=${after}`);
      }

      // ---- Oversized token is rejected safely (no crash / no hang) ----
      {
        const res = await postRaw('/workers', { _csrf: '9'.repeat(5000) }, cookies.admin);
        check('an oversized _csrf value is rejected without a server error', res.status === 403, `got ${res.status}`);
      }

      // ---- Excluded-by-design GET routes remain untouched ----
      {
        const res = await fetch(`${BASE}/theme/toggle?theme=dark`, { redirect: 'manual', headers: { Cookie: cookies.admin } });
        check('GET /theme/toggle still works with no CSRF token (documented exclusion)', res.status === 302);
        await fetch(`${BASE}/theme/toggle?theme=light`, { redirect: 'manual', headers: { Cookie: cookies.admin } }); // reset
      }

      // ---- Logout: GET must not delete the session, POST must be CSRF-checked ----
      {
        const lo = await login('admin');
        const getLogout = await fetch(`${BASE}/logout`, { redirect: 'manual', headers: { Cookie: lo } });
        check('GET /logout does not log the app in as logged-out (no session deletion)', getLogout.status === 302 && getLogout.headers.get('location') !== '/login');
        const stillIn = await get('/', lo);
        check('session from before a GET /logout is still valid afterward', stillIn.status === 200);

        const badLogout = await postRaw('/logout', {}, lo); // no _csrf
        check('POST /logout with no _csrf field is rejected', badLogout.status === 403, `got ${badLogout.status}`);
        const stillIn2 = await get('/', lo);
        check('session survives a CSRF-rejected POST /logout', stillIn2.status === 200);

        const goodToken = await csrfTokenFor(lo);
        const goodLogout = await postRaw('/logout', { _csrf: goodToken }, lo);
        check('POST /logout with a valid _csrf field redirects to /login', goodLogout.status === 302 && goodLogout.location === '/login');
        const loggedOutNow = await get('/', lo);
        check('session is actually gone after a valid POST /logout', loggedOutNow.status === 302 && loggedOutNow.location === '/login');
      }

      // ---- Sidebar renders logout as a form, not a bare link ----
      {
        const { body } = await get('/', cookies.hr);
        check('sidebar logout control is a POST form (not a plain GET link)', body.includes('action="/logout"') && body.includes('method="POST"') && !body.includes('href="/logout"'));
      }

      // ---- v10: change-password POST is CSRF-checked too, like every other mutation ----
      {
        const res = await postRaw('/account/change-password', { current_password: 'admin123', new_password: 'irrelevant1', confirm_password: 'irrelevant1' }, cookies.admin);
        check('POST /account/change-password with no _csrf field is rejected', res.status === 403, `got ${res.status}`);
      }
    }

    // =====================================================================
    console.log('\n[13] Dashboard/Analytics split (v9.9)');
    {
      const ANALYTICS_MARKERS = ['Vendor comparison', 'Payroll cost trend', 'Site performance impact', 'Attendance %'];

      // ---- /analytics: authorized vs unauthorized (1, 2, 3) ----
      for (const role of OVERSIGHT) {
        const { status, body } = await get('/analytics', cookies[role]);
        check(`/analytics returns 200 for ${role}`, status === 200, `got ${status}`);
        check(`/analytics for ${role} contains all four analytics sections`, ANALYTICS_MARKERS.every((m) => body.includes(m)), `missing: ${ANALYTICS_MARKERS.filter((m) => !body.includes(m)).join(', ')}`); // (9)
      }
      for (const role of ['project_manager', 'site_engineer']) {
        const { status, body } = await get('/analytics', cookies[role]);
        check(`/analytics returns 403 for ${role}`, status === 403, `got ${status}`);
        // Practical proxy for "the analytics queries never ran": a 403 body
        // is the generic forbidden() page, not the report — if
        // renderAnalyticsSection() had somehow been reached and thrown or
        // rendered, this would either fail loudly or leak its markers here.
        check(`/analytics 403 body for ${role} carries none of the analytics content`, !ANALYTICS_MARKERS.some((m) => body.includes(m))); // (3)
      }

      // ---- Dashboard no longer renders the analytics block (4) ----
      for (const role of OVERSIGHT) {
        const { body } = await get('/', cookies[role]);
        check(`Dashboard for ${role} no longer contains analytics-section markers`, !ANALYTICS_MARKERS.some((m) => body.includes(m)));
      }

      // ---- Dashboard retains everything else it should (5) ----
      {
        const { body } = await get('/', cookies.admin);
        check('Dashboard (admin) still has stat tiles', body.includes('Active workers') && body.includes('Present today'));
        check('Dashboard (admin) still has the payroll-runs summary', body.includes('Payroll runs generated'));
        check('Dashboard (admin) still has Sites overview', body.includes('Sites overview'));
      }

      // ---- Action buttons now appear before Sites overview (6) ----
      {
        const { body } = await get('/', cookies.admin);
        const actionsIdx = body.indexOf('class="actions"');
        const sitesIdx = body.indexOf('Sites overview');
        check('action buttons render before Sites overview in the HTML', actionsIdx !== -1 && sitesIdx !== -1 && actionsIdx < sitesIdx, `actions@${actionsIdx} sites@${sitesIdx}`);
      }

      // ---- "View full analytics" link: visible only with analytics.view (7, 8) ----
      for (const role of OVERSIGHT) {
        const { body } = await get('/', cookies[role]);
        check(`${role} sees the "View full analytics" link on the Dashboard`, body.includes('href="/analytics"') && body.includes('View full analytics'));
      }
      for (const role of ['project_manager', 'site_engineer']) {
        const { body } = await get('/', cookies[role]);
        check(`${role} does not see the analytics link`, !body.includes('href="/analytics"'));
        check(`${role} does not see an empty "Reports" nav group`, !body.includes('>Reports<'));
      }
      // A role WITH analytics.view should see the Reports group heading.
      {
        const { body } = await get('/', cookies.hr);
        check('hr (has analytics.view) sees the Reports nav group', body.includes('>Reports<'));
      }

      // ---- Non-oversight Dashboard otherwise unchanged (10) ----
      {
        const { status, body } = await get('/', cookies.project_manager);
        check('project_manager Dashboard still 200s and shows stat tiles', status === 200 && body.includes('Active workers'));
        check('project_manager Dashboard still shows action buttons', body.includes('class="actions"'));
      }
    }

    // =====================================================================
    console.log('\n[14] v10: role reduction — unsupported roles cannot be selected/submitted anywhere');
    {
      const db = openDb();
      // Nowhere in the /users create or edit forms is a removed role offered.
      const { body: usersPage } = await get('/users', cookies.admin);
      for (const removed of ['supervisor', 'operation_head', 'ceo']) {
        check(`Users create-form role dropdown does not offer '${removed}'`, !new RegExp(`<option value="${removed}"[^>]*>`).test(usersPage), removed);
      }
      // Direct request manipulation: submitting a removed/garbage role value
      // to create or update a user is rejected, not silently accepted.
      for (const badRole of ['supervisor', 'operation_head', 'ceo', 'totally-made-up-role']) {
        const { status } = await post('/users', { name: 'Hacker', username: `hacker-${badRole}@x.example`, password: 'password8', role: badRole, contact: '9876543210' }, cookies.admin);
        check(`POST /users with unsupported role '${badRole}' rejected (400)`, status === 400, `got ${status}`);
        const created = db.prepare('SELECT id FROM users WHERE username = ?').get(`hacker-${badRole}@x.example`);
        check(`no user row created for unsupported role '${badRole}'`, !created);
      }
      const hrUser = db.prepare(`SELECT id FROM users WHERE username = 'hr'`).get();
      for (const badRole of ['supervisor', 'operation_head', 'ceo', 'totally-made-up-role']) {
        const { status } = await post(`/users/${hrUser.id}`, { name: 'Rohit Mehta', username: 'hr', contact: '9800000011', role: badRole }, cookies.admin);
        check(`POST /users/:id (edit) with unsupported role '${badRole}' rejected (400)`, status === 400, `got ${status}`);
      }
      const hrStillHr = openDb().prepare('SELECT role FROM users WHERE id = ?').get(hrUser.id).role;
      check("hr's role unchanged after rejected edit attempts", hrStillHr === 'hr', hrStillHr);
    }

    // =====================================================================
    console.log('\n[15] v10: Super Admin protections');
    {
      const db = openDb();
      // ---- An Admin actor cannot even see 'super_admin' as an option ----
      const { body: usersPageAsAdmin } = await get('/users', cookies.admin);
      check("Admin's Users create-form role dropdown does not offer 'super_admin'", !/<option value="super_admin"[^>]*>(?!.*disabled)/.test(usersPageAsAdmin) || !usersPageAsAdmin.includes('<option value="super_admin" >'));
      const { body: usersPageAsSuperAdmin } = await get('/users', cookies.super_admin);
      check("Super Admin's Users create-form role dropdown DOES offer 'super_admin'", /<option value="super_admin"/.test(usersPageAsSuperAdmin));

      // ---- Admin cannot promote anyone (including self) to Super Admin ----
      const { status: promoteViaCreate } = await post('/users', { name: 'Wannabe', username: 'wannabe@x.example', password: 'password8', role: 'super_admin', contact: '9876543210' }, cookies.admin);
      check('Admin creating a user with role=super_admin is rejected (403)', promoteViaCreate === 403, `got ${promoteViaCreate}`);
      const wannabe = db.prepare(`SELECT id FROM users WHERE username = 'wannabe@x.example'`).get();
      check('no super_admin user was created by the attempt', !wannabe);
      const adminOwnId = db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get().id;
      const { status: selfPromote } = await post(`/users/${adminOwnId}`, { name: 'Asha Verma', username: 'admin', contact: '9800000010', role: 'super_admin' }, cookies.admin);
      check('Admin cannot self-promote to super_admin via edit (403)', selfPromote === 403, `got ${selfPromote}`);
      const adminRoleAfter = openDb().prepare('SELECT role FROM users WHERE id = ?').get(adminOwnId).role;
      check("admin's own role is unchanged after the self-promote attempt", adminRoleAfter === 'admin', adminRoleAfter);

      // ---- Admin cannot touch an existing Super Admin account at all ----
      const superAdminId = db.prepare(`SELECT id FROM users WHERE username = 'superadmin1'`).get().id;
      const { status: editGetBlocked } = await get(`/users/${superAdminId}/edit`, cookies.admin);
      check('Admin GET /users/:id/edit on a super_admin target is forbidden (403)', editGetBlocked === 403, `got ${editGetBlocked}`);
      const { status: editPostBlocked } = await post(`/users/${superAdminId}`, { name: 'Tampered', username: 'superadmin1', contact: '9800000009', role: 'super_admin' }, cookies.admin);
      check('Admin POST /users/:id on a super_admin target is forbidden (403)', editPostBlocked === 403, `got ${editPostBlocked}`);
      const nameUnchanged = openDb().prepare('SELECT name FROM users WHERE id = ?').get(superAdminId).name;
      check("super_admin's name unchanged after Admin's blocked edit attempt", nameUnchanged !== 'Tampered', nameUnchanged);
      const { status: toggleBlocked } = await post(`/users/${superAdminId}/toggle`, {}, cookies.admin);
      check('Admin POST /users/:id/toggle on a super_admin target is forbidden (403)', toggleBlocked === 403, `got ${toggleBlocked}`);
      const activeUnchanged = openDb().prepare('SELECT active FROM users WHERE id = ?').get(superAdminId).active;
      check('super_admin still active after Admin\'s blocked toggle attempt', activeUnchanged === 1, activeUnchanged);

      // ---- A Super Admin actor is unrestricted: can edit/manage another Super Admin ----
      const { status: superEditGet } = await get(`/users/${superAdminId}/edit`, cookies.super_admin);
      check('Super Admin GET /users/:id/edit on a super_admin target is allowed (200)', superEditGet === 200, `got ${superEditGet}`);

      // ---- Last active Super Admin cannot be disabled ----
      const { status: lastSaToggle } = await post(`/users/${superAdminId}/toggle`, {}, cookies.super_admin);
      check('the last active Super Admin cannot disable themself/be disabled (400)', lastSaToggle === 400, `got ${lastSaToggle}`);
      const stillActive = openDb().prepare('SELECT active FROM users WHERE id = ?').get(superAdminId).active;
      check('last active Super Admin is still active after the blocked toggle', stillActive === 1, stillActive);

      // ---- User-management audit entries record the role involved ----
      // Everything above this point in section [15] was a REJECTED action
      // (403/400), so none of it reached logAudit() — create then edit a
      // throwaway account (seeded accounts like 'hr' have non-email
      // usernames, exempt only from the create-time UI convention, not the
      // edit route's EMAIL_RE check) to actually generate user-management
      // audit rows, then confirm they carry role context.
      const { status: auditFixtureCreate } = await post(
        '/users',
        { name: 'Audit Fixture', username: 'audit-fixture@x.example', password: 'password8', role: 'hr', contact: '9876500099' },
        cookies.admin
      );
      check('audit-fixture account created (for the audit check below)', auditFixtureCreate === 302, `got ${auditFixtureCreate}`);
      const auditFixtureId = db.prepare(`SELECT id FROM users WHERE username = 'audit-fixture@x.example'`).get().id;
      const { status: benignEdit } = await post(`/users/${auditFixtureId}`, { name: 'Audit Fixture', username: 'audit-fixture@x.example', contact: '9876500099', role: 'hr' }, cookies.admin);
      check('benign edit of the audit-fixture account succeeds', benignEdit === 302, `got ${benignEdit}`);
      const lastAudit = openDb().prepare(`SELECT details FROM audit_log WHERE entity_type = 'user' ORDER BY id DESC LIMIT 5`).all();
      check('recent user-management audit entries include role context', lastAudit.some((r) => (r.details || '').includes('role:')), JSON.stringify(lastAudit));
    }

    // =====================================================================
    console.log('\n[16] v10: deactivated accounts cannot authenticate, immediately');
    {
      const db = openDb();
      // Create a throwaway HR account via the real route, log in as it, then
      // deactivate it as admin — the existing session must stop working on
      // its very next request (not just future logins).
      const { status: createStatus } = await post(
        '/users',
        { name: 'Throwaway HR', username: 'throwaway-hr@x.example', password: 'ThrowawayPass1', role: 'hr', contact: '9876500001' },
        cookies.admin
      );
      check('throwaway account created for the deactivation test', createStatus === 302, `got ${createStatus}`);
      const throwawayCookie = await loginWithCreds('throwaway-hr@x.example', 'ThrowawayPass1');
      check('throwaway account can log in while active', typeof throwawayCookie === 'string');
      const { status: beforeDeactivate } = await get('/', throwawayCookie);
      check('throwaway session works before deactivation', beforeDeactivate === 200, `got ${beforeDeactivate}`);
      const throwawayId = db.prepare(`SELECT id FROM users WHERE username = 'throwaway-hr@x.example'`).get().id;
      const { status: toggleStatus } = await post(`/users/${throwawayId}/toggle`, {}, cookies.admin);
      check('admin can deactivate the throwaway account', toggleStatus === 302, `got ${toggleStatus}`);
      // The now-deactivated user's EXISTING session must stop working immediately.
      const { status: afterDeactivate, location: afterLoc } = await get('/', throwawayCookie);
      check('deactivated account\'s existing session is rejected on its very next request', afterDeactivate === 302 && afterLoc === '/login', `status ${afterDeactivate}, location ${afterLoc}`);
      // And a fresh login attempt with the right password is refused too.
      const relog = await loginWithCreds('throwaway-hr@x.example', 'ThrowawayPass1');
      check('deactivated account cannot log in again even with the correct password', relog === null, relog);

      // ---- v10 follow-up fix: a REMOVED-role account can't be resurrected
      // by simply toggling it back active. The /users/:id/toggle route only
      // ever flips `active`, never `role` — before this fix, re-enabling a
      // deactivated 'supervisor'/'operation_head'/'ceo' row would silently
      // let that removed role log in again. Insert a legacy-role row
      // directly (bypassing the app's own create-time role validation, the
      // same way an old pre-v10 row already on disk would look), disable
      // it, then confirm re-enabling it is refused. ----
      // Hash/salt values don't need to be real/verifiable — this account is
      // expected to stay unable to log in either way, so a placeholder is
      // fine (avoids pulling in src/auth.js, which would open its own
      // separate db connection outside this suite's TEST_DB plumbing).
      db.prepare(
        `INSERT INTO users (username, password_hash, salt, name, role, contact, active) VALUES (?, ?, ?, ?, 'supervisor', ?, 0)`
      ).run('legacy-supervisor@x.example', 'placeholder-hash', 'placeholder-salt', 'Legacy Supervisor', '9876500003');
      const legacyId = db.prepare(`SELECT id FROM users WHERE username = 'legacy-supervisor@x.example'`).get().id;
      const { status: reactivateStatus } = await post(`/users/${legacyId}/toggle`, {}, cookies.admin);
      check("re-enabling a deactivated account with a removed role ('supervisor') is refused (400)", reactivateStatus === 400, `got ${reactivateStatus}`);
      const legacyStillInactive = openDb().prepare('SELECT active FROM users WHERE id = ?').get(legacyId).active;
      check('the legacy-role account is still inactive after the refused re-enable', legacyStillInactive === 0, legacyStillInactive);
      const legacyLoginAttempt = await loginWithCreds('legacy-supervisor@x.example', 'LegacyPass1');
      check('the legacy-role account still cannot log in (it was never actually re-enabled)', legacyLoginAttempt === null, legacyLoginAttempt);
    }

    // =====================================================================
    console.log('\n[17] v10: forced password change on first login');
    {
      const db = openDb();
      const { status: createStatus } = await post(
        '/users',
        { name: 'Temp Password User', username: 'temppw@x.example', password: 'InitialTemp1', role: 'hr', contact: '9876500002', must_change_password: '1' },
        cookies.admin
      );
      check('temp-password account created', createStatus === 302, `got ${createStatus}`);
      const tempRow = db.prepare(`SELECT must_change_password FROM users WHERE username = 'temppw@x.example'`).get();
      check('new account stored with must_change_password = 1', tempRow.must_change_password === 1, tempRow.must_change_password);

      const tempCookie = await loginWithCreds('temppw@x.example', 'InitialTemp1');
      check('temp-password account can log in', typeof tempCookie === 'string');

      // Any GET (other than the change-password screen itself) bounces there.
      const { status: dashStatus, location: dashLoc } = await get('/', tempCookie);
      check('GET / redirects to the forced change-password screen', dashStatus === 302 && dashLoc === '/account/change-password', `status ${dashStatus}, location ${dashLoc}`);
      const { status: workersStatus, location: workersLoc } = await get('/workers', tempCookie);
      check('GET /workers also redirects to the forced change-password screen', workersStatus === 302 && workersLoc === '/account/change-password', `status ${workersStatus}, location ${workersLoc}`);
      const { status: changePageStatus } = await get('/account/change-password', tempCookie);
      check('GET /account/change-password itself is reachable (not redirected)', changePageStatus === 200, `got ${changePageStatus}`);

      // A POST to anything else is rejected outright while the flag is set.
      const { status: blockedPost } = await post('/workers', { name: 'X', worker_type_id: 1, vendor_id: 1, aadhar_number: '999900009999', wage_rate: 100, contact: '9876543210' }, tempCookie);
      check('POST to an unrelated route is rejected (403) while must_change_password is set', blockedPost === 403, `got ${blockedPost}`);

      // Wrong current password rejected.
      const { status: wrongCurrent } = await post('/account/change-password', { current_password: 'NotTheRealPassword', new_password: 'BrandNewPass1', confirm_password: 'BrandNewPass1' }, tempCookie);
      check('change-password with wrong current password rejected (400)', wrongCurrent === 400, `got ${wrongCurrent}`);

      // Mismatched confirmation rejected.
      const { status: mismatch } = await post('/account/change-password', { current_password: 'InitialTemp1', new_password: 'BrandNewPass1', confirm_password: 'DoesNotMatch1' }, tempCookie);
      check('change-password with mismatched confirmation rejected (400)', mismatch === 400, `got ${mismatch}`);

      // Too-short new password rejected.
      const { status: tooShort } = await post('/account/change-password', { current_password: 'InitialTemp1', new_password: 'short1', confirm_password: 'short1' }, tempCookie);
      check('change-password with a too-short new password rejected (400)', tooShort === 400, `got ${tooShort}`);

      // The flag is still set after all the rejected attempts.
      const stillFlagged = openDb().prepare(`SELECT must_change_password FROM users WHERE username = 'temppw@x.example'`).get().must_change_password;
      check('must_change_password still set after rejected attempts', stillFlagged === 1, stillFlagged);

      // Successful change clears the flag and unblocks the account.
      const { status: changeOk } = await post('/account/change-password', { current_password: 'InitialTemp1', new_password: 'BrandNewPass1', confirm_password: 'BrandNewPass1' }, tempCookie);
      check('valid change-password succeeds (302)', changeOk === 302, `got ${changeOk}`);
      const cleared = openDb().prepare(`SELECT must_change_password FROM users WHERE username = 'temppw@x.example'`).get().must_change_password;
      check('must_change_password cleared after a successful change', cleared === 0, cleared);
      const { status: dashAfter } = await get('/', tempCookie);
      check('the same session can now reach the Dashboard normally', dashAfter === 200, `got ${dashAfter}`);

      // The OLD (temp) password no longer works; the NEW one does.
      const oldStillWorks = await loginWithCreds('temppw@x.example', 'InitialTemp1');
      check('the old temporary password no longer logs in', oldStillWorks === null);
      const newWorks = await loginWithCreds('temppw@x.example', 'BrandNewPass1');
      check('the new password logs in successfully', typeof newWorks === 'string');

      // A password reset from the Users page (checkbox left on) re-flags the account.
      const tempUserId = db.prepare(`SELECT id FROM users WHERE username = 'temppw@x.example'`).get().id;
      const { status: resetStatus } = await post(
        `/users/${tempUserId}`,
        { name: 'Temp Password User', username: 'temppw@x.example', contact: '9876500002', role: 'hr', password: 'ResetByAdmin1', must_change_password: '1' },
        cookies.admin
      );
      check('admin password-reset with the checkbox on succeeds', resetStatus === 302, `got ${resetStatus}`);
      const reflagged = openDb().prepare(`SELECT must_change_password FROM users WHERE id = ?`).get(tempUserId).must_change_password;
      check('must_change_password re-set by an admin password reset', reflagged === 1, reflagged);
    }

    // =====================================================================
    console.log('\n[18] v10.1: permanent user deletion, alongside deactivation');
    {
      const db = openDb();

      // ---- Access control: same admin.full + Super-Admin-guard gating as
      // the other /users routes ----
      const someTarget = db.prepare(`SELECT id FROM users WHERE username = 'hr'`).get();
      const { status: deleteDeniedForLM } = await post(`/users/${someTarget.id}/delete`, {}, cookies.labor_manager);
      check('delete denied for a non-admin.full role (403)', deleteDeniedForLM === 403, `got ${deleteDeniedForLM}`);
      const superAdminRow = db.prepare(`SELECT id FROM users WHERE role = 'super_admin'`).get();
      const { status: deleteSuperAdminByAdmin } = await post(`/users/${superAdminRow.id}/delete`, {}, cookies.admin);
      check('Admin cannot delete a Super Admin account (403)', deleteSuperAdminByAdmin === 403, `got ${deleteSuperAdminByAdmin}`);
      const superAdminStillThere = openDb().prepare('SELECT id FROM users WHERE id = ?').get(superAdminRow.id);
      check('the Super Admin account still exists after the blocked delete attempt', !!superAdminStillThere);

      // ---- Self-delete is refused ----
      // Isolated from the "last active admin" guard on purpose: 'admin' is
      // the only admin account in this seed, so testing self-delete against
      // it would pass for the WRONG reason (masked by that other guard,
      // which returns the same 400 status) — exactly the kind of
      // test-isolation bug a mutation test on the self-guard alone would
      // catch. A second, throwaway admin account removes that ambiguity:
      // with two active admins, only the self-delete guard can explain a
      // 400 here.
      const { status: secondAdminCreate } = await post(
        '/users',
        { name: 'Second Admin', username: 'second-admin@x.example', password: 'password8', role: 'admin', contact: '9876500007' },
        cookies.admin
      );
      check('second admin account created (isolates the self-delete guard from the last-active-admin guard)', secondAdminCreate === 302, `got ${secondAdminCreate}`);
      const secondAdminCookie = await loginWithCreds('second-admin@x.example', 'password8');
      const secondAdminId = db.prepare(`SELECT id FROM users WHERE username = 'second-admin@x.example'`).get().id;
      const { status: selfDelete, body: selfDeleteBody } = await post(`/users/${secondAdminId}/delete`, {}, secondAdminCookie);
      check("an admin can't delete their own account, even with another active admin available (400)", selfDelete === 400, `got ${selfDelete}`);
      // Assert the SPECIFIC self-delete guard message, not just any 400.
      // Without this, disabling the explicit self-delete guard would still
      // read as "passing": logAudit() attributes a delete to the ACTOR, so
      // a self-delete's own audit_log insert self-references the very row
      // being deleted, and the audit_log.user_id FK constraint blocks the
      // DELETE anyway — a genuine, independent backstop, but one that masks
      // the explicit guard under a status-code-only check (confirmed via
      // mutation testing: disabling the guard still returned 400, with the
      // generic "has historical records" message instead of this one).
      check(
        "the self-delete refusal is the explicit guard's own message, not a different 400 (e.g. the FK backstop)",
        /delete your own account/i.test(selfDeleteBody),
        selfDeleteBody
      );
      const selfStillThere = openDb().prepare('SELECT id FROM users WHERE id = ?').get(secondAdminId);
      check('the acting admin account still exists after the blocked self-delete', !!selfStillThere);

      // ---- Last active admin / last active Super Admin can't be deleted
      // (mirrors the equivalent toggle-disable protections) ----
      // Remove the throwaway second admin first (it's zero-footprint, so
      // this delete itself should succeed cleanly) so 'admin' is once again
      // the SOLE active admin — otherwise the "last active admin" check
      // wouldn't fire at all with two admins present.
      const { status: secondAdminDelete } = await post(`/users/${secondAdminId}/delete`, {}, cookies.admin);
      check('the throwaway second admin (zero footprint) can be cleanly deleted', secondAdminDelete === 302, `got ${secondAdminDelete}`);
      const adminOwnRow = db.prepare(`SELECT id FROM users WHERE username = 'admin'`).get();
      const { status: deleteLastAdmin, body: deleteLastAdminBody } = await post(`/users/${adminOwnRow.id}/delete`, {}, cookies.super_admin);
      check('the last active admin cannot be deleted even by a Super Admin (400)', deleteLastAdmin === 400, `got ${deleteLastAdmin}`);
      // Assert the SPECIFIC guard fired (not just "some 400", which could
      // also be explained by 'admin' having FK-referenced audit_log rows as
      // actor — a different, also-true-but-different refusal reason).
      check(
        'the refusal is specifically the last-active-admin guard, not a different one (message says so)',
        /last active admin/i.test(deleteLastAdminBody),
        deleteLastAdminBody
      );
      // Note: with only one Super Admin in the seed, this exercises the
      // self-delete guard (which fires first) rather than the last-active-
      // Super-Admin guard in isolation — mirroring the same, already-
      // documented defense-in-depth situation on the toggle route. The
      // last-active-Super-Admin check is real code but not independently
      // reachable here; it stays as a backstop for topologies with >1
      // Super Admin that this seed doesn't construct.
      const { status: deleteLastSuperAdmin } = await post(`/users/${superAdminRow.id}/delete`, {}, cookies.super_admin);
      check('a Super Admin cannot delete themself (blocked by self-delete guard; last-active-Super-Admin is unreachable backstop here) (400)', deleteLastSuperAdmin === 400, `got ${deleteLastSuperAdmin}`);

      // ---- A zero-footprint account (never referenced by attendance/
      // payroll/audit/anything) CAN be permanently deleted ----
      const { status: freshCreate } = await post(
        '/users',
        { name: 'Never Used Account', username: 'never-used@x.example', password: 'password8', role: 'hr', contact: '9876500005' },
        cookies.admin
      );
      check('zero-footprint account created for the delete test', freshCreate === 302, `got ${freshCreate}`);
      const freshId = db.prepare(`SELECT id FROM users WHERE username = 'never-used@x.example'`).get().id;
      const { status: freshDelete } = await post(`/users/${freshId}/delete`, {}, cookies.admin);
      check('a zero-footprint account can be permanently deleted (302)', freshDelete === 302, `got ${freshDelete}`);
      const freshGone = openDb().prepare('SELECT id FROM users WHERE id = ?').get(freshId);
      check('the deleted account row is actually gone from the database', !freshGone);
      const deleteAuditRow = openDb().prepare(`SELECT details FROM audit_log WHERE entity_type = 'user' AND entity_id = ? AND action = 'delete'`).get(freshId);
      check('the deletion itself is recorded in the audit trail (with role/status/created_at)', !!deleteAuditRow && deleteAuditRow.details.includes('role: hr') && deleteAuditRow.details.includes('permanently deleted'), deleteAuditRow && deleteAuditRow.details);

      // ---- An account WITH historical footprint is refused, not silently
      // partially deleted, and the row is left completely untouched ----
      const { status: busyCreate } = await post(
        '/users',
        { name: 'Has History Account', username: 'has-history@x.example', password: 'password8', role: 'hr', contact: '9876500006' },
        cookies.admin
      );
      check('has-history account created for the delete-refusal test', busyCreate === 302, `got ${busyCreate}`);
      const busyId = db.prepare(`SELECT id FROM users WHERE username = 'has-history@x.example'`).get().id;
      const busyCookie = await loginWithCreds('has-history@x.example', 'password8');
      check('has-history account can log in', typeof busyCookie === 'string');
      const someWorker = db.prepare(`SELECT id, site_id FROM workers WHERE status = 'active' LIMIT 1`).get();
      const { status: markStatus } = await post(
        '/attendance/entry',
        { worker_id: someWorker.id, site_id: someWorker.site_id, date: '2026-09-10', hours: 4, leave: 0, ot: 0 },
        busyCookie
      );
      check('has-history account marks one attendance entry (creates the FK reference)', markStatus === 302, `got ${markStatus}`);
      const totalBefore = openDb().prepare('SELECT COUNT(*) c FROM users').get().c;
      const sessionsBefore = openDb().prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(busyId).c;
      const { status: busyDeleteStatus, body: busyDeleteBody } = await post(`/users/${busyId}/delete`, {}, cookies.admin);
      check('deleting an account with real history is refused (400), not silently accepted', busyDeleteStatus === 400, `got ${busyDeleteStatus}`);
      check('the refusal message explains why and suggests deactivating instead', /historical records/.test(busyDeleteBody) && /[Dd]eactivate/.test(busyDeleteBody));
      const busyStillThere = openDb().prepare('SELECT id, active FROM users WHERE id = ?').get(busyId);
      check('the has-history account row still exists after the refused delete (nothing was partially deleted)', !!busyStillThere);
      const totalAfter = openDb().prepare('SELECT COUNT(*) c FROM users').get().c;
      check('user count is unchanged after the refused delete (transaction rolled back cleanly)', totalAfter === totalBefore, `${totalBefore} -> ${totalAfter}`);
      const attendanceStillThere = openDb().prepare(`SELECT COUNT(*) c FROM attendance WHERE marked_by = ?`).get(busyId).c;
      check("the account's attendance record is untouched (not orphaned by a partial delete)", attendanceStillThere === 1, attendanceStillThere);
      // The account is, however, still perfectly deactivatable — that's the
      // intended fallback for exactly this case.
      const { status: busyToggleStatus } = await post(`/users/${busyId}/toggle`, {}, cookies.admin);
      check('the has-history account CAN still be deactivated instead (302)', busyToggleStatus === 302, `got ${busyToggleStatus}`);
      const busyNowInactive = openDb().prepare('SELECT active FROM users WHERE id = ?').get(busyId).active;
      check('the has-history account is now inactive (deactivate-instead worked)', busyNowInactive === 0, busyNowInactive);
    }
  } finally {
    server.kill('SIGKILL');
  }

  console.log(`\n========================================`);
  console.log(`PASS ${passed}  FAIL ${failed}  (total ${passed + failed})`);
  if (failed > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
