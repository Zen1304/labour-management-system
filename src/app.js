'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const db = require('./db');
const auth = require('./auth');
const csrf = require('./csrf');
// Renamed on import: handleRequest defines its own per-request `layout`
// wrapper below (closing over that request's theme cookie) so every one of
// the ~65 `layout({...})` call sites in this file stays untouched — see the
// wrapper definition for why a module-level "current theme" variable would
// be a real concurrency bug instead.
const { esc, fmtMoney, layout: renderLayout } = require('./render');
const { parseCookies, parseFormBody, todayStr } = require('./helpers');
const { svgLineChart, svgBarChart, miniBar } = require('./charts');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const POOL_SITE_ID = 100;
// Off by default so a plain local HTTP deployment (the documented normal
// case for this internal LAN app) never breaks login by asking the browser
// to withhold a Secure-flagged cookie over a non-HTTPS connection. Set
// COOKIE_SECURE=true once this app is served behind TLS (directly or via a
// reverse proxy) to add the Secure flag to the session, anon-CSRF, and theme
// cookies.
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true' ? '; Secure' : '';
const AADHAR_RE = /^\d{12}$/;
// Plain digits only, 10-15 long — covers a 10-digit Indian mobile number up
// through an E.164-style number with country code, without getting fussy
// about spaces/dashes (the form strips those before validating).
const PHONE_RE = /^\d{10,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function digitsOnly(s) {
  return (s || '').replace(/[^\d]/g, '');
}

// ---------- Pagination ----------
const PAGE_SIZE = 25;
function pageFromQuery(query) {
  const p = parseInt(query.page, 10);
  return p && p > 0 ? p : 1;
}
// Renders a Prev/Next + page-count footer. basePath should already include
// any filter query params the list uses (e.g. "/workers?site_id=101"); the
// page param is appended/replaced automatically.
function paginationControls(basePath, page, totalCount, pageSize) {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  if (totalPages <= 1) return '';
  const withPage = (p) => {
    const sep = basePath.includes('?') ? '&' : '?';
    return `${basePath}${sep}page=${p}`;
  };
  return `
  <div class="pagination">
    <span class="muted">Page ${page} of ${totalPages} (${totalCount} total)</span>
    <div class="pagination-links">
      ${page > 1 ? `<a href="${withPage(page - 1)}" class="btn secondary small">← Prev</a>` : ''}
      ${page < totalPages ? `<a href="${withPage(page + 1)}" class="btn secondary small">Next →</a>` : ''}
    </div>
  </div>
  `;
}

// Generic audit trail — call this at every significant mutation. Kept
// simple and best-effort: an audit-log write failure should never block the
// actual action, so this never throws (mirrors how memory/logging failures
// are handled elsewhere — the primary action always wins).
function logAudit(userId, action, entityType, entityId, details) {
  try {
    db.prepare('INSERT INTO audit_log (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
      userId || null,
      action,
      entityType,
      entityId || null,
      details || null
    );
  } catch (e) {
    console.error('audit log write failed', e);
  }
}

// ---------- Roles & permissions ----------
// The full role-capability matrix lives in src/permissions.js — the single
// source of truth shared by these route gates AND the nav/UI in render.js.
// Never hardcode a role list in a route or a render condition; add or use a
// capability in permissions.js instead.
const {
  ROLE_LABEL,
  ROLES: ALL_ROLES,
  MULTI_SITE_ROLES,
  can,
  OVERSIGHT_ROLES,
  PAYROLL_GENERATE_ROLES,
  PAYROLL_APPROVE_ROLES,
  SITE_ADJUSTMENT_MANAGE_ROLES,
  ATTENDANCE_MARK_ROLES,
  WORKER_MANAGE_ROLES,
  WORKER_VERIFY_ROLES,
} = require('./permissions');

// Site scope for a user: null = no restriction (sees every site), [] = sees
// nothing, array of ids = restricted to exactly those sites. Supervisors get
// their single assigned site; Project Managers/Site Engineers get every site
// in user_site_assignments; everyone else with oversight is unrestricted.
function assignedSiteIds(userId) {
  return db
    .prepare('SELECT site_id FROM user_site_assignments WHERE user_id = ? ORDER BY site_id')
    .all(userId)
    .map((r) => r.site_id);
}
function siteScopeForUser(user) {
  if (user.role === 'supervisor') return user.site_id ? [Number(user.site_id)] : [];
  if (MULTI_SITE_ROLES.includes(user.role)) return assignedSiteIds(user.id);
  return null;
}
// Raw SQL fragment restricting a site-id column expression to a scope —
// pass e.g. 'w.site_id' or (for the sites table itself) 's.id'. Scope ids
// always come from our own DB (never user input), so inlining as integers is
// safe and avoids fighting node:sqlite's param binding for dynamic-length IN
// lists.
function siteScopeClause(column, scope) {
  if (scope === null) return '';
  if (scope.length === 0) return ' AND 1=0';
  return ` AND ${column} IN (${scope.map(Number).join(',')})`;
}

// ---------- Attendance eligibility (v9.7) ----------
// One rule set, one place, called by BOTH attendance-writing routes (the bulk
// grid and the single-entry form) before anything is written. The rendered
// forms only ever offer eligible options, but a form is a convenience, not a
// boundary — a hand-crafted or replayed POST has to clear the same checks.
//
// The rule, per Zen (2026-08-10): a site-scoped user (only Supervisor can mark
// attendance) may record ANY active worker, but only at a site within their
// own scope. That deliberately preserves the split-site / visiting-worker case
// the schema is built around — attendance carries its own site_id and payroll
// slices pay by it, so "worker from site 102 worked at site 101" is valid
// business data, not corruption. What makes it *authorized* is the site, which
// is clamped; cross-site rows additionally get an audit entry (see
// auditCrossSiteAttendance) so they're reviewable after the fact.
//
// Messages are deliberately generic: they confirm nothing about whether a
// given worker or site id exists, or whose it is.
const ATTENDANCE_BAD_DATE = 'Enter a valid date in YYYY-MM-DD format.';
const ATTENDANCE_BAD_SITE = "Attendance can't be recorded against that site. Choose an active site from the list.";
const ATTENDANCE_BAD_WORKER = "That worker isn't available for attendance. Choose a worker from the list.";

// Rejects both malformed strings and impossible calendar dates ('2026-02-31'),
// which SQLite would otherwise store verbatim — leaving a row no BETWEEN query
// in the app (payroll included) would ever match again.
function isValidDateStr(s) {
  const str = String(s == null ? '' : s);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const d = new Date(`${str}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === str;
}

// A site can take attendance only if it exists, is a real site (never the
// Unassigned Pool), is currently active (not on hold / completed), and falls
// inside this user's site scope. Admin/HR have scope null = unrestricted, so
// they keep full cross-site access and only the first three tests apply.
function attendanceSiteError(user, siteId) {
  const id = Number(siteId);
  if (!id || id === POOL_SITE_ID) return ATTENDANCE_BAD_SITE;
  const site = db.prepare('SELECT id, status FROM sites WHERE id = ?').get(id);
  if (!site || site.status !== 'active') return ATTENDANCE_BAD_SITE;
  const scope = siteScopeForUser(user);
  if (scope !== null && !scope.includes(id)) return ATTENDANCE_BAD_SITE;
  return null;
}

function attendanceWorkerError(workerId) {
  const id = Number(workerId);
  if (!id) return ATTENDANCE_BAD_WORKER;
  const w = db.prepare('SELECT id, status FROM workers WHERE id = ?').get(id);
  if (!w || w.status !== 'active') return ATTENDANCE_BAD_WORKER;
  return null;
}

// Full check for one attendance write. Returns an error string, or null when
// the write is allowed.
function attendanceWriteError(user, { worker_id, site_id, date }) {
  if (!isValidDateStr(date)) return ATTENDANCE_BAD_DATE;
  return attendanceSiteError(user, site_id) || attendanceWorkerError(worker_id);
}

// Sites this user could actually record attendance against right now — the
// same rule as attendanceSiteError, expressed as a list so the pages can tell
// a site-scoped user *why* they're blocked instead of just refusing the save.
function eligibleAttendanceSites(user) {
  const scope = siteScopeForUser(user);
  return db
    .prepare(`SELECT id, name, status FROM sites WHERE status = 'active' AND id != ${POOL_SITE_ID} ORDER BY id`)
    .all()
    .filter((s) => scope === null || scope.includes(Number(s.id)));
}

// A site-scoped user whose only site is on hold or completed can't mark
// attendance at all. That's intended (work is paused there), but it must say
// so plainly — otherwise it reads as the app being broken. Only ever shown to
// someone about their OWN site, so naming its status leaks nothing.
function noEligibleSiteNotice(user) {
  if (siteScopeForUser(user) === null || eligibleAttendanceSites(user).length > 0) return '';
  const own = user.site_id ? db.prepare('SELECT name, status FROM sites WHERE id = ?').get(user.site_id) : null;
  const statusText = own ? `is currently marked ${SITE_STATUS_LABEL[own.status] || own.status}` : 'is not set';
  return `<div class="flash flash-error">Attendance can't be recorded right now — your site ${
    own ? `(${esc(own.name)}) ` : ''
  }${statusText}. Ask an administrator to set it back to Active if work has resumed. Existing attendance history is unaffected.</div>`;
}

// A worker recorded somewhere other than their home site is legitimate (that's
// the split-site case) but worth a trail, so it can be reviewed rather than
// merely trusted.
function auditCrossSiteAttendance(user, workerId, siteId, date) {
  const w = db.prepare('SELECT name, site_id FROM workers WHERE id = ?').get(Number(workerId) || 0);
  if (!w || Number(w.site_id) === Number(siteId)) return;
  logAudit(
    user.id,
    'create',
    'attendance',
    null,
    `cross-site entry: ${w.name} (home site ${w.site_id}) recorded at site ${siteId} on ${date}`
  );
}

// ---------- Pay periods: fixed Thursday -> Wednesday weeks ----------
// getDay(): 0=Sun..6=Sat, so Thursday=4. Dates are plain 'YYYY-MM-DD' strings
// compared/parsed as UTC midnight to avoid timezone drift.
// Snaps any date to the Thu->Wed week that contains it — the enclosing
// Thursday becomes the period start, that Thursday + 6 days becomes the
// period end. Used so a user picking any day mid-week (on the payroll
// generate or site-performance forms) automatically lands on a valid pay
// period instead of being rejected — the End field they typed is ignored on
// purpose, per Zen's explicit choice: a period is always derived from Start
// alone, guaranteeing it's always exactly one valid Thu-Wed week. Returns
// null for an unparseable/empty date so callers can still show a real error
// for that case (there's no week to derive from nothing).
function snapToPayPeriod(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const dow = d.getUTCDay();
  const daysSinceThursday = (dow - 4 + 7) % 7;
  const start = new Date(d);
  start.setUTCDate(start.getUTCDate() - daysSinceThursday);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
// The most recent pay period that has fully elapsed (or is in progress) as of
// today — used to pre-fill the "generate payroll" / "log adjustment" forms so
// nobody has to hand-compute the right Thursday.
function currentPayPeriod() {
  const today = new Date(todayStr() + 'T00:00:00Z');
  const dow = today.getUTCDay();
  const daysSinceThursday = (dow - 4 + 7) % 7;
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - daysSinceThursday);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}
// Client-side mirror of snapToPayPeriod() above, wired to a Period-start date
// input so the form visibly snaps to the enclosing Thu-Wed week the moment
// someone picks a date — the read-only End field updates immediately, before
// they even submit. This is pure UX (the server re-derives and enforces the
// same snap independently in the route handler, so nothing relies on this
// script running) — kept in sync by hand since it's a small, self-contained
// bit of date math with no shared module to import client-side.
function payPeriodSnapScript(startId, endId) {
  return `<script>
  (function () {
    function snap() {
      var s = document.getElementById('${startId}');
      var e = document.getElementById('${endId}');
      if (!s || !e || !s.value) return;
      var d = new Date(s.value + 'T00:00:00Z');
      if (isNaN(d.getTime())) return;
      var dow = d.getUTCDay();
      var daysSinceThursday = (dow - 4 + 7) % 7;
      var start = new Date(d);
      start.setUTCDate(start.getUTCDate() - daysSinceThursday);
      var end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 6);
      s.value = start.toISOString().slice(0, 10);
      e.value = end.toISOString().slice(0, 10);
    }
    var startEl = document.getElementById('${startId}');
    if (startEl) startEl.addEventListener('change', snap);
  })();
  </script>`;
}

// Purely informational — "here's what you're about to save", never a
// confirm()/block. Reads the worker <option>'s data-home/-home-id (set in
// renderSingleEntry) and the site <select>'s own selected-option text, and
// shows a one-line note whenever they differ. The server independently
// writes the same cross-site audit entry regardless of whether this note was
// ever seen (auditCrossSiteAttendance runs on every save), so nothing about
// correctness depends on this script running — it's purely so the person
// filling the form notices before they hit Save, not a gate on submission.
const visitingWorkerNoteScript = `<script>
(function () {
  var workerSel = document.getElementById('single-entry-worker');
  var siteSel = document.getElementById('single-entry-site');
  var note = document.getElementById('visiting-note');
  if (!workerSel || !siteSel || !note) return;
  function update() {
    var opt = workerSel.options[workerSel.selectedIndex];
    var homeId = opt ? opt.getAttribute('data-home-id') : '';
    var home = opt ? opt.getAttribute('data-home') : '';
    var siteId = siteSel.value;
    var siteOpt = siteSel.options[siteSel.selectedIndex];
    var siteName = siteOpt && siteOpt.value ? siteOpt.text : '';
    if (!homeId || !siteId || !siteName) { note.style.display = 'none'; return; }
    if (String(homeId) === String(siteId)) { note.style.display = 'none'; return; }
    note.textContent = 'Home site: ' + home + ' · Recording attendance at: ' + siteName + '. This is a supported cross-site entry and will be recorded in the audit log.';
    note.style.display = '';
  }
  workerSel.addEventListener('change', update);
  siteSel.addEventListener('change', update);
  update();
})();
</script>`;

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvRows(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
function sendCsv(res, filename, rows) {
  send(res, 200, csvRows(rows), {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
}
function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'text/html; charset=utf-8' }, headers || {}));
  res.end(body);
}
function redirect(res, location, cookie) {
  const headers = { Location: location };
  if (cookie) headers['Set-Cookie'] = cookie;
  res.writeHead(302, headers);
  res.end();
}
function serveStatic(req, res, pathname) {
  const filePath = path.join(PUBLIC_DIR, pathname);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
  return true;
}
function requireLogin(user, res) {
  if (!user) {
    redirect(res, '/login');
    return false;
  }
  return true;
}
// Takes the request-scoped `layout` closure (not a raw theme string) so the
// 403 page — which still renders the full sidebar, including the logout
// form — carries this request's real CSRF token instead of an empty one.
// Every real call site inside handleRequest passes its own `layout`.
function forbidden(res, user, currentPath, layout) {
  send(
    res,
    403,
    layout({
      title: 'Forbidden',
      user,
      currentPath,
      flash: { type: 'error', message: "You don't have permission to view this page." },
      body: `<div class="card"><h1>Access denied</h1><p class="muted">Ask an admin if you believe this is a mistake.</p></div>`,
    })
  );
}

// v10: Super Admin protection. /users routes are reachable by anyone with
// admin.full (admin AND super_admin — see permissions.js), but an admin
// actor must not be able to create, edit, reset the password of, or
// (de)activate a super_admin account, nor grant the super_admin role to
// anyone, including themselves. A super_admin actor is unrestricted. This
// is an actor-vs-target comparison, not a plain role list, so it doesn't fit
// the CAPABILITIES table the way ordinary permissions do — kept as its own
// pure helper instead, next to the one set of routes it actually gates.
// v10 follow-up: the two accounts created by migrate-v10-accounts.js
// (Biju Vinamsy, Rijila Dominic) got this exact placeholder contact number
// because their real phone numbers weren't available at migration time.
// Flagged read-only on the Users page below (never auto-corrected — only
// Zen has the real numbers) until someone updates it via Edit.
const PLACEHOLDER_CONTACT = '9800000000';
const SUPER_ADMIN_MANAGE_ERROR = 'Only a Super Admin can manage a Super Admin account.';
const SUPER_ADMIN_PROMOTE_ERROR = 'Only a Super Admin can grant the Super Admin role.';
function superAdminGuardError(actingUser, { targetRole, submittedRole } = {}) {
  if (actingUser.role === 'super_admin') return null;
  if (targetRole === 'super_admin') return SUPER_ADMIN_MANAGE_ERROR;
  if (submittedRole === 'super_admin') return SUPER_ADMIN_PROMOTE_ERROR;
  return null;
}

// ---------- Shared lookups ----------
// Lists every vendor (any active state) — an inactive vendor is labeled, not
// hard-hidden, so editing a worker never silently loses their current vendor.
function vendorOptions(selectedId, { excludeId } = {}) {
  const vendors = db.prepare('SELECT * FROM vendors ORDER BY is_direct DESC, name').all();
  return vendors
    .filter((v) => !excludeId || v.id !== Number(excludeId))
    .map((v) => {
      const suffix = v.is_direct ? ' (Direct)' : ' — ' + esc(v.vendor_code);
      const inactiveTag = !v.active ? ' (Inactive)' : '';
      return `<option value="${v.id}" ${String(v.id) === String(selectedId) ? 'selected' : ''}>${esc(v.name)}${suffix}${inactiveTag}</option>`;
    })
    .join('');
}
function workerTypeOptions(selectedId) {
  const types = db.prepare('SELECT * FROM worker_types WHERE active = 1 ORDER BY name').all();
  return types
    .map((t) => `<option value="${t.id}" ${String(t.id) === String(selectedId) ? 'selected' : ''}>${esc(t.name)}</option>`)
    .join('');
}
const SITE_STATUS_LABEL = { active: 'Active', on_hold: 'On hold', completed: 'Completed' };
const SITE_STATUS_BADGE = { active: 'active', on_hold: 'half_day', completed: 'inactive' };
const SKILL_GRADE_LABEL = { trainee: 'Trainee', skilled: 'Skilled', expert: 'Expert' };

// Lists every site (any status) — non-active sites are labeled so whoever's
// picking (assigning a worker, marking attendance, etc.) can make an informed
// call rather than being hard-blocked from an on-hold/completed site.
// activeOnly (v9.7) narrows the list to sites that can actually take
// attendance — real, active sites — matching attendanceSiteError()'s rule so
// the attendance pages never offer a choice the server would reject. Left off
// everywhere else, where picking an on-hold/completed site is still valid.
function siteOptions(selectedId, { excludeId, onlyIds, activeOnly } = {}) {
  const sites = db.prepare('SELECT * FROM sites ORDER BY id').all();
  return sites
    .filter((s) => !excludeId || s.id !== Number(excludeId))
    .filter((s) => !onlyIds || onlyIds.includes(s.id))
    .filter((s) => !activeOnly || (s.status === 'active' && s.id !== POOL_SITE_ID))
    .map((s) => {
      const suffix = s.status !== 'active' ? ` (${SITE_STATUS_LABEL[s.status]})` : '';
      return `<option value="${s.id}" ${String(s.id) === String(selectedId) ? 'selected' : ''}>${s.id} — ${esc(s.name)}${suffix}</option>`;
    })
    .join('');
}
function skillGradeOptions(selected) {
  return Object.entries(SKILL_GRADE_LABEL)
    .map(([val, label]) => `<option value="${val}" ${val === (selected || 'skilled') ? 'selected' : ''}>${label}</option>`)
    .join('');
}
function directVendorId() {
  const v = db.prepare('SELECT id FROM vendors WHERE is_direct = 1 LIMIT 1').get();
  return v ? v.id : null;
}
function findWorkerByAadhar(aadhar, excludeId) {
  if (excludeId) {
    return db.prepare('SELECT * FROM workers WHERE aadhar_number = ? AND id != ?').get(aadhar, excludeId);
  }
  return db.prepare('SELECT * FROM workers WHERE aadhar_number = ?').get(aadhar);
}

// ---------- Auto-generated IDs ----------
// Workers and vendors both get a human-readable code assigned automatically —
// nobody types these in. Monotonic, based on the highest existing suffix
// rather than a row count, so a deleted record never causes a collision.
function nextWorkerCode() {
  // As of v9.1, worker codes are "W00001", "W00002", ... (5-digit, no dash),
  // per Zen's request — a one-time migration in db.js renumbers any
  // pre-existing "WRK-xxxx"-style codes into this format, so this only ever
  // needs to look at the new pattern (mirrors nextVendorCode's V#### switch).
  const row = db.prepare(`SELECT MAX(CAST(SUBSTR(worker_code, 2) AS INTEGER)) m FROM workers WHERE worker_code GLOB 'W[0-9][0-9][0-9][0-9][0-9]'`).get();
  const next = (row && row.m ? row.m : 0) + 1;
  return 'W' + String(next).padStart(5, '0');
}
function nextVendorCode() {
  // The built-in Direct vendor is seeded with its own fixed "B0xxx"-style code
  // and is never created through this path — this generates codes only for
  // regular vendors added through the app. As of v9, regular vendor codes are
  // "V0001", "V0002", ... (4-digit, no dash) — a one-time migration in db.js
  // renumbers any pre-existing "VEN-xxx"-style codes into this format, so this
  // only ever needs to look at the new pattern.
  const row = db
    .prepare(`SELECT MAX(CAST(SUBSTR(vendor_code, 2) AS INTEGER)) m FROM vendors WHERE vendor_code GLOB 'V[0-9][0-9][0-9][0-9]'`)
    .get();
  const next = (row && row.m ? row.m : 0) + 1;
  return 'V' + String(next).padStart(4, '0');
}

// ---------- Deletion safety ----------
// Shared policy: never let a hard DELETE hit a foreign-key wall and crash the
// request. Before deleting anything that other rows might reference, count
// what's attached and either refuse with a clear, actionable message or offer
// the safe alternative (deactivate/mark-inactive/reassign) instead of an
// unhandled SQLite constraint error.
function vendorDependencyCounts(vendorId) {
  const workers = db.prepare('SELECT COUNT(*) c FROM workers WHERE vendor_id = ?').get(vendorId).c;
  const activeWorkers = db.prepare("SELECT COUNT(*) c FROM workers WHERE vendor_id = ? AND status = 'active'").get(vendorId).c;
  const payrollItems = db.prepare('SELECT COUNT(*) c FROM payroll_items WHERE vendor_id = ?').get(vendorId).c;
  return { workers, activeWorkers, payrollItems };
}
// Informational counts shown on a site's Edit page (worker reassignment
// section) — NOT a delete gate anymore. A hard-delete route used to exist
// here and was guarded by a version of this function that only checked
// workers/attendance/users, missing several other tables with a site_id
// foreign key (user_site_assignments, site_off_days, site_performance,
// payroll_item_sites, payroll_run_site_verifications — added across
// v5/v8/v8.1). That gap meant a "safe-looking" site (0 workers/attendance/
// users, e.g. one Zen had already cleared out) could still crash the delete
// with an unhandled SQLite FK-constraint exception the moment it had an
// off-day, a PM/SE assignment, or historical payroll data attached — found
// live on Zen's machine. Rather than widen the check further, Zen asked for
// the capability to be removed outright (v9, same policy as workers): a site
// is retired via Status=Completed only, never permanently deleted, so this
// function only needs to report what's still active for the reassignment UI.
function siteDependencyCounts(siteId) {
  const workers = db.prepare('SELECT COUNT(*) c FROM workers WHERE site_id = ?').get(siteId).c;
  const attendance = db.prepare('SELECT COUNT(*) c FROM attendance WHERE site_id = ?').get(siteId).c;
  const users = db.prepare('SELECT COUNT(*) c FROM users WHERE site_id = ?').get(siteId).c;
  return { workers, attendance, users };
}
function workerHistoryCounts(workerId) {
  const attendance = db.prepare('SELECT COUNT(*) c FROM attendance WHERE worker_id = ?').get(workerId).c;
  const payrollItems = db.prepare('SELECT COUNT(*) c FROM payroll_items WHERE worker_id = ?').get(workerId).c;
  return { attendance, payrollItems };
}

// ---------- Dashboard / analytics ----------
function lastNDates(n, endDate) {
  const end = endDate ? new Date(endDate + 'T00:00:00Z') : new Date();
  const dates = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}
function shortDate(iso) {
  const [, m, d] = iso.split('-');
  return `${m}/${d}`;
}

function attendanceTrendChart(days) {
  const today = todayStr();
  const dates = lastNDates(days, today);
  const from = dates[0];
  const to = dates[dates.length - 1];

  const sites = db.prepare(`SELECT id, name FROM sites WHERE id != ${POOL_SITE_ID} ORDER BY id`).all();
  const activeCounts = db
    .prepare(`SELECT site_id, COUNT(*) c FROM workers WHERE status = 'active' GROUP BY site_id`)
    .all()
    .reduce((m, r) => ((m[r.site_id] = r.c), m), {});
  const presentRows = db
    .prepare(
      `SELECT site_id, date, COUNT(DISTINCT worker_id) c FROM attendance
       WHERE date BETWEEN ? AND ? AND hours_worked > 0 GROUP BY site_id, date`
    )
    .all(from, to);
  const presentMap = {}; // "siteId|date" -> count
  presentRows.forEach((r) => (presentMap[`${r.site_id}|${r.date}`] = r.c));

  // Only chart sites that currently have workers, capped at 8 (palette size).
  const activeSites = sites.filter((s) => activeCounts[s.id] > 0);
  const shown = activeSites.slice(0, 8);
  const omitted = activeSites.length - shown.length;

  const series = shown.map((s) => ({
    name: s.name,
    values: dates.map((date) => {
      const denom = activeCounts[s.id] || 0;
      if (denom === 0) return null;
      const present = presentMap[`${s.id}|${date}`] || 0;
      return Math.round((present / denom) * 1000) / 10;
    }),
  }));

  const chart = svgLineChart({
    series,
    labels: dates.map(shortDate),
    yMax: 100,
    yFmt: (v) => `${Math.round(v)}%`,
    emptyText: 'No sites with active workers yet.',
  });

  return { chart, omitted };
}

function payrollCostTrendChart(limit) {
  // Flagged runs are superseded/voided (see v8.1's flag-to-regenerate) — they
  // stay visible in the Payroll list for history, but excluding them here
  // keeps the trend and its date labels reflecting only the active run for
  // each period instead of double-counting a period that was regenerated.
  const runs = db
    .prepare(
      `SELECT pr.id, pr.period_start, pr.period_end,
        (SELECT COALESCE(SUM(pi.base_pay + pi.overtime_pay),0) - COALESCE((SELECT SUM(pd.amount) FROM payroll_deductions pd JOIN payroll_items pi2 ON pi2.id = pd.payroll_item_id WHERE pi2.payroll_run_id = pr.id),0)
         FROM payroll_items pi WHERE pi.payroll_run_id = pr.id) net
       FROM payroll_runs pr WHERE pr.flagged = 0 ORDER BY pr.id DESC LIMIT ?`
    )
    .all(limit)
    .reverse();
  const data = runs.map((r) => ({ label: shortDate(r.period_start), value: r.net }));
  return svgBarChart({ data, color: '#2a78d6', valueFmt: (v) => fmtMoney(v).replace('₹', ''), emptyText: 'No payroll runs generated yet.' });
}

function performanceAdjustmentImpact() {
  const adjustments = db
    .prepare(
      `SELECT sp.*, s.name site_name FROM site_performance sp JOIN sites s ON s.id = sp.site_id ORDER BY sp.period_start DESC`
    )
    .all();
  let totalDeducted = 0; // cuts only (positive)
  let totalAdded = 0; // bonuses + additional payments (positive, shown as an addition)
  const rows = adjustments.map((c) => {
    let pattern;
    if (c.adjustment_type === 'additional_payment') {
      pattern = `${c.site_name} additional payment (${c.period_start} to ${c.period_end}%`;
    } else {
      pattern = `${c.site_name} performance ${c.adjustment_type} — ${c.cut_percent}% (${c.period_start} to ${c.period_end}%`;
    }
    // Exclude deductions that belong to a flagged (superseded/voided)
    // payroll run — same reasoning as the payroll cost trend chart.
    const sumAmount = db
      .prepare(
        `SELECT COALESCE(SUM(pd.amount),0) c FROM payroll_deductions pd
         JOIN payroll_items pi ON pi.id = pd.payroll_item_id
         JOIN payroll_runs pr ON pr.id = pi.payroll_run_id
         WHERE pd.reason LIKE ? AND pr.flagged = 0`
      )
      .get(pattern).c;
    // Cuts store positive amounts (deductions); bonuses/additional payments
    // store negative amounts (additions) — normalize to a positive display
    // figure either way.
    const amount = Math.abs(sumAmount);
    if (c.adjustment_type === 'cut') totalDeducted += amount;
    else totalAdded += amount;
    return Object.assign({}, c, { amount_applied: amount });
  });
  const totalCuts = adjustments.filter((c) => c.adjustment_type === 'cut').length;
  const totalBonusesAndPayments = adjustments.length - totalCuts;
  return { rows, totalDeducted, totalAdded, totalCuts, totalBonusesAndPayments };
}

function vendorComparisonRows(days) {
  const today = todayStr();
  const dates = lastNDates(days, today);
  const from = dates[0];
  const to = dates[dates.length - 1];
  const vendors = db.prepare(`SELECT * FROM vendors ORDER BY is_direct DESC, name`).all();
  const presentDays = db
    .prepare(
      `SELECT w.vendor_id, COUNT(*) c FROM attendance a JOIN workers w ON w.id = a.worker_id
       WHERE a.date BETWEEN ? AND ? AND a.hours_worked > 0 GROUP BY w.vendor_id`
    )
    .all(from, to)
    .reduce((m, r) => ((m[r.vendor_id] = r.c), m), {});

  const rows = vendors.map((v) => {
    const workerCount = db.prepare('SELECT COUNT(*) c FROM workers WHERE vendor_id = ?').get(v.id).c;
    const activeCount = db.prepare("SELECT COUNT(*) c FROM workers WHERE vendor_id = ? AND status = 'active'").get(v.id).c;
    // Exclude flagged (superseded/voided) payroll runs from "Total paid" —
    // same reasoning as the payroll cost trend chart above.
    const totalPaid =
      db
        .prepare(
          `SELECT COALESCE(SUM(pi.base_pay + pi.overtime_pay),0) - COALESCE((SELECT SUM(pd.amount) FROM payroll_deductions pd WHERE pd.payroll_item_id IN (SELECT pi3.id FROM payroll_items pi3 JOIN payroll_runs pr3 ON pr3.id = pi3.payroll_run_id WHERE pi3.vendor_id = ? AND pr3.flagged = 0)),0) total
           FROM payroll_items pi JOIN payroll_runs pr ON pr.id = pi.payroll_run_id WHERE pi.vendor_id = ? AND pr.flagged = 0`
        )
        .get(v.id, v.id).total || 0;
    const denom = activeCount * days;
    const avgAttendance = denom > 0 ? Math.min(100, Math.round(((presentDays[v.id] || 0) / denom) * 1000) / 10) : null;
    return Object.assign({}, v, { workerCount, activeCount, totalPaid, avgAttendance });
  });
  const maxPaid = Math.max(...rows.map((r) => r.totalPaid), 0);
  return { rows, maxPaid };
}

function renderDashboard(user) {
  const today = todayStr();
  const scope = siteScopeForUser(user);
  const siteFilter = siteScopeClause('w.site_id', scope);

  const totalWorkers = db.prepare(`SELECT COUNT(*) c FROM workers w WHERE status='active' ${siteFilter}`).get().c;

  const presentToday = db
    .prepare(
      `SELECT COUNT(DISTINCT a.worker_id) c FROM attendance a JOIN workers w ON w.id = a.worker_id
       WHERE a.date = @today AND a.hours_worked > 0 ${siteFilter}`
    )
    .get({ today }).c;

  const markedToday = db
    .prepare(
      `SELECT COUNT(DISTINCT a.worker_id) c FROM attendance a JOIN workers w ON w.id = a.worker_id
       WHERE a.date = @today ${siteFilter}`
    )
    .get({ today }).c;

  const unassignedCount = db.prepare(`SELECT COUNT(*) c FROM workers WHERE status='active' AND site_id = ${POOL_SITE_ID}`).get().c;
  const attendancePct = totalWorkers > 0 ? Math.round((presentToday / totalWorkers) * 100) : 0;
  const sitesCount = db.prepare(`SELECT COUNT(*) c FROM sites WHERE id != ${POOL_SITE_ID}`).get().c;
  // v9.9: gated on the same capability the payroll-runs card and the
  // analytics link below are gated on, and only run for roles that can
  // actually see the result — was previously an unconditional query even
  // for roles the card never renders for.
  const canViewAnalytics = can(user, 'analytics.view');
  const payrollRuns = canViewAnalytics ? db.prepare('SELECT COUNT(*) c FROM payroll_runs').get().c : 0;
  const isSingleSite = user.role === 'supervisor';

  let siteBreakdown = '';
  if (!isSingleSite) {
    const siteRowScope = scope === null ? '' : siteScopeClause('s.id', scope);
    const rows = db
      .prepare(
        `SELECT s.id, s.name, COUNT(DISTINCT w.id) worker_count,
          COUNT(DISTINCT CASE WHEN a.date = @today AND a.hours_worked > 0 THEN a.worker_id END) present_today
         FROM sites s
         LEFT JOIN workers w ON w.site_id = s.id AND w.status='active'
         LEFT JOIN attendance a ON a.worker_id = w.id AND a.site_id = s.id
         WHERE 1=1 ${siteRowScope}
         GROUP BY s.id ORDER BY s.id`
      )
      .all({ today });
    siteBreakdown = `
    <h2>Sites overview</h2>
    <div class="table-wrap"><table>
      <tr><th>Site</th><th>Active workers</th><th>Present today</th></tr>
      ${rows
        .map(
          (r) =>
            `<tr><td>${r.id === POOL_SITE_ID ? '<span class="badge inactive">100 — Unassigned Pool</span>' : `${r.id} — ${esc(r.name)}`}</td><td>${r.worker_count}</td><td>${r.present_today || 0}</td></tr>`
        )
        .join('')}
      ${rows.length === 0 ? '<tr><td colspan="3" class="muted">No sites yet.</td></tr>' : ''}
    </table></div>`;
  }

  return `
  <h1>Welcome, ${esc(user.name)}</h1>
  <p class="subtitle">${esc(today)} · ${esc(ROLE_LABEL[user.role] || user.role)} view</p>
  <div class="grid grid-4">
    <div class="stat"><div class="stat-label">Active workers</div><div class="stat-value">${totalWorkers}</div></div>
    <div class="stat"><div class="stat-label">Present today</div><div class="stat-value">${presentToday}</div><div class="stat-sub">${attendancePct}% of workforce</div></div>
    <div class="stat"><div class="stat-label">Attendance marked</div><div class="stat-value">${markedToday}/${totalWorkers}</div></div>
    ${
      !isSingleSite
        ? `<div class="stat"><div class="stat-label">Sites</div><div class="stat-value">${sitesCount}</div></div>`
        : `<div class="stat"><div class="stat-label">Your site</div><div class="stat-value" style="font-size:16px">${esc(
            (db.prepare('SELECT name FROM sites WHERE id=?').get(user.site_id) || {}).name || '—'
          )}</div></div>`
    }
  </div>
  <div class="actions" style="margin-top:20px">
    ${ATTENDANCE_MARK_ROLES.includes(user.role) ? '<a href="/attendance" class="btn">Mark attendance</a>' : '<a href="/attendance/history" class="btn">View attendance</a>'}
    ${WORKER_MANAGE_ROLES.includes(user.role) ? '<a href="/workers/new" class="btn secondary">Add worker</a>' : ''}
  </div>
  ${
    !isSingleSite && unassignedCount > 0 && scope === null
      ? `<div class="flash flash-error" style="margin-top:16px">${unassignedCount} worker(s) are still in the Unassigned Pool (site 100) — <a href="/workers?site_id=100">assign them to a site →</a></div>`
      : ''
  }
  ${
    canViewAnalytics
      ? `<div class="card mt-0" style="margin-top:20px"><b>Payroll runs generated:</b> ${payrollRuns} · <a href="/payroll">View payroll →</a> · <a href="/analytics">View full analytics →</a></div>`
      : ''
  }
  ${siteBreakdown}
  `;
}

function renderAnalyticsSection() {
  const TREND_DAYS = 14;
  const { chart: attendanceChart, omitted } = attendanceTrendChart(TREND_DAYS);
  const payrollChart = payrollCostTrendChart(10);
  const { rows: adjustmentRows, totalDeducted, totalAdded, totalCuts, totalBonusesAndPayments } = performanceAdjustmentImpact();
  const { rows: vendorRows, maxPaid } = vendorComparisonRows(TREND_DAYS);

  return `
  <h2>Attendance % by site — last ${TREND_DAYS} days</h2>
  <div class="card">
    ${attendanceChart}
    ${omitted > 0 ? `<p class="hint">${omitted} more site(s) with active workers not shown on this chart — see the Sites overview table above for the full list.</p>` : ''}
  </div>

  <div class="grid grid-2">
    <div>
      <h2>Payroll cost trend</h2>
      <div class="card">
        ${payrollChart}
        <p class="hint">Net payout per generated run, most recent 10.</p>
      </div>
    </div>
    <div>
      <h2>Site performance impact</h2>
      <div class="card">
        <div class="grid grid-2" style="margin-bottom:14px">
          <div class="stat"><div class="stat-label">Cuts logged (${totalCuts})</div><div class="stat-value" style="font-size:20px">${fmtMoney(totalDeducted)}</div></div>
          <div class="stat"><div class="stat-label">Bonuses/payments (${totalBonusesAndPayments})</div><div class="stat-value" style="font-size:20px">${fmtMoney(totalAdded)}</div></div>
        </div>
        ${
          adjustmentRows.length
            ? `<div class="table-wrap"><table>
                <tr><th>Site</th><th>Period</th><th>Type</th><th>Amount</th></tr>
                ${adjustmentRows
                  .slice(0, 6)
                  .map(
                    (c) =>
                      `<tr><td>${esc(c.site_name)}</td><td>${esc(c.period_start)} → ${esc(c.period_end)}</td><td><span class="badge ${ADJUSTMENT_TYPE_BADGE[c.adjustment_type]}">${ADJUSTMENT_TYPE_LABEL[c.adjustment_type]}</span></td><td>${fmtMoney(c.amount_applied)}</td></tr>`
                  )
                  .join('')}
              </table></div>
              <p class="hint"><a href="/site-performance">Manage site performance →</a></p>`
            : `<p class="hint">No site performance adjustments logged yet. <a href="/site-performance">Log one →</a></p>`
        }
      </div>
    </div>
  </div>

  <h2>Vendor comparison</h2>
  <div class="table-wrap"><table>
    <tr><th>Vendor</th><th>Workers</th><th>Avg attendance (${TREND_DAYS}d)</th><th>Total paid</th></tr>
    ${vendorRows
      .map(
        (v) => `<tr>
        <td>${esc(v.name)}${v.is_direct ? ' <span class="badge active">Direct</span>' : ''}</td>
        <td>${v.workerCount}${v.activeCount !== v.workerCount ? ` (${v.activeCount} active)` : ''}</td>
        <td>${v.avgAttendance === null ? '—' : v.avgAttendance + '%'}</td>
        <td>${miniBar(v.totalPaid, maxPaid)}<span style="display:inline-block;margin-top:4px">${fmtMoney(v.totalPaid)}</span></td>
      </tr>`
      )
      .join('')}
    ${vendorRows.length === 0 ? '<tr><td colspan="4" class="muted">No vendors yet.</td></tr>' : ''}
  </table></div>
  `;
}

// ---------- Workers ----------
function workerRowsForUser(user, siteFilterId, opts) {
  const o = opts || {};
  let sql = `SELECT w.*, s.name site_name, v.name vendor_name, v.is_direct vendor_is_direct, wt.name type_name
             FROM workers w
             LEFT JOIN sites s ON s.id = w.site_id
             LEFT JOIN vendors v ON v.id = w.vendor_id
             LEFT JOIN worker_types wt ON wt.id = w.worker_type_id
             WHERE 1=1`;
  const scope = siteScopeForUser(user);
  sql += siteScopeClause('w.site_id', scope);
  const params = {};
  if (scope === null && siteFilterId) {
    sql += ' AND w.site_id = @siteId';
    params.siteId = siteFilterId;
  }
  if (o.q) {
    sql += ' AND (w.name LIKE @q OR w.worker_code LIKE @q)';
    params.q = `%${o.q}%`;
  }
  const countSql = sql.replace(/^SELECT w\.\*.*?FROM/s, 'SELECT COUNT(*) c FROM');
  const totalCount = db.prepare(countSql).get(params).c;
  sql += ' ORDER BY w.name';
  if (o.limit) {
    sql += ' LIMIT @limit OFFSET @offset';
    params.limit = o.limit;
    params.offset = o.offset || 0;
  }
  return { rows: db.prepare(sql).all(params), totalCount };
}

function renderWorkersList(user, query) {
  const siteFilterId = query.site_id || '';
  const q = (query.q || '').trim();
  const page = pageFromQuery(query);
  const { rows: workers, totalCount } = workerRowsForUser(user, siteFilterId, { q, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE });
  const canEdit = WORKER_MANAGE_ROLES.includes(user.role);
  const scope = siteScopeForUser(user);
  const qsBase = `/workers?${siteFilterId ? 'site_id=' + esc(siteFilterId) + '&' : ''}${q ? 'q=' + esc(encodeURIComponent(q)) + '&' : ''}`.replace(/[&?]$/, '');
  return `
  <h1>Workers</h1>
  <p class="subtitle">${totalCount} worker(s)${siteFilterId ? ' at site ' + esc(siteFilterId) : ''}${q ? ` matching "${esc(q)}"` : ''}</p>
  ${canEdit ? `<div class="actions" style="margin-top:0;margin-bottom:16px"><a href="/workers/new" class="btn">+ Add worker</a></div>` : ''}
  <form method="GET" action="/workers" class="form-row" style="max-width:${scope === null ? '520' : '300'}px; flex-wrap:wrap">
    <div><label>Search by name or ID</label><input name="q" value="${esc(q)}" placeholder="e.g. Ravi or W00012"></div>
    ${
      scope === null
        ? `<div><label>Site</label><select name="site_id">${'<option value="">All sites</option>' + siteOptions(siteFilterId)}</select></div>`
        : ''
    }
    <div style="align-self:flex-end"><button class="btn secondary" type="submit" style="margin-bottom:14px">Filter</button></div>
  </form>
  ${scope !== null && scope.length > 1 ? `<p class="hint">Showing workers across your ${scope.length} assigned sites.</p>` : ''}
  <div class="table-wrap"><table>
    <tr><th>ID</th><th>Name</th><th>Type</th><th>Vendor</th><th>Site</th><th>Aadhar</th><th>Rate</th><th>Status</th><th>ID verified</th><th></th></tr>
    ${workers
      .map(
        (w) => `<tr>
        <td class="muted">${esc(w.worker_code || '—')}</td>
        <td>${esc(w.name)}</td>
        <td>${esc(w.type_name || '—')}${w.skill_grade ? ` <span class="muted">· ${esc(SKILL_GRADE_LABEL[w.skill_grade] || '')}</span>` : ''}</td>
        <td>${esc(w.vendor_name || '—')}${w.vendor_is_direct ? ' <span class="badge active">Direct</span>' : ''}</td>
        <td>${w.site_id === POOL_SITE_ID ? '<span class="badge inactive">100 — Pool</span>' : `${w.site_id} — ${esc(w.site_name)}`}</td>
        <td>${esc(w.aadhar_number)}</td>
        <td>${fmtMoney(w.wage_rate)}/hr</td>
        <td><span class="badge ${w.status}">${w.status}</span></td>
        <td><span class="badge ${w.verification_status === 'verified' ? 'active' : 'half_day'}">${w.verification_status === 'verified' ? 'Verified' : 'Pending'}</span></td>
        <td>${canEdit ? `<a href="/workers/${w.id}/edit">Edit</a>` : ''}</td>
      </tr>`
      )
      .join('')}
    ${workers.length === 0 ? '<tr><td colspan="10" class="muted">No workers match.</td></tr>' : ''}
  </table></div>
  ${paginationControls(qsBase, page, totalCount, PAGE_SIZE)}
  `;
}

function renderWorkerForm(worker, opts) {
  const w = Object.assign({}, worker, (opts && opts.values) || {});
  const isEdit = !!worker;
  const canVerify = !!(opts && opts.user && WORKER_VERIFY_ROLES.includes(opts.user.role));
  const errorHtml = opts && opts.error ? `<div class="flash flash-error">${esc(opts.error)}</div>` : '';
  const directId = directVendorId();
  const isAlreadyDirect = isEdit && Number(worker.vendor_id) === Number(directId);
  const hist = isEdit ? workerHistoryCounts(worker.id) : { attendance: 0, payrollItems: 0 };
  const hasHistory = hist.attendance > 0 || hist.payrollItems > 0;

  return `
  <h1>${isEdit ? 'Edit worker' : 'Add worker'}</h1>
  ${
    isEdit
      ? `<p class="subtitle">Worker ID <b>${esc(worker.worker_code || '—')}</b> · <span class="badge ${
          worker.verification_status === 'verified' ? 'active' : 'half_day'
        }">${worker.verification_status === 'verified' ? 'ID Verified' : 'Verification pending'}</span></p>`
      : `<p class="subtitle">A Worker ID will be assigned automatically once saved.</p>`
  }
  ${errorHtml}
  <div class="card">
  <form method="POST" action="${isEdit ? '/workers/' + worker.id : '/workers'}">
    <div class="form-row">
      <div><label>Full name</label><input name="name" required value="${esc(w.name)}"></div>
      <div><label>Worker type</label><select name="worker_type_id" required><option value="">Select type…</option>${workerTypeOptions(
        w.worker_type_id
      )}</select></div>
    </div>
    <div class="form-row">
      <div><label>Vendor</label><select name="vendor_id" required><option value="">Select vendor…</option>${vendorOptions(
        w.vendor_id
      )}</select></div>
      <div><label>Skill grade</label><select name="skill_grade">${skillGradeOptions(w.skill_grade)}</select></div>
    </div>
    ${
      isEdit && !isAlreadyDirect && directId
        ? `<div class="form-row"><div></div><div><p class="hint" style="margin-top:-6px">Want to bring this worker onto the direct team instead? Use "Absorb into Bilara (Direct)" below, outside this form.</p></div></div>`
        : ''
    }
    <div class="form-row">
      <div><label>Aadhar number (12 digits, unique)</label><input name="aadhar_number" required pattern="\\d{12}" maxlength="12" value="${esc(
        w.aadhar_number
      )}"></div>
      <div></div>
    </div>
    ${
      isEdit
        ? `<div class="form-row">
            <div><label>Site</label><select name="site_id" required>${siteOptions(w.site_id)}</select></div>
            <div><label>Status</label>
              <select name="status">
                <option value="active" ${w.status === 'active' || !w.status ? 'selected' : ''}>Active</option>
                <option value="inactive" ${w.status === 'inactive' ? 'selected' : ''}>Inactive</option>
              </select>
            </div>
          </div>`
        : `<p class="hint">New workers are auto-assigned to <b>site 100 — Unassigned Pool</b>. Assign them to a real site afterwards from the Edit screen.</p>`
    }
    <div class="form-row">
      <div><label>Hourly wage rate (₹)</label><input name="wage_rate" type="number" step="0.01" min="0.01" required value="${w.wage_rate ?? ''}"></div>
      <div><label>Overtime multiplier</label><input name="overtime_multiplier" type="number" step="0.1" value="${w.overtime_multiplier ?? 1.5}"></div>
    </div>
    <div class="form-row">
      <div><label>Contact phone</label><input name="contact" required pattern="[\\d\\s+-]{10,}" placeholder="10+ digits" value="${esc(w.contact)}"></div>
      <div><label>Joined date</label><input name="joined_date" type="date" value="${esc(w.joined_date) || todayStr()}"></div>
    </div>
    <div class="actions">
      <button class="btn" type="submit">Save</button>
      <a href="/workers" class="btn secondary">Cancel</a>
    </div>
  </form>
  </div>
  ${
    isEdit && canVerify
      ? `<div class="card muted">
          <b>Identity verification</b> — the Aadhar number above is this worker's proof of identity. Mark it once HR has actually checked it against the physical/scanned document.
          <form class="inline" method="POST" action="/workers/${worker.id}/toggle-verification" style="margin-top:8px">
            <button class="btn ${worker.verification_status === 'verified' ? 'secondary' : ''} small" type="submit">${
          worker.verification_status === 'verified' ? 'Mark as pending again' : 'Mark Aadhar as verified'
        }</button>
          </form>
        </div>`
      : isEdit
      ? `<div class="card muted">
          <b>Identity verification</b> — status: <span class="badge ${
            worker.verification_status === 'verified' ? 'active' : 'half_day'
          }">${worker.verification_status === 'verified' ? 'ID Verified' : 'Verification pending'}</span>. Checked off by HR against the Aadhar number above — not editable from this role.
        </div>`
      : ''
  }
  ${
    isEdit && !isAlreadyDirect && directId
      ? `<div class="card muted">
          <form method="POST" action="/workers/${worker.id}/absorb" onsubmit="return confirm('Move ${esc(
            worker.name
          )} to the Bilara (Direct) vendor?')">
            Want to bring this worker onto the direct team instead of their current vendor?
            <button class="btn secondary small" type="submit">Absorb into Bilara (Direct) now →</button>
          </form>
        </div>`
      : ''
  }
  ${
    isEdit
      ? `<div class="card muted">Workers are never permanently deleted${
          hasHistory
            ? ` — this one has ${hist.attendance} attendance record(s)${hist.payrollItems ? ` and ${hist.payrollItems} payroll record(s)` : ''} on file`
            : ''
        }. Set their Status to <b>Inactive</b> above and save instead; that removes them from active lists and attendance/payroll going forward while keeping the record.</div>`
      : ''
  }
  `;
}

// ---------- Vendors ----------
function renderVendors(opts) {
  const errorHtml = opts && opts.error ? `<div class="flash flash-error">${esc(opts.error)}</div>` : '';
  const v0 = (opts && opts.values) || {};
  const page = (opts && opts.page) || 1;
  const totalCount = db.prepare('SELECT COUNT(*) c FROM vendors').get().c;
  const vendors = db
    .prepare(
      `SELECT v.*, (SELECT COUNT(*) FROM workers w WHERE w.vendor_id = v.id) worker_count,
        (SELECT COUNT(*) FROM workers w WHERE w.vendor_id = v.id AND w.status='active') active_worker_count
       FROM vendors v ORDER BY v.is_direct DESC, v.name LIMIT ? OFFSET ?`
    )
    .all(PAGE_SIZE, (page - 1) * PAGE_SIZE);
  return `
  <h1>Vendors</h1>
  <p class="subtitle">Payments for vendor-supplied workers route to the vendor. Direct BilaraGroup workers use the built-in "Direct" vendor.</p>
  ${errorHtml}
  <div class="card">
    <form method="POST" action="/vendors">
      <p class="hint" style="margin-top:0">Vendor ID is assigned automatically once saved.</p>
      <label>Vendor name</label><input name="name" required value="${esc(v0.name)}">
      <div class="form-row">
        <div><label>Contact phone</label><input name="contact" required placeholder="10+ digits" value="${esc(v0.contact)}" oninput="if(document.getElementById('wa-same-add').checked) document.getElementById('wa-field-add').value=this.value"></div>
        <div>
          <label>WhatsApp</label>
          <input name="whatsapp" id="wa-field-add" placeholder="10+ digits, if different" value="${esc(v0.whatsapp)}">
          <label style="text-transform:none;font-weight:400;display:flex;align-items:center;gap:6px;margin:-8px 0 14px">
            <input type="checkbox" id="wa-same-add" name="whatsapp_same" style="width:auto;margin:0" onchange="var f=document.getElementById('wa-field-add'); if(this.checked){f.value=document.querySelector('[name=contact]').value; f.readOnly=true;} else {f.readOnly=false;}">
            Same as contact number
          </label>
        </div>
      </div>
      <div class="form-row">
        <div><label>Email (optional)</label><input name="email" type="email" placeholder="e.g. vendor@example.com" value="${esc(v0.email)}"></div>
        <div><label>Address (optional)</label><input name="address" placeholder="e.g. Street, City" value="${esc(v0.address)}"></div>
      </div>
      <button class="btn" type="submit">Add vendor</button>
    </form>
  </div>
  <div class="table-wrap"><table>
    <tr><th>Code</th><th>Name</th><th>Contact</th><th>Workers</th><th>Status</th><th></th></tr>
    ${vendors
      .map((v) => {
        const deps = vendorDependencyCounts(v.id);
        const canHardDelete = deps.workers === 0 && deps.payrollItems === 0;
        return `<tr>
        <td>${esc(v.vendor_code)}</td>
        <td>${esc(v.name)}${v.is_direct ? ' <span class="badge active">Direct</span>' : ''}</td>
        <td>${esc(v.contact || '—')}</td>
        <td>${v.worker_count}${v.active_worker_count !== v.worker_count ? ` (${v.active_worker_count} active)` : ''}</td>
        <td><span class="badge ${v.active ? 'active' : 'inactive'}">${v.active ? 'active' : 'deactivated'}</span></td>
        <td>
          <a href="/vendors/${v.id}/edit">Edit</a>
          ${
            v.is_direct
              ? ''
              : canHardDelete
              ? ` · <form class="inline" method="POST" action="/vendors/${v.id}/delete" onsubmit="return confirm('Delete this vendor? It has no workers or payroll history, so this is permanent.')"><button class="btn danger small" type="submit">Delete</button></form>`
              : ` · <form class="inline" method="POST" action="/vendors/${v.id}/toggle-active" onsubmit="return confirm('${
                  v.active ? 'Deactivate' : 'Reactivate'
                } this vendor?')"><button class="btn secondary small" type="submit">${v.active ? 'Deactivate' : 'Reactivate'}</button></form>`
          }
        </td>
      </tr>`;
      })
      .join('')}
  </table></div>
  ${paginationControls('/vendors', page, totalCount, PAGE_SIZE)}
  <p class="hint">A vendor with workers or payroll history attached can't be permanently deleted — it can only be deactivated (so it stops appearing for new assignments) after its workers are reassigned or marked inactive. Open a vendor's Edit page to manage its workers.</p>
  `;
}

function renderVendorForm(vendor, opts) {
  const v = Object.assign({}, vendor, (opts && opts.values) || {});
  const errorHtml = opts && opts.error ? `<div class="flash flash-error">${esc(opts.error)}</div>` : '';
  const deps = vendorDependencyCounts(vendor.id);
  const activeWorkers = db
    .prepare(`SELECT w.id, w.name FROM workers w WHERE w.vendor_id = ? AND w.status = 'active' ORDER BY w.name`)
    .all(vendor.id);

  return `
  <h1>Edit vendor</h1>
  ${errorHtml}
  <div class="card">
  <form method="POST" action="/vendors/${vendor.id}">
    <div class="form-row">
      <div><label>Vendor code</label><input name="vendor_code" required value="${esc(v.vendor_code)}" ${
        v.is_direct ? 'readonly' : ''
      }></div>
      <div><label>Vendor name</label><input name="name" required value="${esc(v.name)}"></div>
    </div>
    <div class="form-row">
      <div><label>Contact phone</label><input name="contact" required placeholder="10+ digits" value="${esc(v.contact)}" oninput="if(document.getElementById('wa-same-edit').checked) document.getElementById('wa-field-edit').value=this.value"></div>
      <div>
        <label>WhatsApp</label>
        <input name="whatsapp" id="wa-field-edit" placeholder="10+ digits, if different" value="${esc(v.whatsapp)}">
        <label style="text-transform:none;font-weight:400;display:flex;align-items:center;gap:6px;margin:-8px 0 14px">
          <input type="checkbox" id="wa-same-edit" name="whatsapp_same" style="width:auto;margin:0" ${
            v.whatsapp && v.contact && v.whatsapp === v.contact ? 'checked' : ''
          } onchange="var f=document.getElementById('wa-field-edit'); if(this.checked){f.value=document.querySelector('[name=contact]').value; f.readOnly=true;} else {f.readOnly=false;}">
          Same as contact number
        </label>
      </div>
    </div>
    <div class="form-row">
      <div><label>Email (optional)</label><input name="email" type="email" value="${esc(v.email)}"></div>
      <div><label>Address (optional)</label><input name="address" value="${esc(v.address)}"></div>
    </div>
    ${v.is_direct ? '<p class="hint">This is the built-in Direct vendor for BilaraGroup employees — its code is fixed, but you can still rename it or update contact details.</p>' : ''}
    <div class="actions">
      <button class="btn" type="submit">Save</button>
      <a href="/vendors" class="btn secondary">Cancel</a>
    </div>
  </form>
  </div>

  ${
    !v.is_direct
      ? `
  <div class="card muted">
    <form class="inline" method="POST" action="/vendors/${vendor.id}/toggle-active" onsubmit="return confirm('${
          vendor.active ? 'Deactivate' : 'Reactivate'
        } this vendor?')"><button class="btn secondary" type="submit">${vendor.active ? 'Deactivate vendor' : 'Reactivate vendor'}</button></form>
  </div>
  <h2>Workers currently with this vendor</h2>
  <p class="subtitle">${deps.workers} total (${deps.activeWorkers} active)${
          deps.payrollItems ? ` · ${deps.payrollItems} historical payroll record(s) reference this vendor` : ''
        }</p>
  ${
    activeWorkers.length === 0
      ? `<div class="card muted">No active workers are with this vendor right now.${
          deps.workers > deps.activeWorkers ? ' (Inactive workers still on file are unaffected.)' : ''
        }</div>`
      : `
  <div class="card">
    <h2 class="mt-0" style="margin-top:0">Absorb into another vendor (bulk reassign)</h2>
    <form method="POST" action="/vendors/${vendor.id}/reassign-workers">
      <label>Move all ${activeWorkers.length} active worker(s) to</label>
      <select name="target_vendor_id" required><option value="">Select vendor…</option>${vendorOptions(null, { excludeId: vendor.id })}</select>
      <button class="btn secondary" type="submit">Reassign all workers</button>
    </form>
  </div>
  <div class="card">
    <h2 class="mt-0" style="margin-top:0">Or mark all their workers inactive</h2>
    <p class="hint">Use this if the vendor relationship is ending and these workers are leaving too (rather than moving to another vendor or being absorbed directly).</p>
    <form method="POST" action="/vendors/${vendor.id}/deactivate-workers" onsubmit="return confirm('Mark all ${activeWorkers.length} active worker(s) for this vendor as inactive?')">
      <button class="btn danger" type="submit">Mark all ${activeWorkers.length} worker(s) inactive</button>
    </form>
  </div>`
  }`
      : ''
  }
  `;
}

// ---------- Worker types ----------
function renderWorkerTypes() {
  const types = db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM workers w WHERE w.worker_type_id = t.id) worker_count FROM worker_types t ORDER BY t.name`
    )
    .all();
  return `
  <h1>Worker types</h1>
  <p class="subtitle">Manage the list of worker types (Mason, Helper, Tile Worker, …) available when adding a worker.</p>
  <div class="card">
    <form method="POST" action="/worker-types">
      <label>New worker type</label>
      <div class="form-row">
        <div><input name="name" required placeholder="e.g. Tile Worker"></div>
        <div><button class="btn" type="submit" style="margin-top:0">Add type</button></div>
      </div>
    </form>
  </div>
  <div class="table-wrap"><table>
    <tr><th>Type</th><th>Workers</th><th>Status</th><th></th></tr>
    ${types
      .map(
        (t) => `<tr>
        <td>${esc(t.name)}</td><td>${t.worker_count}</td>
        <td><span class="badge ${t.active ? 'active' : 'inactive'}">${t.active ? 'active' : 'disabled'}</span></td>
        <td><form class="inline" method="POST" action="/worker-types/${t.id}/toggle"><button class="btn secondary small" type="submit">${
          t.active ? 'Disable' : 'Enable'
        }</button></form></td>
      </tr>`
      )
      .join('')}
  </table></div>
  `;
}

// ---------- Skill assessments (v9.2) ----------
// A separate tab from Add/Edit Worker, per Zen's explicit request — rating a
// worker's specific competencies (e.g. a Mason's Foundation/Setting out/
// Plastering/Brick work) is a distinct workflow from managing the worker
// record itself, so it gets its own page rather than more fields crammed
// into the worker form. Categories are scoped per worker type (admin-managed,
// same soft-disable pattern as worker_types) and ratings use the same
// trainee/skilled/expert scale as the existing overall skill_grade.
function skillCategoriesForType(workerTypeId, opts) {
  const activeOnly = !opts || opts.activeOnly !== false;
  return db
    .prepare(`SELECT * FROM skill_categories WHERE worker_type_id = ? ${activeOnly ? 'AND active = 1' : ''} ORDER BY name`)
    .all(workerTypeId);
}

// Category management moved to its own page (/skill-assessments/categories,
// below) — per Zen's feedback, an occasional admin setup task (define which
// skills exist per worker type) doesn't belong glued onto the daily "rate a
// worker" workflow. Same pattern as /worker-types already being separate
// from /workers, extended here for consistency.
function renderSkillCategories(user, opts) {
  const errorHtml = opts && opts.error ? `<div class="flash flash-error">${esc(opts.error)}</div>` : '';
  const workerTypes = db.prepare('SELECT * FROM worker_types WHERE active = 1 ORDER BY name').all();
  const allCategories = db
    .prepare(`SELECT sc.*, wt.name type_name FROM skill_categories sc JOIN worker_types wt ON wt.id = sc.worker_type_id ORDER BY wt.name, sc.name`)
    .all();
  const byType = {};
  allCategories.forEach((c) => {
    (byType[c.worker_type_id] = byType[c.worker_type_id] || []).push(c);
  });
  return `
  <h1>Manage skill categories</h1>
  <p class="subtitle">Define which skills get rated for each worker type on the Skill assessments page. Mason and Helper already come with a default 5-category list — add more for other types as needed.</p>
  ${errorHtml}
  <div class="card">
    <form method="POST" action="/skill-assessments/categories">
      <div class="form-row">
        <div><label>Worker type</label><select name="worker_type_id" required><option value="">Select type…</option>${workerTypeOptions(
          (opts && opts.selectedType) || ''
        )}</select></div>
        <div><label>New category name</label><input name="name" required placeholder="e.g. Brickwork"></div>
      </div>
      <button class="btn secondary" type="submit">Add category</button>
    </form>
  </div>
  ${
    workerTypes
      .map((t) => {
        const cats = byType[t.id] || [];
        if (cats.length === 0) return '';
        return `<div class="card"><h2 class="mt-0" style="margin-top:0">${esc(t.name)}</h2><div class="table-wrap"><table>
          <tr><th>Category</th><th>Status</th><th></th></tr>
          ${cats
            .map(
              (c) => `<tr>
            <td>
              <form class="inline" method="POST" action="/skill-assessments/categories/${c.id}/rename" style="display:flex;gap:8px;align-items:center">
                <input name="name" value="${esc(c.name)}" required style="margin-bottom:0;padding:7px 10px;font-size:13.5px;width:auto;flex:1;min-width:160px">
                <button class="btn secondary small" type="submit">Save</button>
              </form>
            </td>
            <td><span class="badge ${c.active ? 'active' : 'inactive'}">${c.active ? 'active' : 'disabled'}</span></td>
            <td><form class="inline" method="POST" action="/skill-assessments/categories/${c.id}/toggle"><button class="btn secondary small" type="submit">${
              c.active ? 'Disable' : 'Enable'
            }</button></form></td>
          </tr>`
            )
            .join('')}
        </table></div></div>`;
      })
      .join('') || '<div class="card muted">No skill categories defined yet — add one above.</div>'
  }
  <h2><a href="/skill-assessments">← Back to Skill assessments</a></h2>
  `;
}

function renderSkillAssessments(user, query, opts) {
  const errorHtml = opts && opts.error ? `<div class="flash flash-error">${esc(opts.error)}</div>` : '';
  const savedHtml = opts && opts.saved ? `<div class="flash flash-success">Saved ratings for ${esc(opts.saved)}.</div>` : '';
  const canManageCategories = can(user, 'skillcategories.manage');

  const workerTypes = db.prepare('SELECT * FROM worker_types WHERE active = 1 ORDER BY name').all();

  const manageCategoriesLinkHtml = canManageCategories
    ? `<h2 style="margin-top:0"><a href="/skill-assessments/categories">Manage skill categories →</a></h2>`
    : '';

  // ---- Worker picker ----
  const q = (query.q || '').trim();
  const typeFilter = query.worker_type_id || '';
  let workerSql = `SELECT w.*, wt.name type_name, s.name site_name FROM workers w
     LEFT JOIN worker_types wt ON wt.id = w.worker_type_id LEFT JOIN sites s ON s.id = w.site_id
     WHERE w.status = 'active'`;
  const params = {};
  if (q) {
    workerSql += ' AND (w.name LIKE @q OR w.worker_code LIKE @q)';
    params.q = `%${q}%`;
  }
  if (typeFilter) {
    workerSql += ' AND w.worker_type_id = @typeFilter';
    params.typeFilter = typeFilter;
  }
  const scope = siteScopeForUser(user);
  workerSql += siteScopeClause('w.site_id', scope);
  workerSql += ' ORDER BY w.name LIMIT 100';
  const workers = db.prepare(workerSql).all(params);

  const selectedWorkerId = query.worker_id || '';
  const selectedWorker = selectedWorkerId ? db.prepare('SELECT * FROM workers WHERE id = ?').get(selectedWorkerId) : null;

  // ---- Rating form for the selected worker ----
  let ratingFormHtml = '';
  if (selectedWorker) {
    const cats = skillCategoriesForType(selectedWorker.worker_type_id);
    const existing = {};
    db.prepare('SELECT * FROM worker_skill_ratings WHERE worker_id = ?')
      .all(selectedWorker.id)
      .forEach((r) => (existing[r.skill_category_id] = r.rating));
    const typeName = (workerTypes.find((t) => t.id === selectedWorker.worker_type_id) || {}).name || '—';
    ratingFormHtml = `
    <div class="card highlight">
      <p class="eyebrow" style="margin-top:0">Rating</p>
      <h2 class="mt-0" style="margin-top:0">${esc(selectedWorker.name)} <span class="muted" style="font-weight:400">· ${esc(typeName)} · ${esc(
      selectedWorker.worker_code || '—'
    )}</span></h2>
      ${
        cats.length === 0
          ? `<p class="hint">No skill categories defined yet for ${esc(typeName)}.${
              canManageCategories ? ' <a href="/skill-assessments/categories">Add some</a>.' : ' Ask an admin to add some.'
            }</p>`
          : `<form method="POST" action="/skill-assessments/rate">
        <input type="hidden" name="worker_id" value="${selectedWorker.id}">
        <input type="hidden" name="return_query" value="${esc(`q=${encodeURIComponent(q)}&worker_type_id=${esc(typeFilter)}`)}">
        <div class="grid grid-3">
          ${cats
            .map(
              (c) => `<div>
            <label>${esc(c.name)}</label>
            <select name="rating_${c.id}">
              <option value="">Not rated</option>
              ${['trainee', 'skilled', 'expert']
                .map((r) => `<option value="${r}" ${existing[c.id] === r ? 'selected' : ''}>${SKILL_GRADE_LABEL[r]}</option>`)
                .join('')}
            </select>
          </div>`
            )
            .join('')}
        </div>
        <button class="btn" type="submit" style="margin-top:14px">Save ratings</button>
      </form>`
      }
    </div>`;
  }

  return `
  <h1>Skill assessments</h1>
  <p class="subtitle">Rate a worker's specific skills — separate from adding or editing their record. Ratings use the same Trainee / Skilled / Expert scale as the worker's overall skill grade.</p>
  ${errorHtml}
  ${savedHtml}
  ${manageCategoriesLinkHtml}
  <h2 style="margin-top:0">Find a worker to rate</h2>
  <div class="card">
    <form method="GET" action="/skill-assessments" class="form-row" style="flex-wrap:wrap">
      <div><label>Search by name or ID</label><input name="q" value="${esc(q)}" placeholder="e.g. Ravi or W00012"></div>
      <div><label>Worker type</label><select name="worker_type_id"><option value="">All types</option>${workerTypeOptions(
        typeFilter
      )}</select></div>
      <div style="align-self:flex-end"><button class="btn secondary" type="submit" style="margin-bottom:14px">Filter</button></div>
    </form>
  </div>
  ${ratingFormHtml}
  <hr class="section-divider">
  <h2 style="margin-top:0">Workers${typeFilter ? ` · ${esc((workerTypes.find((t) => String(t.id) === String(typeFilter)) || {}).name || '')}` : ''}</h2>
  <div class="table-wrap"><table>
    <tr><th>ID</th><th>Name</th><th>Type</th><th>Site</th><th>Overall grade</th><th></th></tr>
    ${workers
      .map((w) => {
        const catCount = skillCategoriesForType(w.worker_type_id).length;
        const ratedCount = catCount
          ? db
              .prepare(
                `SELECT COUNT(*) c FROM worker_skill_ratings wsr JOIN skill_categories sc ON sc.id = wsr.skill_category_id WHERE wsr.worker_id = ? AND sc.active = 1`
              )
              .get(w.id).c
          : 0;
        return `<tr ${String(w.id) === String(selectedWorkerId) ? 'style="background:var(--bg-muted, #f4f4f8)"' : ''}>
        <td class="muted">${esc(w.worker_code || '—')}</td>
        <td>${esc(w.name)}</td>
        <td>${esc(w.type_name || '—')}</td>
        <td>${w.site_id === POOL_SITE_ID ? '<span class="badge inactive">100 — Pool</span>' : `${w.site_id} — ${esc(w.site_name || '—')}`}</td>
        <td>${catCount ? `<span class="muted">${ratedCount}/${catCount} rated</span>` : '<span class="muted">no categories</span>'}</td>
        <td><a class="btn secondary small" href="/skill-assessments?worker_id=${w.id}&q=${encodeURIComponent(q)}&worker_type_id=${esc(
          typeFilter
        )}">Rate skills</a></td>
      </tr>`;
      })
      .join('')}
    ${workers.length === 0 ? '<tr><td colspan="6" class="muted">No active workers match.</td></tr>' : ''}
  </table></div>
  ${workers.length === 100 ? '<p class="hint">Showing the first 100 matching workers — narrow your search to find someone specific.</p>' : ''}
  `;
}

// ---------- Attendance ----------
function attendanceLabel(row) {
  if (row.hours_worked > 0 && row.leave_hours > 0) return `<span class="badge half_day">Partial + leave</span>`;
  if (row.hours_worked > 0) return `<span class="badge present">Worked</span>`;
  if (row.leave_hours > 0) return `<span class="badge half_day">Leave</span>`;
  return `<span class="badge absent">Absent</span>`;
}

function renderAttendance(user, query) {
  const date = query.date || todayStr();
  const siteId = user.role === 'supervisor' ? user.site_id : query.site_id || '';

  let gridHtml = '';
  if (siteId) {
    const workers = db
      .prepare(`SELECT * FROM workers WHERE status='active' AND site_id = ? ORDER BY name`)
      .all(siteId);
    const existing = {};
    db.prepare(`SELECT * FROM attendance WHERE date = ? AND site_id = ?`)
      .all(date, siteId)
      .forEach((a) => (existing[a.worker_id] = a));

    const rows = workers
      .map((w) => {
        const rec = existing[w.id];
        const hours = rec ? rec.hours_worked : 8;
        const leave = rec ? rec.leave_hours : 0;
        const ot = rec ? rec.overtime_hours : 0;
        return `<tr>
          <td>${esc(w.name)}</td>
          <td><input name="hours_${w.id}" type="number" step="0.5" min="0" value="${hours}" style="margin-bottom:0"></td>
          <td><input name="leave_${w.id}" type="number" step="0.5" min="0" value="${leave}" style="margin-bottom:0"></td>
          <td><input name="ot_${w.id}" type="number" step="0.5" min="0" value="${ot}" style="margin-bottom:0"></td>
        </tr>`;
      })
      .join('');

    gridHtml = `
    <form method="POST" action="/attendance">
      <input type="hidden" name="date" value="${esc(date)}">
      <input type="hidden" name="site_id" value="${esc(siteId)}">
      <div class="table-wrap"><table>
        <tr><th>Worker</th><th>Hours worked</th><th>Leave hours</th><th>Overtime hours</th></tr>
        ${rows || '<tr><td colspan="4" class="muted">No active workers at this site.</td></tr>'}
      </table></div>
      ${workers.length ? '<div class="actions"><button class="btn" type="submit">Save attendance for this site</button></div>' : ''}
    </form>`;
  } else {
    gridHtml = `<div class="card muted">Choose a site above to bulk-mark attendance for its crew.</div>`;
  }

  // Site off days used to be an inline card on this page — Zen's feedback
  // was that an occasional setup task (marking a date off) glued onto the
  // daily marking workflow reads as cluttered. It's now its own page
  // (/attendance/site-off), reached via this link, same pattern as
  // /worker-types being separate from /workers.
  const siteOffLinkHtml = `<h2 style="margin-top:0"><a href="/attendance/site-off${siteId ? `?site_id=${encodeURIComponent(siteId)}` : ''}">Manage site off days →</a></h2>`;

  // "Add a single entry" used to sit on this page as a second form below the
  // grid. Bulk-marking a site's crew is the near-daily task; a single entry is
  // an exception (a split-site day, a correction), so it's now its own page
  // reached from the secondary link below — same split as site off days above.
  const singleEntryLinkHtml = `<div class="actions"><a class="btn secondary" href="/attendance/single-entry?date=${encodeURIComponent(
    date
  )}${siteId ? `&site_id=${encodeURIComponent(siteId)}` : ''}">Add single attendance entry →</a></div>
  <p class="hint" style="margin-top:8px">For one worker at a time — corrections, split-site days, or partial-day leave.</p>`;

  const siteSelector =
    user.role === 'supervisor'
      ? ''
      : `<div><label>Site</label><select name="site_id" onchange="this.form.submit()"><option value="">Choose a site…</option>${siteOptions(
          siteId,
          { activeOnly: true }
        )}</select></div>`;

  const blockedNotice = noEligibleSiteNotice(user);
  if (blockedNotice) {
    return `
  <h1>Mark attendance</h1>
  ${blockedNotice}
  <h2><a href="/attendance/history">View attendance history →</a></h2>
  `;
  }

  return `
  <h1>Mark attendance</h1>
  <p class="subtitle">Bulk-mark a whole site's crew for a date. Pick the date and site, fill in the grid, and save once.</p>
  <form method="GET" action="/attendance" class="form-row" style="max-width:500px">
    <div><label>Date</label><input name="date" type="date" value="${esc(date)}" onchange="this.form.submit()"></div>
    ${siteSelector}
  </form>
  ${gridHtml}
  ${singleEntryLinkHtml}
  ${siteOffLinkHtml}
  <h2><a href="/attendance/history">View attendance history →</a></h2>
  `;
}

// One worker, one site, one date — the exception case (a day split across two
// sites, a partial-day leave, or a correction to something already marked).
// Deliberately its own page so the daily bulk-marking grid on /attendance has
// exactly one form on it; posts to the same /attendance/entry handler the form
// always used, so validation, the supervisor site clamp, and the upsert are
// unchanged and defined in exactly one place.
function renderSingleEntry(user, query, opts) {
  const o = opts || {};
  const values = o.values || {};
  const date = values.date || query.date || todayStr();
  const savedHtml = query.saved
    ? `<div class="flash flash-success">Entry saved for ${esc(query.saved)}.</div>`
    : '';

  // Only active workers are offered (an inactive worker is rejected
  // server-side too). For a site-scoped user the list is split: their own
  // site's crew first, then everyone else under an explicit "visiting" group —
  // recording a visiting worker at your own site is legitimate (that's the
  // split-site case), but it shouldn't be an accident, so it's a deliberate
  // pick from a labelled group rather than one flat list.
  const activeWorkers = db
    .prepare(`SELECT w.id, w.name, w.site_id, s.name site_name FROM workers w LEFT JOIN sites s ON s.id = w.site_id WHERE w.status='active' ORDER BY w.name`)
    .all();
  // data-home/-id let the visiting-worker note below compare a selected
  // worker's home site against whatever site the form is currently set to,
  // client-side, without a round trip — same "the form only offers what the
  // server would accept, but the server re-checks anyway" split as the rest
  // of this page.
  const workerOption = (w) => {
    const homeLabel = w.site_id === POOL_SITE_ID ? 'Unassigned Pool' : w.site_name || `Site ${w.site_id}`;
    return `<option value="${w.id}" data-home="${esc(homeLabel)}" data-home-id="${esc(w.site_id)}" ${
      String(values.worker_id || '') === String(w.id) ? 'selected' : ''
    }>${esc(w.name)} — ${w.site_id === POOL_SITE_ID ? 'Unassigned Pool' : `site ${w.site_id}`}</option>`;
  };
  const scope = siteScopeForUser(user);
  let workerOptionsHtml;
  if (scope === null) {
    workerOptionsHtml = activeWorkers.map(workerOption).join('');
  } else {
    const own = activeWorkers.filter((w) => scope.includes(Number(w.site_id)));
    const visiting = activeWorkers.filter((w) => !scope.includes(Number(w.site_id)));
    workerOptionsHtml =
      (own.length ? `<optgroup label="Your site">${own.map(workerOption).join('')}</optgroup>` : '') +
      (visiting.length
        ? `<optgroup label="Visiting from another site">${visiting.map(workerOption).join('')}</optgroup>`
        : '');
  }

  const blockedNotice = noEligibleSiteNotice(user);
  if (blockedNotice) {
    return `
  <h1>Add single attendance entry</h1>
  ${blockedNotice}
  <div class="actions"><a href="/attendance" class="btn secondary">Back to site attendance</a></div>
  `;
  }

  return `
  <h1>Add single attendance entry</h1>
  <p class="subtitle">For one worker at a time — a correction to an entry already marked, a day split across two sites, or a partial-day leave. To mark a whole site's crew for a date, use <a href="/attendance">site attendance</a> instead.</p>
  ${savedHtml}
  <div class="card">
    <form method="POST" action="/attendance/entry">
      <div class="form-row">
        <div><label>Worker</label><select name="worker_id" id="single-entry-worker" required><option value="">Select worker…</option>${workerOptionsHtml}</select></div>
        <div><label>Site worked at</label><select name="site_id" id="single-entry-site" required><option value="">Select site…</option>${siteOptions(
          values.site_id || undefined,
          { activeOnly: true, onlyIds: scope === null ? undefined : scope }
        )}</select></div>
      </div>
      <p id="visiting-note" class="hint" style="display:none"></p>
      <div class="form-row">
        <div><label>Date</label><input name="date" type="date" value="${esc(date)}" required></div>
        <div><label>Hours worked</label><input name="hours" type="number" step="0.5" min="0" value="${esc(values.hours || '0')}"></div>
      </div>
      <div class="form-row">
        <div><label>Leave hours</label><input name="leave" type="number" step="0.5" min="0" value="${esc(values.leave || '0')}"></div>
        <div><label>Overtime hours</label><input name="ot" type="number" step="0.5" min="0" value="${esc(values.ot || '0')}"></div>
      </div>
      <p class="hint">Saving an entry for a worker/site/date that already has one overwrites it — that's how a correction is made.</p>
      <div class="actions">
        <button class="btn" type="submit">Save entry</button>
        <a href="/attendance" class="btn secondary">Back to site attendance</a>
      </div>
    </form>
  </div>
  ${visitingWorkerNoteScript}
  <h2><a href="/attendance/history">View attendance history →</a></h2>
  `;
}

// A site can be marked off for a date so payroll excludes it — an occasional
// setup task, deliberately its own page rather than a card bolted onto the
// daily "Mark attendance" workflow (see renderAttendance's link to here).
function renderSiteOff(user, query) {
  const date = query.date || todayStr();
  const siteId = user.role === 'supervisor' ? user.site_id : query.site_id || '';

  const siteSelector =
    user.role === 'supervisor'
      ? ''
      : `<div><label>Site</label><select name="site_id" onchange="this.form.submit()"><option value="">Choose a site…</option>${siteOptions(
          siteId
        )}</select></div>`;

  let bodyHtml = '';
  if (siteId) {
    const offDays = db.prepare('SELECT * FROM site_off_days WHERE site_id = ? ORDER BY date DESC LIMIT 20').all(siteId);
    const alreadyOffToday = offDays.some((o) => o.date === date);
    bodyHtml = `
    <div class="card">
      ${
        alreadyOffToday
          ? `<p class="hint" style="margin-top:0">${esc(date)} is already marked off for this site.</p>`
          : `<form method="POST" action="/attendance/site-off">
              <input type="hidden" name="site_id" value="${esc(siteId)}">
              <div class="form-row">
                <div><label>Date</label><input name="date" type="date" value="${esc(date)}" required></div>
                <div><label>Reason (optional)</label><input name="reason" placeholder="e.g. Public holiday, rain-out"></div>
              </div>
              <button class="btn secondary" type="submit">Mark this date off for this site</button>
            </form>`
      }
      ${
        offDays.length
          ? `<table style="margin-top:18px"><tr><th>Date</th><th>Reason</th><th></th></tr>${offDays
              .map(
                (o) =>
                  `<tr><td>${esc(o.date)}</td><td>${esc(o.reason || '—')}</td><td><form class="inline" method="POST" action="/attendance/site-off/${o.id}/delete" onsubmit="return confirm('Remove this off-day?')"><button class="btn danger small" type="submit">×</button></form></td></tr>`
              )
              .join('')}</table>`
          : '<p class="hint" style="margin-top:18px">No off days recorded yet for this site.</p>'
      }
    </div>`;
  } else {
    bodyHtml = `<div class="card muted">Choose a site above to mark or review its off days.</div>`;
  }

  return `
  <h1>Site off days</h1>
  <p class="subtitle">A date marked off here is excluded from pay when payroll is generated for the overlapping period — no matter what (if anything) got logged for it.</p>
  <div class="card">
    <form method="GET" action="/attendance/site-off" class="form-row" style="flex-wrap:wrap;max-width:500px">
      ${siteSelector}
    </form>
  </div>
  ${bodyHtml}
  <h2><a href="/attendance">← Back to Mark attendance</a></h2>
  `;
}

function attendanceHistoryRows(user, query) {
  const from = query.from || todayStr();
  const to = query.to || todayStr();
  const scope = siteScopeForUser(user);
  const isSingleSite = scope !== null && scope.length <= 1;
  const siteFilterId = isSingleSite ? scope[0] || '' : query.site_id || '';
  let siteFilter;
  if (scope !== null) {
    // Restricted user (supervisor: 1 site; PM/site engineer: their assigned
    // sites) — further narrow by their own site_id filter dropdown if picked,
    // but never outside their scope. @siteId is always referenced (even when
    // unused) since node:sqlite rejects a bound param the query text doesn't
    // mention.
    siteFilter = siteScopeClause('a.site_id', scope) + ' AND (@siteId IS NULL OR a.site_id = @siteId)';
  } else {
    siteFilter = siteFilterId ? 'AND a.site_id = @siteId' : 'AND (@siteId IS NULL OR 1=1)';
  }
  const rows = db
    .prepare(
      `SELECT a.*, w.name worker_name, s.name site_name FROM attendance a
       JOIN workers w ON w.id = a.worker_id
       LEFT JOIN sites s ON s.id = a.site_id
       WHERE a.date BETWEEN @from AND @to ${siteFilter}
       ORDER BY a.date DESC, s.name, w.name`
    )
    .all({ from, to, siteId: siteFilterId || null });
  return { from, to, scope, isSingleSite, siteFilterId, rows };
}

function renderAttendanceHistory(user, query) {
  const { from, to, scope, isSingleSite, siteFilterId, rows } = attendanceHistoryRows(user, query);
  // Only roles that can actually delete an entry get the × column — everyone
  // else gets a clean read-only table instead of a button that would 403.
  const canDelete = can(user, 'attendance.delete');

  // Quick summary so a wide date range still reads at a glance before scrolling
  // through every row.
  const distinctWorkers = new Set(rows.map((r) => r.worker_id)).size;
  const totalHours = rows.reduce((s, r) => s + (r.hours_worked || 0), 0);
  const totalOvertime = rows.reduce((s, r) => s + (r.overtime_hours || 0), 0);
  const totalLeave = rows.reduce((s, r) => s + (r.leave_hours || 0), 0);

  // Group rows by date so a long range doesn't repeat the date on every line —
  // each date becomes its own labeled block, which is far easier to scan.
  const byDate = [];
  let currentDate = null;
  let currentGroup = null;
  for (const r of rows) {
    if (r.date !== currentDate) {
      currentDate = r.date;
      currentGroup = { date: r.date, rows: [] };
      byDate.push(currentGroup);
    }
    currentGroup.rows.push(r);
  }

  return `
  <h1>Attendance history</h1>
  <form method="GET" action="/attendance/history" class="form-row" style="max-width:${isSingleSite ? '420' : '620'}px; flex-wrap:wrap">
    <div><label>From</label><input name="from" type="date" value="${esc(from)}"></div>
    <div><label>To</label><input name="to" type="date" value="${esc(to)}"></div>
    ${
      !isSingleSite
        ? `<div><label>Site</label><select name="site_id">${
            '<option value="">All sites</option>' + siteOptions(siteFilterId, scope !== null ? { onlyIds: scope } : {})
          }</select></div>`
        : ''
    }
    <div style="align-self:flex-end"><button class="btn secondary" type="submit" style="margin-bottom:14px">Filter</button></div>
  </form>
  <div class="actions" style="margin-top:0;margin-bottom:20px"><a href="/attendance/history/export.csv?from=${esc(from)}&to=${esc(to)}${siteFilterId ? '&site_id=' + esc(siteFilterId) : ''}" class="btn secondary small">⬇ Export CSV</a></div>

  <div class="grid grid-4" style="margin-bottom:20px">
    <div class="stat"><div class="stat-label">Entries</div><div class="stat-value">${rows.length}</div></div>
    <div class="stat"><div class="stat-label">Workers covered</div><div class="stat-value">${distinctWorkers}</div></div>
    <div class="stat"><div class="stat-label">Hours logged</div><div class="stat-value">${totalHours}</div><div class="stat-sub">${totalOvertime} OT · ${totalLeave} leave</div></div>
    <div class="stat"><div class="stat-label">Days in range</div><div class="stat-value">${byDate.length}</div></div>
  </div>

  ${rows.length > 0 ? `<input type="text" id="attendance-search" placeholder="Quick filter by worker name…" oninput="filterAttendanceRows(this.value)" style="max-width:320px">` : ''}

  ${byDate
    .map(
      (group) => `
    <div class="attendance-day-group">
      <div class="attendance-day-heading">${esc(group.date)} <span class="muted" style="font-weight:400">· ${group.rows.length} ${group.rows.length === 1 ? 'entry' : 'entries'}</span></div>
      <div class="table-wrap"><table class="attendance-table">
        <tr><th>Worker</th><th>Site</th><th>Hours</th><th>Leave</th><th>OT</th>${canDelete ? '<th></th>' : ''}</tr>
        ${group.rows
          .map(
            (r) => `<tr data-worker="${esc((r.worker_name || '').toLowerCase())}">
            <td>${esc(r.worker_name)}</td><td>${r.site_id === POOL_SITE_ID ? '<span class="badge inactive">100 — Pool</span>' : `${r.site_id} — ${esc(r.site_name || '—')}`}</td>
            <td>${attendanceLabel(r)} ${r.hours_worked}</td><td>${r.leave_hours}</td><td>${r.overtime_hours}</td>
            ${canDelete ? `<td><form class="inline" method="POST" action="/attendance/${r.id}/delete" onsubmit="return confirm('Delete this entry?')"><button class="btn danger small" type="submit">×</button></form></td>` : ''}
          </tr>`
          )
          .join('')}
      </table></div>
    </div>`
    )
    .join('')}
  ${rows.length === 0 ? '<div class="card muted">No records in this range.</div>' : ''}
  <p><a href="/attendance">← Back to mark attendance</a></p>
  ${
    rows.length > 0
      ? `<script>
  function filterAttendanceRows(q) {
    q = q.trim().toLowerCase();
    document.querySelectorAll('.attendance-table tr[data-worker]').forEach(function (tr) {
      tr.style.display = !q || tr.getAttribute('data-worker').indexOf(q) !== -1 ? '' : 'none';
    });
    document.querySelectorAll('.attendance-day-group').forEach(function (group) {
      var anyVisible = Array.prototype.some.call(group.querySelectorAll('tr[data-worker]'), function (tr) {
        return tr.style.display !== 'none';
      });
      group.style.display = anyVisible ? '' : 'none';
    });
  }
  </script>`
      : ''
  }
  `;
}

// ---------- Payroll ----------
const PAYROLL_STATUS_LABEL = { pending_verification: 'Pending verification', verified: 'Verified', completed: 'Completed' };
const PAYROLL_STATUS_BADGE = { pending_verification: 'half_day', verified: 'active', completed: 'active' };

function renderPayrollList(user, query) {
  const page = pageFromQuery(query || {});
  const totalCount = db.prepare('SELECT COUNT(*) c FROM payroll_runs').get().c;
  const runs = db
    .prepare(
      `SELECT pr.*, u.name generated_by_name,
        (SELECT COALESCE(SUM(pi.base_pay + pi.overtime_pay),0) - COALESCE((SELECT SUM(pd.amount) FROM payroll_deductions pd JOIN payroll_items pi2 ON pi2.id = pd.payroll_item_id WHERE pi2.payroll_run_id = pr.id),0)
         FROM payroll_items pi WHERE pi.payroll_run_id = pr.id) total
       FROM payroll_runs pr LEFT JOIN users u ON u.id = pr.generated_by
       ORDER BY pr.generated_at DESC LIMIT ? OFFSET ?`
    )
    .all(PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const canGenerate = PAYROLL_GENERATE_ROLES.includes(user.role);
  return `
  <h1>Payroll</h1>
  <p class="subtitle">Pay periods run Thursday → Wednesday. Generated by Labor Manager, then Verified and Completed by Audit Manager. A period can only be generated once — flag a run first if it needs to be redone.</p>
  ${canGenerate ? `<div class="actions" style="margin-top:0;margin-bottom:16px"><a href="/payroll/new" class="btn">+ Generate payroll run</a></div>` : ''}
  <div class="table-wrap"><table>
    <tr><th>Period</th><th>Status</th><th>Generated by</th><th>Generated at</th><th>Net total</th><th></th><th></th></tr>
    ${runs
      .map(
        (r) => `<tr${r.flagged ? ' style="opacity:0.6"' : ''}>
        <td>${esc(r.period_start)} → ${esc(r.period_end)}</td>
        <td><span class="badge ${PAYROLL_STATUS_BADGE[r.status]}">${esc(PAYROLL_STATUS_LABEL[r.status] || r.status)}</span>
          ${r.flagged ? ' <span class="badge inactive">Flagged</span>' : ''}</td>
        <td>${esc(r.generated_by_name || '—')}</td>
        <td>${esc(r.generated_at)}</td>
        <td>${fmtMoney(r.total || 0)}</td>
        <td><a href="/payroll/${r.id}">View</a></td>
        <td>${
          canGenerate && !r.flagged
            ? `<form class="inline" method="POST" action="/payroll/${r.id}/flag" onsubmit="return confirm('Flag this run so its wage period can be regenerated? This does not delete or change any of its data.')"><button class="btn secondary small" type="submit">Flag</button></form>`
            : ''
        }</td>
      </tr>`
      )
      .join('')}
    ${runs.length === 0 ? '<tr><td colspan="7" class="muted">No payroll runs yet.</td></tr>' : ''}
  </table></div>
  ${paginationControls('/payroll', page, totalCount, PAGE_SIZE)}
  `;
}

function renderPayrollNew(opts) {
  const errorHtml = opts && opts.error ? `<div class="flash flash-error">${esc(opts.error)}</div>` : '';
  const period = currentPayPeriod();
  const values = (opts && opts.values) || {};
  const startVal = values.period_start || period.start;
  const endVal = values.period_end || period.end;
  return `
  <h1>Generate payroll run</h1>
  ${errorHtml}
  <div class="card">
  <form method="POST" action="/payroll/generate">
    <div class="form-row">
      <div><label>Period start</label><input id="period_start" name="period_start" type="date" required value="${esc(startVal)}"></div>
      <div><label>Period end (auto)</label><input id="period_end" name="period_end" type="date" required value="${esc(endVal)}" readonly></div>
    </div>
    <p class="hint" style="margin-top:-6px">Pay periods are fixed Thursday → Wednesday weeks. Pick any day and the period snaps to that week automatically — Start moves back to that week's Thursday, End is filled in as the following Wednesday.</p>
    <label>Notes (optional)</label><textarea name="notes" rows="2"></textarea>
    <p class="hint">Pay = hours worked × hourly rate, plus overtime hours × hourly rate × overtime multiplier, across all sites the worker logged attendance at in this range. Leave hours are recorded but unpaid. Any date a site was marked "off" (see the Attendance page) is excluded from pay entirely. If a site has a cut, bonus, or additional payment logged for an overlapping period (see <a href="/site-performance">Site performance</a>), affected workers automatically get an itemized line for their share — visible and further editable per worker after generating. The run starts as <b>Pending verification</b> until Audit Manager verifies and completes it.</p>
    <div class="actions"><button class="btn" type="submit">Generate</button><a href="/payroll" class="btn secondary">Cancel</a></div>
  </form>
  </div>
  ${payPeriodSnapScript('period_start', 'period_end')}
  `;
}

// Site performance adjustments (cut / bonus / additional_payment) logged for
// a site whose date range overlaps the given payroll period. Standard
// interval-overlap check: row.start <= period.end AND row.end >= period.start.
function sitePerformanceAdjustmentsFor(siteId, periodStart, periodEnd) {
  return db.prepare(`SELECT * FROM site_performance WHERE site_id = ? AND period_start <= ? AND period_end >= ? ORDER BY id`).all(siteId, periodEnd, periodStart);
}

function generatePayroll({ period_start, period_end, notes }, userId) {
  const info = db
    .prepare('INSERT INTO payroll_runs (period_start, period_end, generated_by, notes) VALUES (?, ?, ?, ?)')
    .run(period_start, period_end, userId, notes || null);
  const runId = info.lastInsertRowid;

  // Dates a site was marked "off" within (or overlapping) this period — that
  // site+date is excluded from pay entirely, no matter what was logged.
  const offDays = db.prepare(`SELECT site_id, date FROM site_off_days WHERE date BETWEEN ? AND ?`).all(period_start, period_end);
  const offSet = new Set(offDays.map((o) => `${o.site_id}:${o.date}`));

  const workers = db.prepare(`SELECT * FROM workers WHERE status = 'active'`).all();
  const insertItem = db.prepare(
    `INSERT INTO payroll_items (payroll_run_id, worker_id, vendor_id, days_present, leave_hours, hours_worked, overtime_hours, base_pay, overtime_pay)
     VALUES (@runId, @workerId, @vendorId, @daysPresent, @leaveHours, @hoursWorked, @overtimeHours, @basePay, @overtimePay)`
  );
  const insertDeduction = db.prepare(`INSERT INTO payroll_deductions (payroll_item_id, reason, amount) VALUES (?, ?, ?)`);
  const insertItemSite = db.prepare(
    `INSERT INTO payroll_item_sites (payroll_item_id, site_id, hours_worked, overtime_hours, base_pay, overtime_pay, adjustments_total, net_pay)
     VALUES (@itemId, @siteId, @hoursWorked, @overtimeHours, @basePay, @overtimePay, @adjustmentsTotal, @netPay)`
  );
  const siteNameCache = {};
  const siteName = (siteId) => {
    if (!(siteId in siteNameCache)) {
      const s = db.prepare('SELECT name FROM sites WHERE id = ?').get(siteId);
      siteNameCache[siteId] = s ? s.name : `Site ${siteId}`;
    }
    return siteNameCache[siteId];
  };

  // First pass: per-worker site slices (for their own pay + itemized cuts/
  // bonuses), plus a running total per site (needed to prorate flat
  // additional_payment amounts across everyone who worked there).
  const workerData = [];
  const siteTotals = {}; // site_id -> { hours, overtime } across every worker, period-wide
  for (const w of workers) {
    const records = db
      .prepare(`SELECT * FROM attendance WHERE worker_id = ? AND date BETWEEN ? AND ?`)
      .all(w.id, period_start, period_end)
      .filter((r) => !offSet.has(`${r.site_id}:${r.date}`));

    const presentDates = new Set();
    let hoursWorked = 0;
    let overtimeHours = 0;
    let leaveHours = 0;
    const bySite = {}; // site_id -> { hours, overtime }

    for (const r of records) {
      if (r.hours_worked > 0) presentDates.add(r.date);
      hoursWorked += r.hours_worked || 0;
      overtimeHours += r.overtime_hours || 0;
      leaveHours += r.leave_hours || 0;
      if (!bySite[r.site_id]) bySite[r.site_id] = { hours: 0, overtime: 0 };
      bySite[r.site_id].hours += r.hours_worked || 0;
      bySite[r.site_id].overtime += r.overtime_hours || 0;
      if (!siteTotals[r.site_id]) siteTotals[r.site_id] = { hours: 0, overtime: 0 };
      siteTotals[r.site_id].hours += r.hours_worked || 0;
      siteTotals[r.site_id].overtime += r.overtime_hours || 0;
    }

    workerData.push({
      w,
      presentDates,
      hoursWorked,
      overtimeHours,
      leaveHours,
      bySite,
      basePay: hoursWorked * w.wage_rate,
      overtimePay: overtimeHours * w.wage_rate * (w.overtime_multiplier || 1.5),
    });
  }

  for (const wd of workerData) {
    const { w } = wd;
    const itemInfo = insertItem.run({
      runId,
      workerId: w.id,
      vendorId: w.vendor_id,
      daysPresent: wd.presentDates.size,
      leaveHours: wd.leaveHours,
      hoursWorked: wd.hoursWorked,
      overtimeHours: wd.overtimeHours,
      basePay: wd.basePay,
      overtimePay: wd.overtimePay,
    });
    const itemId = itemInfo.lastInsertRowid;

    // Apply any site performance adjustments, scoped to just what this worker
    // earned/worked at that particular site during the overlapping window —
    // a worker split across a cut site and a clean site is only affected on
    // the cut site's share. Every site slice (even one with no adjustments)
    // gets a payroll_item_sites row, so the run can be verified site by site
    // afterward.
    for (const [siteIdStr, slice] of Object.entries(wd.bySite)) {
      const siteId = Number(siteIdStr);
      const sliceBasePay = slice.hours * w.wage_rate;
      const sliceOvertimePay = slice.overtime * w.wage_rate * (w.overtime_multiplier || 1.5);
      const sliceTotal = sliceBasePay + sliceOvertimePay;
      const siteHoursTotal = (siteTotals[siteId] && siteTotals[siteId].hours + siteTotals[siteId].overtime) || 0;
      const workerHoursShare = slice.hours + slice.overtime;
      const adjustments = sitePerformanceAdjustmentsFor(siteId, period_start, period_end);
      let sliceAdjustmentTotal = 0;

      for (const adj of adjustments) {
        if (adj.adjustment_type === 'additional_payment') {
          if (!siteHoursTotal || !adj.flat_amount) continue;
          const amount = Math.round(adj.flat_amount * (workerHoursShare / siteHoursTotal) * -100) / 100; // negative = addition
          if (amount === 0) continue;
          insertDeduction.run(
            itemId,
            `${siteName(siteId)} additional payment (${adj.period_start} to ${adj.period_end})${adj.reason ? ': ' + adj.reason : ''}`,
            amount
          );
          sliceAdjustmentTotal += amount;
        } else {
          if (!adj.cut_percent) continue;
          const sign = adj.adjustment_type === 'bonus' ? -1 : 1;
          const amount = Math.round(sliceTotal * (adj.cut_percent / 100) * sign * 100) / 100;
          if (amount === 0) continue;
          insertDeduction.run(
            itemId,
            `${siteName(siteId)} performance ${adj.adjustment_type} — ${adj.cut_percent}% (${adj.period_start} to ${adj.period_end})${
              adj.reason ? ': ' + adj.reason : ''
            }`,
            amount
          );
          sliceAdjustmentTotal += amount;
        }
      }

      insertItemSite.run({
        itemId,
        siteId,
        hoursWorked: slice.hours,
        overtimeHours: slice.overtime,
        basePay: sliceBasePay,
        overtimePay: sliceOvertimePay,
        adjustmentsTotal: sliceAdjustmentTotal,
        netPay: sliceTotal - sliceAdjustmentTotal,
      });
    }
  }

  return runId;
}

// Per-site breakdown of a payroll run, built from the payroll_item_sites
// snapshot taken at generation time, joined with which sites have already
// been verified for this run. A run generated before this feature exists
// has no payroll_item_sites rows at all — treated as "legacy" and falls
// back to the old whole-run verify button.
function sitesForPayrollRun(runId) {
  const rows = db
    .prepare(
      `SELECT pis.site_id, s.name site_name,
        COUNT(DISTINCT pis.payroll_item_id) worker_count,
        SUM(pis.hours_worked) hours_worked,
        SUM(pis.overtime_hours) overtime_hours,
        SUM(pis.base_pay) base_pay,
        SUM(pis.overtime_pay) overtime_pay,
        SUM(pis.adjustments_total) adjustments_total,
        SUM(pis.net_pay) net_pay
       FROM payroll_item_sites pis
       JOIN payroll_items pi ON pi.id = pis.payroll_item_id
       JOIN sites s ON s.id = pis.site_id
       WHERE pi.payroll_run_id = @runId
       GROUP BY pis.site_id, s.name
       ORDER BY s.name`
    )
    .all({ runId });
  const verifications = db
    .prepare(
      `SELECT prsv.*, u.name verified_by_name FROM payroll_run_site_verifications prsv
       LEFT JOIN users u ON u.id = prsv.verified_by WHERE prsv.payroll_run_id = @runId`
    )
    .all({ runId });
  const verMap = {};
  verifications.forEach((v) => {
    verMap[v.site_id] = v;
  });
  return rows.map((r) => Object.assign({}, r, { verification: verMap[r.site_id] || null }));
}

function payrollItemsWithNet(runId) {
  const items = db
    .prepare(
      `SELECT pi.*, w.name worker_name, v.name vendor_name,
        (SELECT COALESCE(SUM(amount),0) FROM payroll_deductions WHERE payroll_item_id = pi.id) deductions_total
       FROM payroll_items pi
       JOIN workers w ON w.id = pi.worker_id
       LEFT JOIN vendors v ON v.id = pi.vendor_id
       WHERE pi.payroll_run_id = ? ORDER BY v.name, w.name`
    )
    .all(runId);
  return items.map((i) => Object.assign({}, i, { net_pay: i.base_pay + i.overtime_pay - i.deductions_total }));
}

function renderPayrollDetail(runId, user) {
  const run = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(runId);
  if (!run) return null;
  const withNet = payrollItemsWithNet(runId);
  const total = withNet.reduce((sum, i) => sum + i.net_pay, 0);

  const vendorTotals = {};
  withNet.forEach((i) => {
    const key = i.vendor_name || 'Unassigned';
    vendorTotals[key] = (vendorTotals[key] || 0) + i.net_pay;
  });

  const verifiedByName = run.verified_by ? (db.prepare('SELECT name FROM users WHERE id = ?').get(run.verified_by) || {}).name : null;
  const completedByName = run.completed_by ? (db.prepare('SELECT name FROM users WHERE id = ?').get(run.completed_by) || {}).name : null;
  const flaggedByName = run.flagged_by ? (db.prepare('SELECT name FROM users WHERE id = ?').get(run.flagged_by) || {}).name : null;
  const canApprove = user && PAYROLL_APPROVE_ROLES.includes(user.role);
  const canGenerate = user && PAYROLL_GENERATE_ROLES.includes(user.role);
  const sites = sitesForPayrollRun(runId);
  const hasSiteBreakdown = sites.length > 0;
  const allSitesVerified = hasSiteBreakdown && sites.every((s) => s.verification);

  return `
  <h1>Payroll run: ${esc(run.period_start)} → ${esc(run.period_end)}</h1>
  <p class="subtitle">Generated ${esc(run.generated_at)}${run.notes ? ' · ' + esc(run.notes) : ''}</p>
  ${
    run.flagged
      ? `<div class="flash flash-error">Flagged${flaggedByName ? ' by ' + esc(flaggedByName) : ''}${run.flagged_at ? ' at ' + esc(run.flagged_at) : ''}${
          run.flagged_reason ? ': ' + esc(run.flagged_reason) : ''
        } — this run's wage period is free to be regenerated. This run's own data is untouched.</div>`
      : ''
  }
  <div class="card muted" style="margin-bottom:20px">
    <span class="badge ${PAYROLL_STATUS_BADGE[run.status]}">${esc(PAYROLL_STATUS_LABEL[run.status] || run.status)}</span>
    ${run.flagged ? ' <span class="badge inactive">Flagged</span>' : ''}
    ${verifiedByName ? ` · Verified by ${esc(verifiedByName)} at ${esc(run.verified_at)}` : ''}
    ${completedByName ? ` · Completed by ${esc(completedByName)} at ${esc(run.completed_at)}` : ''}
    ${
      canApprove && run.status === 'pending_verification' && !hasSiteBreakdown
        ? `<form class="inline" method="POST" action="/payroll/${run.id}/verify" style="margin-left:10px"><button class="btn secondary small" type="submit">Mark verified</button></form>`
        : ''
    }
    ${
      canApprove && run.status === 'verified'
        ? `<form class="inline" method="POST" action="/payroll/${run.id}/complete" style="margin-left:10px" onsubmit="return confirm('Mark this payroll run as completed (paid out)?')"><button class="btn small" type="submit">Mark completed</button></form>`
        : ''
    }
    ${
      canGenerate && !run.flagged
        ? `<form class="inline" method="POST" action="/payroll/${run.id}/flag" style="margin-left:10px" onsubmit="return confirm('Flag this run so its wage period can be regenerated? This does not delete or change any of its data.')"><button class="btn secondary small" type="submit">Flag</button></form>`
        : ''
    }
  </div>
  <div class="grid grid-3" style="margin-bottom:20px">
    <div class="stat"><div class="stat-label">Workers paid</div><div class="stat-value">${withNet.length}</div></div>
    <div class="stat"><div class="stat-label">Net payout</div><div class="stat-value">${fmtMoney(total)}</div></div>
    <div class="stat"><div class="stat-label">Avg per worker</div><div class="stat-value">${fmtMoney(withNet.length ? total / withNet.length : 0)}</div></div>
  </div>
  <div class="actions" style="margin-top:0;margin-bottom:20px"><a href="/payroll/${runId}/export.csv" class="btn secondary small">⬇ Export CSV</a></div>

  ${
    hasSiteBreakdown
      ? `<h2>Verification by site</h2>
  <p class="hint" style="margin-top:-6px">Each site's slice of this run is verified independently. The run only moves to <b>Verified</b> once every site below is verified${
          canApprove ? '' : ' (Labor Manager / Admin can flag a run for regeneration; Audit Manager / Admin verify each site)'
        }.</p>
  <div class="table-wrap"><table>
    <tr><th>Site</th><th>Workers</th><th>Hours</th><th>OT hrs</th><th>Net pay</th><th>Status</th><th></th></tr>
    ${sites
      .map(
        (s) => `<tr>
        <td>${esc(s.site_name)}</td>
        <td>${s.worker_count}</td>
        <td>${s.hours_worked}</td>
        <td>${s.overtime_hours}</td>
        <td>${fmtMoney(s.net_pay)}</td>
        <td>${
          s.verification
            ? `<span class="badge active">Verified</span> ${esc(s.verification.verified_by_name || '')} · ${esc(s.verification.verified_at)}`
            : '<span class="badge half_day">Pending</span>'
        }</td>
        <td>${
          canApprove && !s.verification && run.status === 'pending_verification'
            ? `<form class="inline" method="POST" action="/payroll/${run.id}/sites/${s.site_id}/verify"><button class="btn secondary small" type="submit">Verify</button></form>`
            : ''
        }</td>
      </tr>`
      )
      .join('')}
  </table></div>
  ${
    canApprove && !allSitesVerified && run.status === 'pending_verification'
      ? `<p class="hint">Complete becomes available once every site above is verified.</p>`
      : ''
  }`
      : ''
  }

  <h2>Payments by vendor</h2>
  <div class="table-wrap"><table>
    <tr><th>Vendor</th><th>Net payable</th></tr>
    ${Object.entries(vendorTotals)
      .map(([name, amt]) => `<tr><td>${esc(name)}</td><td><b>${fmtMoney(amt)}</b></td></tr>`)
      .join('')}
  </table></div>

  <h2>Per-worker breakdown</h2>
  <div class="table-wrap"><table>
    <tr><th>Worker</th><th>Vendor</th><th>Days</th><th>Hours</th><th>OT hrs</th><th>Leave hrs</th><th>Base</th><th>OT pay</th><th>Deductions</th><th>Net</th><th></th></tr>
    ${withNet
      .map(
        (i) => `<tr>
        <td>${esc(i.worker_name)}</td><td>${esc(i.vendor_name || '—')}</td>
        <td>${i.days_present}</td><td>${i.hours_worked}</td><td>${i.overtime_hours}</td><td>${i.leave_hours}</td>
        <td>${fmtMoney(i.base_pay)}</td><td>${fmtMoney(i.overtime_pay)}</td>
        <td>${fmtMoney(i.deductions_total)}</td><td><b>${fmtMoney(i.net_pay)}</b></td>
        <td><a href="/payroll/items/${i.id}">Details</a></td>
      </tr>`
      )
      .join('')}
  </table></div>
  <p style="margin-top:16px"><a href="/payroll">← Back to payroll runs</a></p>
  `;
}

function renderPayrollItemDetail(itemId, viewer) {
  const item = db
    .prepare(
      `SELECT pi.*, w.name worker_name, v.name vendor_name, pr.id run_id, pr.period_start, pr.period_end
       FROM payroll_items pi JOIN workers w ON w.id = pi.worker_id
       LEFT JOIN vendors v ON v.id = pi.vendor_id
       JOIN payroll_runs pr ON pr.id = pi.payroll_run_id
       WHERE pi.id = ?`
    )
    .get(itemId);
  if (!item) return null;
  const deductions = db.prepare('SELECT * FROM payroll_deductions WHERE payroll_item_id = ? ORDER BY id').all(itemId);
  const deductionsTotal = deductions.reduce((s, d) => s + d.amount, 0);
  const net = item.base_pay + item.overtime_pay - deductionsTotal;

  return `
  <h1>${esc(item.worker_name)} — ${esc(item.period_start)} → ${esc(item.period_end)}</h1>
  <p class="subtitle">Vendor: ${esc(item.vendor_name || '—')}</p>
  <div class="grid grid-3" style="margin-bottom:20px">
    <div class="stat"><div class="stat-label">Base pay</div><div class="stat-value">${fmtMoney(item.base_pay)}</div></div>
    <div class="stat"><div class="stat-label">Overtime pay</div><div class="stat-value">${fmtMoney(item.overtime_pay)}</div></div>
    <div class="stat"><div class="stat-label">Net pay</div><div class="stat-value">${fmtMoney(net)}</div></div>
  </div>
  ${net < 0 ? `<div class="flash flash-error">Deductions exceed earnings — net pay is negative. Review before paying out.</div>` : ''}
  <h2>Deductions &amp; additions</h2>
  <p class="hint" style="margin-top:-6px">A negative amount is an addition (bonus, additional payment, or a refunded cut) — it increases net pay.</p>
  <div class="table-wrap"><table>
    <tr><th>Reason</th><th>Type</th><th>Amount</th></tr>
    ${deductions
      .map(
        (d) =>
          `<tr><td>${esc(d.reason)}</td><td>${d.amount < 0 ? '<span class="badge active">Addition</span>' : '<span class="badge inactive">Deduction</span>'}</td><td>${fmtMoney(Math.abs(d.amount))}</td></tr>`
      )
      .join('')}
    ${deductions.length === 0 ? '<tr><td colspan="3" class="muted">No deductions or additions yet.</td></tr>' : ''}
  </table></div>
  ${
    viewer && can(viewer, 'payroll.generate')
      ? `<div class="card">
    <form method="POST" action="/payroll/items/${item.id}/deductions">
      <div class="form-row">
        <div><label>Reason</label><input name="reason" required placeholder="e.g. Advance repayment"></div>
        <div><label>Amount (₹)</label><input name="amount" type="number" step="0.01" required></div>
      </div>
      <button class="btn secondary" type="submit">Add deduction</button>
    </form>
  </div>`
      : ''
  }
  <p><a href="/payroll/${item.run_id}">← Back to payroll run</a></p>
  `;
}

// ---------- Sites ----------
function renderSites() {
  const sites = db
    .prepare(`SELECT s.*, (SELECT COUNT(*) FROM workers w WHERE w.site_id = s.id) worker_count FROM sites s ORDER BY s.id`)
    .all();
  return `
  <h1>Sites</h1>
  <p class="subtitle">Site numbers run 100–999. Site 100 is the built-in Unassigned Pool that new workers land in by default.</p>
  <div class="card">
    <form method="POST" action="/sites">
      <div class="form-row">
        <div><label>Site name</label><input name="name" required></div>
        <div><label>Location</label><input name="location"></div>
      </div>
      <div class="form-row">
        <div><label>Address (optional)</label><input name="address" placeholder="e.g. Plot 12, MG Road"></div>
        <div><label>District (optional)</label><input name="district"></div>
      </div>
      <div class="form-row">
        <div><label>State (optional)</label><input name="state"></div>
        <div><label>Google Maps link (optional)</label><input name="maps_link" type="url" placeholder="https://maps.google.com/..."></div>
      </div>
      <button class="btn" type="submit">Add site</button>
    </form>
  </div>
  <div class="table-wrap"><table>
    <tr><th>#</th><th>Name</th><th>Location</th><th>District/State</th><th>Status</th><th>Workers</th><th></th></tr>
    ${sites
      .map((s) => {
        const districtState = [s.district, s.state].filter(Boolean).join(', ');
        return `<tr>
        <td>${s.id}</td><td>${esc(s.name)}${s.id === POOL_SITE_ID ? ' <span class="badge inactive">Pool</span>' : ''}</td><td>${esc(
          s.location || '—'
        )}</td>
        <td>${esc(districtState || '—')}</td>
        <td><span class="badge ${SITE_STATUS_BADGE[s.status]}">${SITE_STATUS_LABEL[s.status]}</span></td>
        <td>${s.worker_count}</td>
        <td>
          <a href="/sites/${s.id}/edit">Edit</a>
        </td>
      </tr>`;
      })
      .join('')}
    ${sites.length === 0 ? '<tr><td colspan="7" class="muted">No sites yet.</td></tr>' : ''}
  </table></div>
  <p class="hint">Sites are never permanently deleted — mark one Completed (its Edit page) when work wraps up there. Completed sites stay fully visible here and their attendance history remains searchable by date range in <a href="/attendance/history">Attendance History</a>; reassign a site's active workers to another site first if it still has any.</p>
  `;
}

function renderSiteForm(site) {
  const deps = siteDependencyCounts(site.id);
  const currentWorkers = db.prepare(`SELECT id, name, status FROM workers WHERE site_id = ? ORDER BY name`).all(site.id);
  const activeWorkers = currentWorkers.filter((w) => w.status === 'active');

  return `
  <h1>Edit site</h1>
  <div class="card">
  <form method="POST" action="/sites/${site.id}">
    <div class="form-row">
      <div><label>Site name</label><input name="name" required value="${esc(site.name)}"></div>
      <div><label>Location</label><input name="location" value="${esc(site.location)}"></div>
    </div>
    <div class="form-row">
      <div><label>Address (optional)</label><input name="address" value="${esc(site.address)}"></div>
      <div><label>District (optional)</label><input name="district" value="${esc(site.district)}"></div>
    </div>
    <div class="form-row">
      <div><label>State (optional)</label><input name="state" value="${esc(site.state)}"></div>
      <div><label>Google Maps link (optional)</label><input name="maps_link" type="url" value="${esc(site.maps_link)}"></div>
    </div>
    ${site.maps_link ? `<p class="hint" style="margin-top:-6px"><a href="${esc(site.maps_link)}" target="_blank" rel="noopener">Open in Google Maps →</a></p>` : ''}
    <label>Status</label>
    <select name="status">
      ${Object.entries(SITE_STATUS_LABEL)
        .map(([val, label]) => `<option value="${val}" ${val === site.status ? 'selected' : ''}>${label}</option>`)
        .join('')}
    </select>
    ${
      site.id === POOL_SITE_ID
        ? '<p class="hint">This is the built-in Unassigned Pool. It can be renamed but should generally stay Active since new workers land here automatically.</p>'
        : '<p class="hint">Mark a site Completed when work wraps up there — that\'s the safe way to retire a site without losing its worker/attendance history. Deleting is only possible for a site with nothing attached to it yet.</p>'
    }
    <div class="actions">
      <button class="btn" type="submit">Save</button>
      <a href="/sites" class="btn secondary">Cancel</a>
    </div>
  </form>
  </div>

  <h2>Workers at this site</h2>
  <p class="subtitle">${deps.workers} total (${activeWorkers.length} active) · ${deps.attendance} attendance record(s) reference this site${
    deps.users ? ` · ${deps.users} user account(s) assigned here` : ''
  }</p>
  ${
    activeWorkers.length === 0
      ? '<div class="card muted">No active workers are stationed here right now.</div>'
      : `
  <div class="card">
    <h2 class="mt-0" style="margin-top:0">Move all workers to another site</h2>
    <form method="POST" action="/sites/${site.id}/reassign-workers">
      <label>Move all ${activeWorkers.length} active worker(s) to</label>
      <select name="target_site_id" required><option value="">Select site…</option>${siteOptions(null, { excludeId: site.id })}</select>
      <button class="btn secondary" type="submit">Reassign all workers</button>
    </form>
  </div>`
  }
  `;
}

// ---------- Site performance (wage cuts) ----------
const ADJUSTMENT_TYPE_LABEL = { cut: 'Wage cut', bonus: 'Bonus', additional_payment: 'Additional payment' };
const ADJUSTMENT_TYPE_BADGE = { cut: 'inactive', bonus: 'active', additional_payment: 'half_day' };

function renderSitePerformance(opts) {
  const errorHtml = opts && opts.error ? `<div class="flash flash-error">${esc(opts.error)}</div>` : '';
  // Six oversight roles can VIEW this page, but only Admin/Labor Manager can
  // log/edit/remove adjustments — everyone else gets a read-only ledger with
  // no form and no action buttons (nothing on screen the server would 403).
  const canManage = !!(opts && opts.user && can(opts.user, 'siteperf.manage'));
  const editingRow = opts && opts.editingId && canManage
    ? db.prepare('SELECT sp.*, s.name site_name FROM site_performance sp JOIN sites s ON s.id = sp.site_id WHERE sp.id = ?').get(opts.editingId)
    : null;
  const v0 = (opts && opts.values) || editingRow || {};
  const period = currentPayPeriod();
  const adjustments = db
    .prepare(
      `SELECT sp.*, s.name site_name, u.name created_by_name
       FROM site_performance sp
       JOIN sites s ON s.id = sp.site_id
       LEFT JOIN users u ON u.id = sp.created_by
       ORDER BY sp.period_start DESC, sp.id DESC`
    )
    .all();

  return `
  <h1>Site performance</h1>
  <p class="subtitle">Log a wage cut, a bonus, or a flat additional payment for a site over a fixed Thursday → Wednesday pay period. When payroll is generated for an overlapping period, every worker who logged hours at that site during the overlap automatically gets an itemized line for their share — a cut/bonus is a percentage of what they earned there, an additional payment is a flat amount split by hours worked. All are visible and further editable on the worker's payroll item afterward.</p>
  ${errorHtml}
  ${
    canManage
      ? `<div class="card">
    <form method="POST" action="${editingRow ? `/site-performance/${editingRow.id}` : '/site-performance'}" id="site-perf-form">
      ${editingRow ? `<p class="hint" style="margin-top:0">Editing the adjustment logged for <b>${esc(v0.site_name || '')}</b>. <a href="/site-performance">Cancel edit →</a></p>` : ''}
      <div class="form-row">
        <div><label>Site</label><select name="site_id" required><option value="">Select site…</option>${siteOptions(v0.site_id)}</select></div>
        <div><label>Type</label>
          <select name="adjustment_type" id="adj-type" onchange="document.getElementById('cut-percent-field').style.display = this.value==='additional_payment' ? 'none' : ''; document.getElementById('flat-amount-field').style.display = this.value==='additional_payment' ? '' : 'none';">
            ${Object.entries(ADJUSTMENT_TYPE_LABEL)
              .map(([val, label]) => `<option value="${val}" ${val === (v0.adjustment_type || 'cut') ? 'selected' : ''}>${label}</option>`)
              .join('')}
          </select>
        </div>
      </div>
      <div class="form-row">
        <div id="cut-percent-field" style="${v0.adjustment_type === 'additional_payment' ? 'display:none' : ''}">
          <label>Percent (cut or bonus)</label><input name="cut_percent" type="number" step="0.1" min="0.1" max="100" placeholder="e.g. 10" value="${esc(v0.cut_percent)}">
        </div>
        <div id="flat-amount-field" style="${v0.adjustment_type === 'additional_payment' ? '' : 'display:none'}">
          <label>Flat amount (₹, additional payment only)</label><input name="flat_amount" type="number" step="0.01" min="0.01" placeholder="e.g. 5000" value="${esc(v0.flat_amount)}">
        </div>
      </div>
      <div class="form-row">
        <div><label>Period start</label><input id="sp_period_start" name="period_start" type="date" required value="${v0.period_start || period.start}"></div>
        <div><label>Period end (auto)</label><input id="sp_period_end" name="period_end" type="date" required value="${v0.period_end || period.end}" readonly></div>
      </div>
      <p class="hint" style="margin-top:-6px">Pay periods are fixed Thursday → Wednesday weeks, matching payroll. Pick any day and the period snaps to that week automatically.</p>
      <label>Reason (optional)</label><input name="reason" placeholder="e.g. Missed weekly targets / Excellent quality this week / Refund of a mistaken cut" value="${esc(v0.reason)}">
      <button class="btn" type="submit">${editingRow ? 'Update adjustment' : 'Log adjustment'}</button>
    </form>
  </div>
  ${payPeriodSnapScript('sp_period_start', 'sp_period_end')}`
      : `<p class="hint">You have view access to this ledger. Adjustments are logged and edited by the Labor Manager (or an Admin).</p>`
  }
  <div class="table-wrap"><table>
    <tr><th>Site</th><th>Period</th><th>Type</th><th>Amount</th><th>Reason</th><th>Logged by</th>${canManage ? '<th></th>' : ''}</tr>
    ${adjustments
      .map(
        (c) => `<tr>
        <td>${esc(c.site_name)}</td>
        <td>${esc(c.period_start)} → ${esc(c.period_end)}</td>
        <td><span class="badge ${ADJUSTMENT_TYPE_BADGE[c.adjustment_type]}">${ADJUSTMENT_TYPE_LABEL[c.adjustment_type]}</span></td>
        <td><b>${c.adjustment_type === 'additional_payment' ? fmtMoney(c.flat_amount) : (c.cut_percent || 0) + '%'}</b></td>
        <td>${esc(c.reason || '—')}</td>
        <td>${esc(c.created_by_name || '—')}</td>
        ${
          canManage
            ? `<td>
          <a href="/site-performance?edit=${c.id}">Edit</a>
          · <form class="inline" method="POST" action="/site-performance/${c.id}/delete" onsubmit="return confirm('Remove this adjustment? It will no longer apply to payroll runs generated after this. Amounts already added to past payroll items are not affected.')"><button class="btn danger small" type="submit">Remove</button></form>
        </td>`
            : ''
        }
      </tr>`
      )
      .join('')}
    ${adjustments.length === 0 ? `<tr><td colspan="${canManage ? 7 : 6}" class="muted">No adjustments logged yet.</td></tr>` : ''}
  </table></div>
  `;
}

// ---------- Users ----------
// v10: an Admin actor must never even see 'super_admin' as a selectable
// option — hiding it here is the UI half of the superAdminGuardError()
// server-side check; the server-side check is what actually matters for
// security, but keeping the dropdown filtered means an Admin never sees a
// choice the server would reject anyway. If the field currently holds
// 'super_admin' (rendering the existing Super Admin's own row) and the
// actor isn't a super_admin, the option is still shown-but-disabled so the
// select doesn't silently drop the current value out from under them.
function roleSelectOptions(selected, actingUser) {
  const actorIsSuperAdmin = actingUser && actingUser.role === 'super_admin';
  return ALL_ROLES.map((r) => {
    if (r === 'super_admin' && !actorIsSuperAdmin) {
      if (r !== selected) return '';
      return `<option value="${r}" selected disabled>${ROLE_LABEL[r]}</option>`;
    }
    return `<option value="${r}" ${r === selected ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`;
  }).join('');
}

function renderUsers(opts) {
  const errorHtml = opts && opts.error ? `<div class="flash flash-error">${esc(opts.error)}</div>` : '';
  const v0 = (opts && opts.values) || {};
  const page = (opts && opts.page) || 1;
  const actingUser = opts && opts.actingUser;
  const actorIsSuperAdmin = actingUser && actingUser.role === 'super_admin';
  const totalCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const users = db
    .prepare(`SELECT u.*, s.name site_name FROM users u LEFT JOIN sites s ON s.id = u.site_id ORDER BY u.name LIMIT ? OFFSET ?`)
    .all(PAGE_SIZE, (page - 1) * PAGE_SIZE);
  // For PM/SEs the single site_id column is meaningless — their real scope
  // lives in user_site_assignments. Surface it right here in the Site column
  // (with a link to change it) so an admin can see at a glance that an
  // assignment took, without hunting through another tab.
  const multiSiteAssignments = {};
  db.prepare('SELECT user_id, site_id FROM user_site_assignments ORDER BY site_id').all().forEach((r) => {
    (multiSiteAssignments[r.user_id] = multiSiteAssignments[r.user_id] || []).push(r.site_id);
  });
  const siteCellFor = (u) => {
    if (MULTI_SITE_ROLES.includes(u.role)) {
      const ids = multiSiteAssignments[u.id] || [];
      return ids.length
        ? `${ids.join(', ')} <a href="/site-assignments" class="muted" title="Change on the Site assignments tab">✎</a>`
        : `<a href="/site-assignments">assign sites →</a>`;
    }
    return esc(u.site_name || '—');
  };
  return `
  <h1>Users</h1>
  <p class="subtitle">Username is always the person's email address. Project Managers and Site Engineers get <a href="/site-assignments">multiple sites on a separate tab →</a> Delete permanently removes an account, but is refused if they have any attendance, payroll, or audit history — deactivate those instead.</p>
  ${errorHtml}
  <div class="card">
    <form method="POST" action="/users">
      <div class="form-row">
        <div><label>Full name</label><input name="name" required value="${esc(v0.name)}"></div>
        <div><label>Username (email address)</label><input name="username" type="email" required placeholder="name@bilaragroup.example" value="${esc(v0.username)}"></div>
      </div>
      <div class="form-row">
        <div><label>Phone number</label><input name="contact" required placeholder="10+ digits" value="${esc(v0.contact)}"></div>
        <div><label>Password</label><input name="password" type="password" required minlength="8" placeholder="8+ characters"></div>
      </div>
      <div class="form-row">
        <div><label>Role</label>
          <select name="role" id="new-user-role">
            ${roleSelectOptions(v0.role || 'hr', actingUser)}
          </select>
        </div>
        <div>
          <label><input type="checkbox" name="must_change_password" value="1" checked> Require password change on first login</label>
        </div>
      </div>
      <button class="btn" type="submit">Add user</button>
    </form>
  </div>
  <div class="table-wrap"><table>
    <tr><th>Name</th><th>Username</th><th>Phone</th><th>Role</th><th>Site</th><th>Status</th><th></th></tr>
    ${users
      .map((u) => {
        const targetIsSuperAdmin = u.role === 'super_admin';
        const actorMayManage = actorIsSuperAdmin || !targetIsSuperAdmin;
        const contactIsPlaceholder = u.contact === PLACEHOLDER_CONTACT;
        return `<tr>
        <td>${esc(u.name)}</td><td>${esc(u.username)}</td><td>${esc(u.contact || '—')}${
          contactIsPlaceholder
            ? ` <span class="badge inactive" title="This is a placeholder number set during the v10 migration — update it with their real contact number.">needs real number</span>`
            : ''
        }</td><td>${esc(ROLE_LABEL[u.role] || u.role)}</td>
        <td>${siteCellFor(u)}</td>
        <td><span class="badge ${u.active ? 'active' : 'inactive'}">${u.active ? 'active' : 'disabled'}</span></td>
        <td>
          ${
            actorMayManage
              ? `<a href="/users/${u.id}/edit">Edit</a>
          · <form class="inline" method="POST" action="/users/${u.id}/toggle"><button class="btn secondary small" type="submit">${
                  u.active ? 'Disable' : 'Enable'
                }</button></form>
          · <form class="inline" method="POST" action="/users/${u.id}/delete" onsubmit="return confirm('Permanently delete ${esc(
                  u.name
                ).replace(/'/g, "\\'")}? This cannot be undone. If they have any attendance, payroll, or audit history, this will be refused automatically — deactivate them instead in that case.')"><button class="btn secondary small" type="submit">Delete</button></form>`
              : `<span class="muted" title="Only a Super Admin can manage a Super Admin account.">—</span>`
          }
        </td>
      </tr>`;
      })
      .join('')}
  </table></div>
  ${paginationControls('/users', page, totalCount, PAGE_SIZE)}
  `;
}

function renderUserForm(user, opts) {
  const u = Object.assign({}, user, (opts && opts.values) || {});
  const errorHtml = opts && opts.error ? `<div class="flash flash-error">${esc(opts.error)}</div>` : '';
  const actingUser = opts && opts.actingUser;
  return `
  <h1>Edit user</h1>
  ${errorHtml}
  <div class="card">
  <form method="POST" action="/users/${user.id}">
    <div class="form-row">
      <div><label>Full name</label><input name="name" required value="${esc(u.name)}"></div>
      <div><label>Username (email address)</label><input name="username" type="email" required value="${esc(u.username)}"></div>
    </div>
    <div class="form-row">
      <div><label>Phone number</label><input name="contact" required placeholder="10+ digits" value="${esc(u.contact)}"></div>
      <div><label>New password (leave blank to keep current)</label><input name="password" type="password" minlength="8" placeholder="8+ characters if changing"></div>
    </div>
    <div class="form-row">
      <div><label>Role</label>
        <select name="role" id="edit-user-role">
          ${roleSelectOptions(u.role, actingUser)}
        </select>
      </div>
      <div>
        <label><input type="checkbox" name="must_change_password" value="1" ${u.must_change_password ? 'checked' : ''}> Require password change on next login</label>
        <p class="hint">Automatically applied whenever a new password is set below; otherwise updates the account's current flag.</p>
      </div>
    </div>
    ${
      MULTI_SITE_ROLES.includes(user.role)
        ? `<p class="hint">This is a Project Manager / Site Engineer role — assign their sites from <a href="/site-assignments">Site assignments →</a> (that role can be assigned to more than one site).</p>`
        : ''
    }
    <div class="actions">
      <button class="btn" type="submit">Save</button>
      <a href="/users" class="btn secondary">Cancel</a>
    </div>
  </form>
  </div>
  `;
}

// v10: shown to any account with must_change_password set — a brand-new
// login or one whose password was just reset with the checkbox left on.
// Requires the (temporary) current password rather than trusting the
// session alone, since a shared/handed-off temp password is exactly the
// case this form exists to close out.
function renderChangePasswordForm(opts) {
  const errorHtml = opts && opts.error ? `<div class="flash flash-error">${esc(opts.error)}</div>` : '';
  return `
  <div class="login-wrap">
    <div class="card">
      <h1>Set a new password</h1>
      <p class="subtitle">For security, you must set your own password before continuing.</p>
      ${errorHtml}
      <form method="POST" action="/account/change-password">
        <label>Current (temporary) password</label><input name="current_password" type="password" required autofocus>
        <label>New password</label><input name="new_password" type="password" required minlength="8" placeholder="8+ characters">
        <label>Confirm new password</label><input name="confirm_password" type="password" required minlength="8">
        <button class="btn" type="submit" style="width:100%">Set password</button>
      </form>
      <form method="POST" action="/logout" class="inline"><button class="btn secondary small" type="submit" style="margin-top:12px">Log out instead</button></form>
    </div>
  </div>
  `;
}

const AUDIT_ACTION_LABEL = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  disable_user: 'Disabled',
  enable_user: 'Enabled',
  generate: 'Generated',
  flag: 'Flagged',
  verify: 'Verified',
  verify_site: 'Verified site',
  complete: 'Completed',
};
const AUDIT_ENTITY_LABEL = {
  worker: 'Worker',
  vendor: 'Vendor',
  user: 'User',
  site: 'Site',
  site_performance: 'Site adjustment',
  site_off_day: 'Site-off day',
  payroll_run: 'Payroll run',
};

// Admin-only trail of significant mutations across the app (see logAudit()).
// Read-only, paginated — this can grow indefinitely so it's the one list in
// the app that always paginates, no matter the row count.
function renderAuditLog(query) {
  const page = pageFromQuery(query);
  const totalCount = db.prepare('SELECT COUNT(*) c FROM audit_log').get().c;
  const rows = db
    .prepare(
      `SELECT al.*, u.name user_name FROM audit_log al LEFT JOIN users u ON u.id = al.user_id
       ORDER BY al.id DESC LIMIT ? OFFSET ?`
    )
    .all(PAGE_SIZE, (page - 1) * PAGE_SIZE);
  return `
  <h1>Audit log</h1>
  <p class="subtitle">Who did what, and when — covers worker/vendor/site/user changes, payroll actions, and site-performance/site-off entries.</p>
  <div class="table-wrap"><table>
    <tr><th>When</th><th>Who</th><th>Action</th><th>On</th><th>Details</th></tr>
    ${rows
      .map(
        (r) => `<tr>
        <td class="muted">${esc(r.created_at)}</td>
        <td>${esc(r.user_name || '—')}</td>
        <td>${esc(AUDIT_ACTION_LABEL[r.action] || r.action)}</td>
        <td>${esc(AUDIT_ENTITY_LABEL[r.entity_type] || r.entity_type)}${r.entity_id ? ' #' + r.entity_id : ''}</td>
        <td class="muted">${esc(r.details || '—')}</td>
      </tr>`
      )
      .join('')}
    ${rows.length === 0 ? '<tr><td colspan="5" class="muted">No audit entries yet.</td></tr>' : ''}
  </table></div>
  ${paginationControls('/audit-log', page, totalCount, PAGE_SIZE)}
  `;
}

// ---------- Site assignments (Project Managers / Site Engineers) ----------
function renderSiteAssignments(opts) {
  const people = db
    .prepare(`SELECT * FROM users WHERE role IN ('project_manager','site_engineer') ORDER BY role, name`)
    .all();
  const sites = db.prepare('SELECT * FROM sites ORDER BY id').all();
  const assignedMap = {}; // user_id -> Set(site_id)
  db.prepare('SELECT user_id, site_id FROM user_site_assignments').all().forEach((r) => {
    if (!assignedMap[r.user_id]) assignedMap[r.user_id] = new Set();
    assignedMap[r.user_id].add(r.site_id);
  });

  // v9: the whole page is ONE form with a single save. The old version had a
  // separate form + Save button per person — checking boxes on two people's
  // cards and clicking one card's Save silently threw away the other card's
  // changes on reload, and a successful save gave no feedback at all. Both
  // read as "my assignments weren't saved" (reported by Zen). Now every
  // change on the page saves together, a flash confirms exactly what was
  // saved, and a card you've touched is visibly marked until you save.
  const savedFlash = opts && opts.savedSummary ? `<div class="flash flash-success">Saved. ${esc(opts.savedSummary)}</div>` : '';

  return `
  <h1>Site assignments</h1>
  <p class="subtitle">Project Managers and Site Engineers can be assigned to as many sites as needed (a Project Manager might oversee ten-plus; a Site Engineer one to three) — this is separate from a Supervisor's single site, set on the <a href="/users">Users</a> page. They get read-only oversight (dashboards/reports) for every site checked below; they can't mark attendance.</p>
  ${savedFlash}
  ${
    people.length === 0
      ? `<div class="card muted">No Project Manager or Site Engineer accounts yet — create one from <a href="/users">Users</a> first.</div>`
      : `
  <form method="POST" action="/site-assignments" id="site-assignments-form">
    ${people
      .map((p) => {
        const assigned = assignedMap[p.id] || new Set();
        return `
    <div class="card assignment-card" data-user="${p.id}">
      <h2 class="mt-0" style="margin-top:0">${esc(p.name)} <span class="muted" style="font-weight:400">· ${esc(ROLE_LABEL[p.role])} · <span class="assign-count" data-count-for="${p.id}">${assigned.size}</span> site(s)</span> <span class="badge half_day" data-dirty-for="${p.id}" style="display:none">unsaved changes</span></h2>
      <div class="grid grid-4">
        ${sites
          .map(
            (s) =>
              `<label style="text-transform:none;font-weight:400;display:flex;align-items:center;gap:6px"><input type="checkbox" name="u${p.id}_site_${s.id}" data-user-box="${p.id}" style="width:auto;margin:0" ${
                assigned.has(s.id) ? 'checked' : ''
              }> ${s.id === POOL_SITE_ID ? 'Pool' : esc(s.name)}</label>`
          )
          .join('')}
      </div>
    </div>`;
      })
      .join('')}
    <div class="actions" style="position:sticky;bottom:12px">
      <button class="btn" type="submit">Save all assignments</button>
    </div>
  </form>
  <script>
  (function () {
    // Mark a person's card the moment one of their checkboxes changes, and
    // keep the live site-count current, so it's always obvious what will be
    // saved and that saving is still pending.
    document.querySelectorAll('#site-assignments-form input[type=checkbox]').forEach(function (box) {
      box.addEventListener('change', function () {
        var uid = box.getAttribute('data-user-box');
        var badge = document.querySelector('[data-dirty-for="' + uid + '"]');
        if (badge) badge.style.display = '';
        var count = document.querySelectorAll('input[data-user-box="' + uid + '"]:checked').length;
        var counter = document.querySelector('[data-count-for="' + uid + '"]');
        if (counter) counter.textContent = count;
      });
    });
  })();
  </script>`
  }
  `;
}

// ---------- Router ----------
async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams.entries());

  if (req.method === 'GET' && (pathname === '/style.css' || pathname.startsWith('/assets/'))) {
    if (serveStatic(req, res, pathname)) return;
  }

  const cookies = parseCookies(req);
  const user = auth.getUserFromToken(cookies.session);
  const theme = cookies.theme === 'dark' ? 'dark' : 'light';

  // ---------- CSRF identity ----------
  // A logged-in request is identified by its session token — already
  // random, already secret, already bound to exactly one browser. The one
  // state-changing route reachable before login (POST /login) has no
  // session yet, so it gets its own lightweight anonymous identity instead:
  // a random id in its own cookie, set here (once) the first time any
  // request arrives without one. This is unrelated to authentication — it
  // exists purely so the login form has *something* stable to derive a
  // token from — so it's fine for it to be set on every visitor, logged in
  // or not, well before the login form is ever rendered.
  let anonId = cookies[csrf.ANON_COOKIE];
  if (!anonId) {
    anonId = crypto.randomBytes(16).toString('hex');
    // HttpOnly (never needed by JS — only the server reads it), SameSite=Lax
    // and scoped Path=/ to match every other cookie this app sets. A day is
    // generous for "time between opening the login page and submitting it"
    // while not lingering indefinitely for a visitor who never logs in.
    res.setHeader('Set-Cookie', `${csrf.ANON_COOKIE}=${anonId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${COOKIE_SECURE}`);
  }
  const csrfIdentity = cookies.session || anonId;

  // Per-request wrapper closing over this request's theme and CSRF token —
  // a closure over local consts, not module-level variables, so neither can
  // ever race with another concurrent request the way a shared "current
  // theme" global would (see the render.js import comment above). Every
  // existing `layout({...})` call site in this file keeps working unchanged,
  // now also carrying a correct per-request csrfToken automatically.
  const layout = (opts) => renderLayout({ ...opts, theme, csrfToken: csrf.csrfToken(csrfIdentity) });

  // ---------- CSRF verification ----------
  // Every mutation this app performs arrives as a POST (there are no
  // PUT/PATCH/DELETE routes at all — see architecture notes), so checking
  // once, here, for every POST covers all of them from a single place
  // instead of relying on ~40 individual handlers to each remember to check
  // — the same "single source of truth" reasoning permissions.js uses for
  // authorization. This runs before ANY route below, including /login, and
  // strictly before this request's body is handed to route-specific logic,
  // so a rejected request can never reach a database mutation.
  //
  // The body can only be read once (it's a stream), so it's parsed exactly
  // here for every POST; route handlers below reference `reqBody` instead of
  // calling parseFormBody(req) again.
  let reqBody = null;
  if (req.method === 'POST') {
    try {
      reqBody = await parseFormBody(req);
    } catch (e) {
      // A malformed/oversized body (readBody's own 5MB guard, or a broken
      // client) must fail the same way a bad token does — never fall through
      // to a route handler with reqBody left null.
      return send(res, 400, layout({ title: 'Bad request', user, currentPath: pathname, body: `<div class="card"><h1>Bad request</h1><p class="muted">That request couldn't be read. Go back and try again.</p></div>` }));
    }
    if (!csrf.verifyCsrf(csrfIdentity, reqBody._csrf)) {
      logAudit(user ? user.id : null, 'csrf_reject', 'request', null, `blocked POST ${pathname}`);
      return send(
        res,
        403,
        layout({
          title: 'Request blocked',
          user,
          currentPath: pathname,
          flash: { type: 'error', message: "This page was open too long, or something about the request didn't check out. Please go back, refresh, and try again." },
          body: `<div class="card"><h1>Request blocked</h1><p class="muted">Go back and retry the action — a fresh copy of the page will carry a valid token.</p></div>`,
        })
      );
    }
  }

  if (pathname === '/theme/toggle' && req.method === 'GET') {
    const next = query.theme === 'dark' ? 'dark' : 'light';
    // Only ever redirect back within this app — a leading "/" but not "//"
    // (which browsers treat as protocol-relative, i.e. off-site) keeps this
    // open-redirect-safe even though the route itself needs no login.
    // Excluded from CSRF checks on purpose: it only ever flips a display
    // preference cookie, never touches application data, and is a plain
    // GET link (not a form) — see the architecture doc for the full
    // reasoning shared with the /logout GET exclusion below.
    const safeReturn = query.return && query.return.startsWith('/') && !query.return.startsWith('//') ? query.return : '/';
    return redirect(res, safeReturn, `theme=${next}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax${COOKIE_SECURE}`);
  }

  // GET /logout is intentionally a no-op redirect, not a session deletion —
  // logging out is a real state change (it deletes the session row) and
  // belongs behind the same CSRF check as every other mutation, which only
  // ever runs for POST. A bookmarked or previously-shared GET /logout link
  // still goes somewhere sensible instead of 404ing.
  if (pathname === '/logout' && req.method === 'GET') {
    return redirect(res, '/');
  }

  if (pathname === '/login' && req.method === 'GET') {
    if (user) return redirect(res, '/');
    return send(
      res,
      200,
      layout({
        title: 'Login',
        user: null,
        currentPath: pathname,
        body: `
        <div class="login-wrap">
          <div class="card">
            <div class="login-brand"><span class="brand-mark" style="width:48px;height:48px;min-width:48px;font-size:22px;border-radius:14px">L</span></div>
            <h1>Labour Management System</h1>
            <p class="subtitle">Sign in to continue</p>
            ${query.error ? `<div class="flash flash-error">${esc(query.error)}</div>` : ''}
            <form method="POST" action="/login">
              <label>Username</label><input name="username" required autofocus>
              <label>Password</label><input name="password" type="password" required>
              <button class="btn" type="submit" style="width:100%">Sign in</button>
            </form>
            <p class="hint">Demo accounts (seeded): superadmin1/superadmin123 · admin/admin123 · hr/hr123 · labormanager1/labor123 · auditmanager1/audit123 · pm1/pm123 · se1/se123</p>
          </div>
        </div>`,
      })
    );
  }

  if (pathname === '/login' && req.method === 'POST') {
    const result = auth.login(reqBody.username || '', reqBody.password || '');
    if (result && result.locked) {
      return redirect(res, '/login?error=' + encodeURIComponent('Too many failed attempts for this account — try again in 15 minutes.'));
    }
    if (!result) return redirect(res, '/login?error=' + encodeURIComponent('Invalid username or password'));
    return redirect(res, '/', `session=${result}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200${COOKIE_SECURE}`);
  }

  if (!requireLogin(user, res)) return;

  // POST-only, CSRF-checked above like every other mutation — deleting a
  // session is a real state change, so it no longer happens on a bare GET
  // (see the GET /logout no-op earlier in this function). The sidebar's
  // logout control is a small same-styled <form>, not a plain link, so this
  // is reached by a normal submit, not a hand-typed URL.
  if (pathname === '/logout' && req.method === 'POST') {
    auth.logout(cookies.session);
    return redirect(res, '/login', `session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${COOKIE_SECURE}`);
  }

  // ---- Forced password change (v10) ----
  // A temp-password account (a fresh Super-Admin-created login, or one whose
  // password was just reset with the checkbox left on) can reach exactly two
  // things until this clears: this screen, and logging out — both handled
  // above this gate. Every other route, GET or POST, is blocked here so
  // there's no path to real functionality on a one-time password nobody but
  // the account holder has seen. GETs bounce to the form; a POST reaching
  // here (rather than the /account/change-password POST route below) means
  // some other form was submitted anyway, which the normal UI would never
  // do — reject it outright instead of guessing where to send it.
  const CHANGE_PASSWORD_PATH = '/account/change-password';
  if (user.must_change_password && pathname !== CHANGE_PASSWORD_PATH) {
    if (req.method === 'GET') return redirect(res, CHANGE_PASSWORD_PATH);
    return send(
      res,
      403,
      layout({
        title: 'Password change required',
        user,
        currentPath: pathname,
        flash: { type: 'error', message: 'Set a new password before continuing.' },
        body: renderChangePasswordForm(),
      })
    );
  }

  if (pathname === CHANGE_PASSWORD_PATH && req.method === 'GET') {
    return send(res, 200, layout({ title: 'Change password', user, currentPath: pathname, body: renderChangePasswordForm() }));
  }

  if (pathname === CHANGE_PASSWORD_PATH && req.method === 'POST') {
    const b = reqBody;
    const current = b.current_password || '';
    const next = (b.new_password || '').trim();
    const confirm = (b.confirm_password || '').trim();
    if (!auth.verifyPassword(current, user.salt, user.password_hash)) {
      return send(res, 400, layout({ title: 'Change password', user, currentPath: pathname, body: renderChangePasswordForm({ error: 'Current password is incorrect.' }) }));
    }
    if (next.length < 8) {
      return send(res, 400, layout({ title: 'Change password', user, currentPath: pathname, body: renderChangePasswordForm({ error: 'New password must be at least 8 characters.' }) }));
    }
    if (next !== confirm) {
      return send(res, 400, layout({ title: 'Change password', user, currentPath: pathname, body: renderChangePasswordForm({ error: 'New password and confirmation do not match.' }) }));
    }
    if (next === current) {
      return send(res, 400, layout({ title: 'Change password', user, currentPath: pathname, body: renderChangePasswordForm({ error: 'New password must be different from the current one.' }) }));
    }
    const { hash, salt } = auth.hashPassword(next);
    db.prepare('UPDATE users SET password_hash = ?, salt = ?, must_change_password = 0 WHERE id = ?').run(hash, salt, user.id);
    logAudit(user.id, 'update', 'user', user.id, `${user.username} changed their own password (first-login requirement cleared)`);
    return redirect(res, '/');
  }

  if (pathname === '/' && req.method === 'GET') {
    return send(res, 200, layout({ title: 'Dashboard', user, currentPath: pathname, body: renderDashboard(user) }));
  }

  // v9.9: split out of the Dashboard (see renderDashboard) so the daily
  // landing page stays a quick scan and the full report lives on its own
  // page. Authorization is checked, and the 403 returned, before
  // renderAnalyticsSection()'s queries ever run — can(user, 'analytics.view')
  // is the same single-source-of-truth capability the Dashboard's own
  // payroll-runs card and "View full analytics" link are gated on, not a
  // separately hardcoded role list.
  if (pathname === '/analytics' && req.method === 'GET') {
    if (!can(user, 'analytics.view')) return forbidden(res, user, pathname, layout);
    return send(
      res,
      200,
      layout({
        title: 'Analytics',
        user,
        currentPath: pathname,
        body: `<h1>Analytics</h1><p class="subtitle">Company-wide trends and comparisons. For today's operational view, see the <a href="/">Dashboard</a>.</p>${renderAnalyticsSection()}`,
      })
    );
  }

  // ---- Workers ----
  if (pathname === '/workers' && req.method === 'GET') {
    return send(res, 200, layout({ title: 'Workers', user, currentPath: pathname, body: renderWorkersList(user, query) }));
  }
  if (pathname === '/workers/new' && req.method === 'GET') {
    if (!WORKER_MANAGE_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    return send(res, 200, layout({ title: 'Add worker', user, currentPath: '/workers', body: renderWorkerForm(null) }));
  }
  if (pathname === '/workers' && req.method === 'POST') {
    if (!WORKER_MANAGE_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const b = reqBody;
    if (!AADHAR_RE.test(b.aadhar_number || '')) {
      return send(
        res,
        400,
        layout({
          title: 'Add worker',
          user,
          currentPath: '/workers',
          body: renderWorkerForm(null, { error: 'Aadhar number must be exactly 12 digits.', values: b }),
        })
      );
    }
    if (findWorkerByAadhar(b.aadhar_number)) {
      return send(
        res,
        400,
        layout({
          title: 'Add worker',
          user,
          currentPath: '/workers',
          body: renderWorkerForm(null, { error: 'A worker with this Aadhar number already exists. Cannot add a duplicate.', values: b }),
        })
      );
    }
    const contactDigits = digitsOnly(b.contact);
    if (!PHONE_RE.test(contactDigits)) {
      return send(
        res,
        400,
        layout({
          title: 'Add worker',
          user,
          currentPath: '/workers',
          body: renderWorkerForm(null, { error: 'A contact phone number (at least 10 digits) is required.', values: b }),
        })
      );
    }
    const wageRate = parseFloat(b.wage_rate);
    if (!(wageRate > 0)) {
      return send(
        res,
        400,
        layout({
          title: 'Add worker',
          user,
          currentPath: '/workers',
          body: renderWorkerForm(null, { error: 'Hourly wage rate must be a positive number.', values: b }),
        })
      );
    }
    const newWorkerInfo = db.prepare(
      `INSERT INTO workers (worker_code, name, worker_type_id, vendor_id, aadhar_number, site_id, wage_rate, overtime_multiplier, contact, status, skill_grade, verification_status, joined_date)
       VALUES (@worker_code, @name, @worker_type_id, @vendor_id, @aadhar_number, ${POOL_SITE_ID}, @wage_rate, @overtime_multiplier, @contact, 'active', @skill_grade, 'pending', @joined_date)`
    ).run({
      worker_code: nextWorkerCode(),
      name: b.name,
      worker_type_id: b.worker_type_id || null,
      vendor_id: b.vendor_id,
      aadhar_number: b.aadhar_number,
      wage_rate: wageRate,
      overtime_multiplier: parseFloat(b.overtime_multiplier) || 1.5,
      contact: contactDigits,
      skill_grade: b.skill_grade || 'skilled',
      joined_date: b.joined_date || todayStr(),
    });
    logAudit(user.id, 'create', 'worker', newWorkerInfo.lastInsertRowid, b.name);
    return redirect(res, '/workers');
  }
  const workerEditMatch = pathname.match(/^\/workers\/(\d+)\/edit$/);
  if (workerEditMatch && req.method === 'GET') {
    if (!WORKER_MANAGE_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(workerEditMatch[1]);
    if (!w) return send(res, 404, 'Not found');
    return send(res, 200, layout({ title: 'Edit worker', user, currentPath: '/workers', body: renderWorkerForm(w, { user }) }));
  }
  const workerUpdateMatch = pathname.match(/^\/workers\/(\d+)$/);
  if (workerUpdateMatch && req.method === 'POST') {
    if (!WORKER_MANAGE_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const id = workerUpdateMatch[1];
    const b = reqBody;
    const existingWorker = db.prepare('SELECT * FROM workers WHERE id = ?').get(id);
    if (!existingWorker) return send(res, 404, 'Not found');
    if (!AADHAR_RE.test(b.aadhar_number || '')) {
      return send(
        res,
        400,
        layout({
          title: 'Edit worker',
          user,
          currentPath: '/workers',
          body: renderWorkerForm(Object.assign({}, existingWorker, { id }), { error: 'Aadhar number must be exactly 12 digits.', values: b, user }),
        })
      );
    }
    if (findWorkerByAadhar(b.aadhar_number, id)) {
      return send(
        res,
        400,
        layout({
          title: 'Edit worker',
          user,
          currentPath: '/workers',
          body: renderWorkerForm(Object.assign({}, existingWorker, { id }), {
            error: 'A worker with this Aadhar number already exists. Cannot save a duplicate.',
            values: b,
            user,
          }),
        })
      );
    }
    const editContactDigits = digitsOnly(b.contact);
    if (!PHONE_RE.test(editContactDigits)) {
      return send(
        res,
        400,
        layout({
          title: 'Edit worker',
          user,
          currentPath: '/workers',
          body: renderWorkerForm(Object.assign({}, existingWorker, { id }), {
            error: 'A contact phone number (at least 10 digits) is required.',
            values: b,
            user,
          }),
        })
      );
    }
    const editWageRate = parseFloat(b.wage_rate);
    if (!(editWageRate > 0)) {
      return send(
        res,
        400,
        layout({
          title: 'Edit worker',
          user,
          currentPath: '/workers',
          body: renderWorkerForm(Object.assign({}, existingWorker, { id }), {
            error: 'Hourly wage rate must be a positive number.',
            values: b,
            user,
          }),
        })
      );
    }
    db.prepare(
      `UPDATE workers SET name=@name, worker_type_id=@worker_type_id, vendor_id=@vendor_id, aadhar_number=@aadhar_number,
        site_id=@site_id, wage_rate=@wage_rate, overtime_multiplier=@overtime_multiplier, contact=@contact, status=@status, skill_grade=@skill_grade, joined_date=@joined_date
       WHERE id=@id`
    ).run({
      id,
      name: b.name,
      worker_type_id: b.worker_type_id || null,
      vendor_id: b.vendor_id,
      aadhar_number: b.aadhar_number,
      site_id: b.site_id,
      wage_rate: editWageRate,
      overtime_multiplier: parseFloat(b.overtime_multiplier) || 1.5,
      contact: editContactDigits,
      status: b.status || 'active',
      skill_grade: b.skill_grade || 'skilled',
      joined_date: b.joined_date || todayStr(),
    });
    logAudit(user.id, 'update', 'worker', id, b.name);
    return redirect(res, '/workers');
  }
  // Worker hard-delete was removed per Zen's request — workers are retired via the
  // Status=Inactive path only (renderWorkerForm), never permanently deleted, regardless
  // of history. Any lingering POST to the old /workers/:id/delete URL (e.g. a stale
  // bookmark) falls through to the 404 handler at the bottom of the router.
  const workerAbsorbMatch = pathname.match(/^\/workers\/(\d+)\/absorb$/);
  if (workerAbsorbMatch && req.method === 'POST') {
    if (!WORKER_MANAGE_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const id = workerAbsorbMatch[1];
    const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(id);
    const dId = directVendorId();
    if (w && dId) db.prepare('UPDATE workers SET vendor_id = ? WHERE id = ?').run(dId, id);
    return redirect(res, `/workers/${id}/edit`);
  }
  // Identity verification is an HR responsibility — the worker's Aadhar
  // number is the proof of identity on file; this just tracks whether HR has
  // actually checked it. Toggleable both ways so a mistaken mark can be
  // corrected without deleting and re-adding the worker.
  const workerVerifyMatch = pathname.match(/^\/workers\/(\d+)\/toggle-verification$/);
  if (workerVerifyMatch && req.method === 'POST') {
    if (!WORKER_VERIFY_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const id = workerVerifyMatch[1];
    const w = db.prepare('SELECT * FROM workers WHERE id = ?').get(id);
    if (!w) return send(res, 404, 'Not found');
    const next = w.verification_status === 'verified' ? 'pending' : 'verified';
    db.prepare('UPDATE workers SET verification_status = ? WHERE id = ?').run(next, id);
    return redirect(res, `/workers/${id}/edit`);
  }

  // ---- Vendors ----
  if (pathname === '/vendors' && req.method === 'GET') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    return send(res, 200, layout({ title: 'Vendors', user, currentPath: pathname, body: renderVendors({ page: pageFromQuery(query) }) }));
  }
  if (pathname === '/vendors' && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const b = reqBody;
    const contactDigits = digitsOnly(b.contact);
    const whatsappSame = !!b.whatsapp_same;
    const whatsappDigits = whatsappSame ? contactDigits : digitsOnly(b.whatsapp);
    if (!b.name || !b.name.trim()) {
      return send(res, 400, layout({ title: 'Vendors', user, currentPath: '/vendors', body: renderVendors({ error: 'Vendor name is required.', values: b }) }));
    }
    if (!PHONE_RE.test(contactDigits)) {
      return send(
        res,
        400,
        layout({ title: 'Vendors', user, currentPath: '/vendors', body: renderVendors({ error: 'A vendor contact phone number (at least 10 digits) is required.', values: b }) })
      );
    }
    if (!whatsappSame && b.whatsapp && !PHONE_RE.test(whatsappDigits)) {
      return send(
        res,
        400,
        layout({ title: 'Vendors', user, currentPath: '/vendors', body: renderVendors({ error: 'WhatsApp number must be at least 10 digits.', values: b }) })
      );
    }
    if (b.email && !EMAIL_RE.test(b.email.trim())) {
      return send(res, 400, layout({ title: 'Vendors', user, currentPath: '/vendors', body: renderVendors({ error: 'That does not look like a valid email address.', values: b }) }));
    }
    const newVendorInfo = db.prepare('INSERT INTO vendors (vendor_code, name, contact, whatsapp, email, address, is_direct) VALUES (?, ?, ?, ?, ?, ?, 0)').run(
      nextVendorCode(),
      b.name.trim(),
      contactDigits,
      whatsappSame || b.whatsapp ? whatsappDigits : null,
      b.email ? b.email.trim() : null,
      b.address ? b.address.trim() : null
    );
    logAudit(user.id, 'create', 'vendor', newVendorInfo.lastInsertRowid, b.name.trim());
    return redirect(res, '/vendors');
  }
  const vendorDeleteMatch = pathname.match(/^\/vendors\/(\d+)\/delete$/);
  if (vendorDeleteMatch && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const v = db.prepare('SELECT * FROM vendors WHERE id = ?').get(vendorDeleteMatch[1]);
    if (!v) return send(res, 404, 'Not found');
    if (v.is_direct) return redirect(res, '/vendors');
    const deps = vendorDependencyCounts(v.id);
    if (deps.workers > 0 || deps.payrollItems > 0) {
      return send(
        res,
        400,
        layout({
          title: 'Vendors',
          user,
          currentPath: '/vendors',
          flash: {
            type: 'error',
            message: `Can't delete ${v.name} — it has ${deps.workers} worker(s) and ${deps.payrollItems} payroll record(s) tied to it. Reassign or deactivate its workers from the vendor's Edit page first, then deactivate the vendor.`,
          },
          body: renderVendors(),
        })
      );
    }
    db.prepare('DELETE FROM vendors WHERE id = ?').run(v.id);
    logAudit(user.id, 'delete', 'vendor', v.id, v.name);
    return redirect(res, '/vendors');
  }
  const vendorToggleActiveMatch = pathname.match(/^\/vendors\/(\d+)\/toggle-active$/);
  if (vendorToggleActiveMatch && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const v = db.prepare('SELECT * FROM vendors WHERE id = ?').get(vendorToggleActiveMatch[1]);
    if (!v) return send(res, 404, 'Not found');
    if (v.is_direct) return redirect(res, '/vendors');
    if (v.active) {
      const deps = vendorDependencyCounts(v.id);
      if (deps.activeWorkers > 0) {
        return send(
          res,
          400,
          layout({
            title: 'Edit vendor',
            user,
            currentPath: '/vendors',
            flash: {
              type: 'error',
              message: `Can't deactivate ${v.name} — it still has ${deps.activeWorkers} active worker(s). Reassign or mark them inactive below first.`,
            },
            body: renderVendorForm(v),
          })
        );
      }
    }
    db.prepare('UPDATE vendors SET active = ? WHERE id = ?').run(v.active ? 0 : 1, v.id);
    return redirect(res, '/vendors');
  }
  const vendorReassignMatch = pathname.match(/^\/vendors\/(\d+)\/reassign-workers$/);
  if (vendorReassignMatch && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const sourceId = vendorReassignMatch[1];
    const b = reqBody;
    const targetId = b.target_vendor_id;
    if (targetId && String(targetId) !== String(sourceId)) {
      db.prepare(`UPDATE workers SET vendor_id = ? WHERE vendor_id = ? AND status = 'active'`).run(targetId, sourceId);
    }
    return redirect(res, `/vendors/${sourceId}/edit`);
  }
  const vendorDeactivateWorkersMatch = pathname.match(/^\/vendors\/(\d+)\/deactivate-workers$/);
  if (vendorDeactivateWorkersMatch && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const vendorId = vendorDeactivateWorkersMatch[1];
    db.prepare(`UPDATE workers SET status = 'inactive' WHERE vendor_id = ? AND status = 'active'`).run(vendorId);
    return redirect(res, `/vendors/${vendorId}/edit`);
  }
  const vendorEditMatch = pathname.match(/^\/vendors\/(\d+)\/edit$/);
  if (vendorEditMatch && req.method === 'GET') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const v = db.prepare('SELECT * FROM vendors WHERE id = ?').get(vendorEditMatch[1]);
    if (!v) return send(res, 404, 'Not found');
    return send(res, 200, layout({ title: 'Edit vendor', user, currentPath: '/vendors', body: renderVendorForm(v) }));
  }
  const vendorUpdateMatch = pathname.match(/^\/vendors\/(\d+)$/);
  if (vendorUpdateMatch && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const id = vendorUpdateMatch[1];
    const existingVendor = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
    if (!existingVendor) return send(res, 404, 'Not found');
    const b = reqBody;
    const codeToUse = existingVendor.is_direct ? existingVendor.vendor_code : b.vendor_code;
    const dupe = db.prepare('SELECT * FROM vendors WHERE vendor_code = ? AND id != ?').get(codeToUse, id);
    if (dupe) {
      return send(
        res,
        400,
        layout({
          title: 'Edit vendor',
          user,
          currentPath: '/vendors',
          body: renderVendorForm(Object.assign({}, existingVendor, { id }), {
            error: 'A vendor with this code already exists.',
            values: b,
          }),
        })
      );
    }
    const vendorContactDigits = digitsOnly(b.contact);
    const vendorWhatsappSame = !!b.whatsapp_same;
    const vendorWhatsappDigits = vendorWhatsappSame ? vendorContactDigits : digitsOnly(b.whatsapp);
    if (!PHONE_RE.test(vendorContactDigits)) {
      return send(
        res,
        400,
        layout({
          title: 'Edit vendor',
          user,
          currentPath: '/vendors',
          body: renderVendorForm(Object.assign({}, existingVendor, { id }), {
            error: 'A vendor contact phone number (at least 10 digits) is required.',
            values: b,
          }),
        })
      );
    }
    if (!vendorWhatsappSame && b.whatsapp && !PHONE_RE.test(vendorWhatsappDigits)) {
      return send(
        res,
        400,
        layout({
          title: 'Edit vendor',
          user,
          currentPath: '/vendors',
          body: renderVendorForm(Object.assign({}, existingVendor, { id }), { error: 'WhatsApp number must be at least 10 digits.', values: b }),
        })
      );
    }
    if (b.email && !EMAIL_RE.test(b.email.trim())) {
      return send(
        res,
        400,
        layout({
          title: 'Edit vendor',
          user,
          currentPath: '/vendors',
          body: renderVendorForm(Object.assign({}, existingVendor, { id }), { error: 'That does not look like a valid email address.', values: b }),
        })
      );
    }
    db.prepare('UPDATE vendors SET vendor_code = ?, name = ?, contact = ?, whatsapp = ?, email = ?, address = ? WHERE id = ?').run(
      codeToUse,
      b.name,
      vendorContactDigits,
      vendorWhatsappSame || b.whatsapp ? vendorWhatsappDigits : null,
      b.email ? b.email.trim() : null,
      b.address ? b.address.trim() : null,
      id
    );
    logAudit(user.id, 'update', 'vendor', id, b.name);
    return redirect(res, '/vendors');
  }

  // ---- Worker types ----
  if (pathname === '/worker-types' && req.method === 'GET') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    return send(res, 200, layout({ title: 'Worker types', user, currentPath: pathname, body: renderWorkerTypes() }));
  }
  if (pathname === '/worker-types' && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const b = reqBody;
    try {
      db.prepare('INSERT INTO worker_types (name) VALUES (?)').run(b.name);
    } catch (e) {
      /* duplicate name — ignore for prototype */
    }
    return redirect(res, '/worker-types');
  }
  const typeToggleMatch = pathname.match(/^\/worker-types\/(\d+)\/toggle$/);
  if (typeToggleMatch && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const t = db.prepare('SELECT * FROM worker_types WHERE id = ?').get(typeToggleMatch[1]);
    if (t) db.prepare('UPDATE worker_types SET active = ? WHERE id = ?').run(t.active ? 0 : 1, t.id);
    return redirect(res, '/worker-types');
  }

  // ---- Skill assessments (v9.2) ----
  if (pathname === '/skill-assessments' && req.method === 'GET') {
    if (!can(user, 'workers.skill_assess')) return forbidden(res, user, pathname, layout);
    const opts = {};
    if (query.saved) opts.saved = decodeURIComponent(query.saved);
    return send(res, 200, layout({ title: 'Skill assessments', user, currentPath: pathname, body: renderSkillAssessments(user, query, opts) }));
  }
  // Category management is its own page (v9.4) — see renderSkillCategories.
  if (pathname === '/skill-assessments/categories' && req.method === 'GET') {
    if (!can(user, 'skillcategories.manage')) return forbidden(res, user, pathname, layout);
    return send(res, 200, layout({ title: 'Manage skill categories', user, currentPath: '/skill-assessments', body: renderSkillCategories(user) }));
  }
  if (pathname === '/skill-assessments/categories' && req.method === 'POST') {
    if (!can(user, 'skillcategories.manage')) return forbidden(res, user, pathname, layout);
    const b = reqBody;
    const wt = db.prepare('SELECT * FROM worker_types WHERE id = ?').get(b.worker_type_id);
    const name = (b.name || '').trim();
    if (!wt || !name) {
      return send(
        res,
        400,
        layout({
          title: 'Manage skill categories',
          user,
          currentPath: '/skill-assessments',
          body: renderSkillCategories(user, { error: !wt ? 'Select a valid worker type.' : 'Category name is required.', selectedType: b.worker_type_id }),
        })
      );
    }
    try {
      db.prepare('INSERT INTO skill_categories (worker_type_id, name) VALUES (?, ?)').run(wt.id, name);
      logAudit(user.id, 'create', 'skill_category', null, `${wt.name} — ${name}`);
    } catch (e) {
      // UNIQUE(worker_type_id, name) — a duplicate category for this type.
      // Not worth a hard failure; just re-render with a note, matching the
      // low-stakes "ignore duplicates" treatment worker_types uses too.
      return send(
        res,
        400,
        layout({
          title: 'Manage skill categories',
          user,
          currentPath: '/skill-assessments',
          body: renderSkillCategories(user, { error: `"${name}" already exists for ${wt.name}.`, selectedType: b.worker_type_id }),
        })
      );
    }
    return redirect(res, '/skill-assessments/categories');
  }
  const skillCategoryToggleMatch = pathname.match(/^\/skill-assessments\/categories\/(\d+)\/toggle$/);
  if (skillCategoryToggleMatch && req.method === 'POST') {
    if (!can(user, 'skillcategories.manage')) return forbidden(res, user, pathname, layout);
    const c = db.prepare('SELECT * FROM skill_categories WHERE id = ?').get(skillCategoryToggleMatch[1]);
    if (c) {
      db.prepare('UPDATE skill_categories SET active = ? WHERE id = ?').run(c.active ? 0 : 1, c.id);
      logAudit(user.id, c.active ? 'disable' : 'enable', 'skill_category', c.id, c.name);
    }
    return redirect(res, '/skill-assessments/categories');
  }
  const skillCategoryRenameMatch = pathname.match(/^\/skill-assessments\/categories\/(\d+)\/rename$/);
  if (skillCategoryRenameMatch && req.method === 'POST') {
    if (!can(user, 'skillcategories.manage')) return forbidden(res, user, pathname, layout);
    const c = db.prepare('SELECT * FROM skill_categories WHERE id = ?').get(skillCategoryRenameMatch[1]);
    if (!c) return send(res, 404, 'Not found');
    const b = reqBody;
    const name = (b.name || '').trim();
    if (!name) {
      return send(
        res,
        400,
        layout({
          title: 'Manage skill categories',
          user,
          currentPath: '/skill-assessments',
          body: renderSkillCategories(user, { error: 'Category name is required.' }),
        })
      );
    }
    if (name !== c.name) {
      try {
        db.prepare('UPDATE skill_categories SET name = ? WHERE id = ?').run(name, c.id);
        logAudit(user.id, 'rename', 'skill_category', c.id, `"${c.name}" → "${name}"`);
      } catch (e) {
        // UNIQUE(worker_type_id, name) — renaming into a name that already
        // exists for this worker type. Same friendly-error treatment as
        // creating a duplicate category.
        const wt = db.prepare('SELECT * FROM worker_types WHERE id = ?').get(c.worker_type_id);
        return send(
          res,
          400,
          layout({
            title: 'Manage skill categories',
            user,
            currentPath: '/skill-assessments',
            body: renderSkillCategories(user, { error: `"${name}" already exists for ${wt ? wt.name : 'this worker type'}.` }),
          })
        );
      }
    }
    return redirect(res, '/skill-assessments/categories');
  }
  if (pathname === '/skill-assessments/rate' && req.method === 'POST') {
    if (!can(user, 'workers.skill_assess')) return forbidden(res, user, pathname, layout);
    const b = reqBody;
    const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get(b.worker_id);
    if (!worker) return send(res, 404, 'Not found');
    // Only categories that actually belong to this worker's type and are
    // currently active are honored — a stale form (type changed mid-edit,
    // or a category disabled after the page loaded) can't write a rating for
    // a category it shouldn't apply to.
    const validCats = new Set(skillCategoriesForType(worker.worker_type_id).map((c) => c.id));
    const upsert = db.prepare(
      `INSERT INTO worker_skill_ratings (worker_id, skill_category_id, rating, rated_by) VALUES (@workerId, @catId, @rating, @ratedBy)
       ON CONFLICT(worker_id, skill_category_id) DO UPDATE SET rating = @rating, rated_by = @ratedBy, rated_at = datetime('now')`
    );
    const clearRating = db.prepare('DELETE FROM worker_skill_ratings WHERE worker_id = ? AND skill_category_id = ?');
    let ratedCount = 0;
    for (const key of Object.keys(b)) {
      const m = key.match(/^rating_(\d+)$/);
      if (!m) continue;
      const catId = Number(m[1]);
      if (!validCats.has(catId)) continue;
      const rating = b[key];
      if (!rating) {
        clearRating.run(worker.id, catId);
        continue;
      }
      if (!['trainee', 'skilled', 'expert'].includes(rating)) continue;
      upsert.run({ workerId: worker.id, catId, rating, ratedBy: user.id });
      ratedCount++;
    }
    logAudit(user.id, 'update', 'worker_skill_ratings', worker.id, `${worker.name} — ${ratedCount} categor${ratedCount === 1 ? 'y' : 'ies'} rated`);
    const returnQuery = b.return_query || '';
    return redirect(res, `/skill-assessments?worker_id=${worker.id}&saved=${encodeURIComponent(worker.name)}${returnQuery ? '&' + returnQuery : ''}`);
  }

  // ---- Attendance ----
  if (pathname === '/attendance' && req.method === 'GET') {
    if (!ATTENDANCE_MARK_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    return send(res, 200, layout({ title: 'Attendance', user, currentPath: pathname, body: renderAttendance(user, query) }));
  }
  if (pathname === '/attendance' && req.method === 'POST') {
    if (!ATTENDANCE_MARK_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const b = reqBody;
    const date = b.date || todayStr();
    // A supervisor's own site_id is authoritative, never the submitted
    // form value — the GET form already hides the site picker for
    // supervisors, but a POST can be replayed/edited client-side, so this is
    // enforced again here. Without it, a supervisor could mark attendance
    // (and thus payroll-relevant hours) for a site they aren't assigned to.
    const siteId = user.role === 'supervisor' ? user.site_id : b.site_id;
    // Validate the whole submission before writing anything, so a bulk save
    // either fully succeeds or leaves nothing half-saved: the date and site
    // once, then every row's worker and its 10-hour cap. The worker check is
    // the same helper the single-entry route uses — the grid only renders this
    // site's crew, but a hand-crafted POST can name any id, and without this
    // an injected hours_<id> would be written unchecked.
    const bulkReject = (message) =>
      send(
        res,
        400,
        layout({
          title: 'Attendance',
          user,
          currentPath: '/attendance',
          flash: { type: 'error', message },
          body: renderAttendance(user, { date, site_id: siteId }),
        })
      );
    if (!isValidDateStr(date)) return bulkReject(`${ATTENDANCE_BAD_DATE} Nothing was saved.`);
    const bulkSiteError = attendanceSiteError(user, siteId);
    if (bulkSiteError) return bulkReject(`${bulkSiteError} Nothing was saved.`);
    for (const key of Object.keys(b)) {
      const m = key.match(/^hours_(\d+)$/);
      if (!m) continue;
      const workerId = m[1];
      const workerError = attendanceWorkerError(workerId);
      if (workerError) return bulkReject(`${workerError} Nothing was saved.`);
      const hours = parseFloat(b[`hours_${workerId}`]) || 0;
      const ot = parseFloat(b[`ot_${workerId}`]) || 0;
      if (hours + ot > 10) {
        return bulkReject(
          `Hours worked + overtime can't exceed 10 hours in a day for any worker. Nothing was saved — fix the highlighted row(s) and resubmit.`
        );
      }
    }
    const upsert = db.prepare(
      `INSERT INTO attendance (worker_id, site_id, date, hours_worked, leave_hours, overtime_hours, marked_by)
       VALUES (@workerId, @siteId, @date, @hours, @leave, @ot, @markedBy)
       ON CONFLICT(worker_id, date, site_id) DO UPDATE SET hours_worked=@hours, leave_hours=@leave, overtime_hours=@ot, marked_by=@markedBy, marked_at=datetime('now')`
    );
    for (const key of Object.keys(b)) {
      const m = key.match(/^hours_(\d+)$/);
      if (!m) continue;
      const workerId = m[1];
      upsert.run({
        workerId,
        siteId,
        date,
        hours: parseFloat(b[`hours_${workerId}`]) || 0,
        leave: parseFloat(b[`leave_${workerId}`]) || 0,
        ot: parseFloat(b[`ot_${workerId}`]) || 0,
        markedBy: user.id,
      });
      auditCrossSiteAttendance(user, workerId, siteId, date);
    }
    return redirect(res, `/attendance?date=${encodeURIComponent(date)}&site_id=${encodeURIComponent(siteId)}`);
  }
  if (pathname === '/attendance/single-entry' && req.method === 'GET') {
    if (!ATTENDANCE_MARK_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    return send(
      res,
      200,
      layout({ title: 'Add single attendance entry', user, currentPath: '/attendance', body: renderSingleEntry(user, query) })
    );
  }
  if (pathname === '/attendance/entry' && req.method === 'POST') {
    if (!ATTENDANCE_MARK_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const b = reqBody;
    // Same server-side clamp as the bulk-grid save above — a supervisor can
    // only ever record hours against their own site, regardless of what
    // site_id a submitted (or hand-edited) form claims.
    if (user.role === 'supervisor') b.site_id = user.site_id;
    const hours = parseFloat(b.hours) || 0;
    const ot = parseFloat(b.ot) || 0;
    // Worker/site/date eligibility, same helper the bulk grid uses. Runs
    // before the hours check so a request that names an ineligible worker or
    // site is rejected whatever its hours say.
    const entryError = attendanceWriteError(user, b);
    if (entryError || hours + ot > 10) {
      return send(
        res,
        400,
        layout({
          title: 'Add single attendance entry',
          user,
          currentPath: '/attendance',
          flash: {
            type: 'error',
            message: entryError || "Hours worked + overtime can't exceed 10 hours in a day. Nothing was saved.",
          },
          // Re-render the single-entry page (where this form now lives) with
          // what was typed still in the fields, so a rejected submission
          // doesn't make the user re-pick the worker, site, and date.
          body: renderSingleEntry(user, { date: b.date }, { values: b }),
        })
      );
    }
    db.prepare(
      `INSERT INTO attendance (worker_id, site_id, date, hours_worked, leave_hours, overtime_hours, marked_by)
       VALUES (@workerId, @siteId, @date, @hours, @leave, @ot, @markedBy)
       ON CONFLICT(worker_id, date, site_id) DO UPDATE SET hours_worked=@hours, leave_hours=@leave, overtime_hours=@ot, marked_by=@markedBy, marked_at=datetime('now')`
    ).run({
      workerId: b.worker_id,
      siteId: b.site_id,
      date: b.date,
      hours,
      leave: parseFloat(b.leave) || 0,
      ot,
      markedBy: user.id,
    });
    auditCrossSiteAttendance(user, b.worker_id, b.site_id, b.date);
    // Back to the single-entry page with a confirmation rather than the bulk
    // grid — corrections usually come in twos and threes, and the page carries
    // a "Back to site attendance" button for when they're done.
    const savedWorker = db.prepare('SELECT name FROM workers WHERE id = ?').get(b.worker_id);
    return redirect(
      res,
      `/attendance/single-entry?date=${encodeURIComponent(b.date || todayStr())}&saved=${encodeURIComponent(
        (savedWorker && savedWorker.name) || 'worker'
      )}`
    );
  }
  if (pathname === '/attendance/site-off' && req.method === 'GET') {
    if (!ATTENDANCE_MARK_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    return send(res, 200, layout({ title: 'Site off days', user, currentPath: '/attendance', body: renderSiteOff(user, query) }));
  }
  if (pathname === '/attendance/site-off' && req.method === 'POST') {
    if (!ATTENDANCE_MARK_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const b = reqBody;
    // Same clamp as the other attendance-writing routes: a supervisor can
    // only mark their own site off, never one submitted in the form.
    if (user.role === 'supervisor') b.site_id = user.site_id;
    if (b.site_id && b.date) {
      db.prepare(
        `INSERT INTO site_off_days (site_id, date, reason, created_by) VALUES (?, ?, ?, ?)
         ON CONFLICT(site_id, date) DO UPDATE SET reason = excluded.reason`
      ).run(b.site_id, b.date, b.reason || null, user.id);
      logAudit(user.id, 'create', 'site_off_day', null, `site ${b.site_id} — ${b.date}`);
    }
    return redirect(res, `/attendance/site-off?date=${encodeURIComponent(b.date || todayStr())}&site_id=${encodeURIComponent(b.site_id || '')}`);
  }
  const siteOffDeleteMatch = pathname.match(/^\/attendance\/site-off\/(\d+)\/delete$/);
  if (siteOffDeleteMatch && req.method === 'POST') {
    if (!ATTENDANCE_MARK_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const off = db.prepare('SELECT * FROM site_off_days WHERE id = ?').get(siteOffDeleteMatch[1]);
    // A supervisor can only remove an off-day for their own site — without
    // this, the same IDOR as the writes above would let them delete another
    // site's off-day by guessing/incrementing the id in the POST url.
    if (user.role === 'supervisor' && off && String(off.site_id) !== String(user.site_id)) return forbidden(res, user, pathname, layout);
    db.prepare('DELETE FROM site_off_days WHERE id = ?').run(siteOffDeleteMatch[1]);
    logAudit(user.id, 'delete', 'site_off_day', siteOffDeleteMatch[1], off ? `site ${off.site_id} — ${off.date}` : null);
    return redirect(res, `/attendance/site-off${off ? `?site_id=${off.site_id}&date=${off.date}` : ''}`);
  }
  const attendanceDeleteMatch = pathname.match(/^\/attendance\/(\d+)\/delete$/);
  if (attendanceDeleteMatch && req.method === 'POST') {
    // Correcting the historical record is Admin/HR/Labor Manager work (v9,
    // per Zen) — oversight roles (PM/SE/CEO/etc.) and supervisors view
    // history but never delete from it.
    if (!can(user, 'attendance.delete')) return forbidden(res, user, pathname, layout);
    const entry = db.prepare('SELECT * FROM attendance WHERE id = ?').get(attendanceDeleteMatch[1]);
    db.prepare('DELETE FROM attendance WHERE id = ?').run(attendanceDeleteMatch[1]);
    logAudit(user.id, 'delete', 'attendance', attendanceDeleteMatch[1], entry ? `worker ${entry.worker_id} — ${entry.date} @ site ${entry.site_id}` : null);
    return redirect(res, '/attendance/history');
  }
  if (pathname === '/attendance/history' && req.method === 'GET') {
    return send(res, 200, layout({ title: 'Attendance history', user, currentPath: '/attendance', body: renderAttendanceHistory(user, query) }));
  }
  if (pathname === '/attendance/history/export.csv' && req.method === 'GET') {
    const { rows } = attendanceHistoryRows(user, query);
    const csvOut = [
      ['Date', 'Worker', 'Site', 'Hours worked', 'Overtime hours', 'Leave hours'],
      ...rows.map((r) => [r.date, r.worker_name, r.site_name || '', r.hours_worked, r.overtime_hours, r.leave_hours]),
    ];
    return sendCsv(res, `attendance_history.csv`, csvOut);
  }

  // ---- Payroll ----
  if (pathname === '/payroll' && req.method === 'GET') {
    if (!OVERSIGHT_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    return send(res, 200, layout({ title: 'Payroll', user, currentPath: pathname, body: renderPayrollList(user, query) }));
  }
  if (pathname === '/payroll/new' && req.method === 'GET') {
    if (!PAYROLL_GENERATE_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    return send(res, 200, layout({ title: 'New payroll run', user, currentPath: '/payroll', body: renderPayrollNew() }));
  }
  if (pathname === '/payroll/generate' && req.method === 'POST') {
    if (!PAYROLL_GENERATE_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const b = reqBody;
    const snapped = snapToPayPeriod(b.period_start);
    if (!snapped) {
      return send(
        res,
        400,
        layout({
          title: 'New payroll run',
          user,
          currentPath: '/payroll',
          body: renderPayrollNew({ error: 'Enter a valid period start date.' }),
        })
      );
    }
    b.period_start = snapped.start;
    b.period_end = snapped.end;
    const existing = db
      .prepare(`SELECT * FROM payroll_runs WHERE period_start = ? AND period_end = ? AND flagged = 0 ORDER BY id DESC LIMIT 1`)
      .get(b.period_start, b.period_end);
    if (existing) {
      return send(
        res,
        400,
        layout({
          title: 'New payroll run',
          user,
          currentPath: '/payroll',
          body: renderPayrollNew({
            error: `A payroll run for ${b.period_start} → ${b.period_end} already exists (status: ${
              PAYROLL_STATUS_LABEL[existing.status] || existing.status
            }). Flag that run first if you need to regenerate this period.`,
            values: b,
          }),
        })
      );
    }
    let runId;
    try {
      runId = generatePayroll(b, user.id);
    } catch (e) {
      // Backstop for the idx_payroll_runs_period_unflagged constraint (db.js)
      // — the SELECT check above already covers the normal case, this only
      // fires if two "Generate payroll" submits for the same period land at
      // the same instant. Same friendly message either way, not a raw 500.
      return send(
        res,
        400,
        layout({
          title: 'New payroll run',
          user,
          currentPath: '/payroll',
          body: renderPayrollNew({
            error: `A payroll run for ${b.period_start} → ${b.period_end} already exists. Flag that run first if you need to regenerate this period.`,
            values: b,
          }),
        })
      );
    }
    logAudit(user.id, 'generate', 'payroll_run', runId, `${b.period_start} → ${b.period_end}`);
    return redirect(res, `/payroll/${runId}`);
  }
  const payrollFlagMatch = pathname.match(/^\/payroll\/(\d+)\/flag$/);
  if (payrollFlagMatch && req.method === 'POST') {
    if (!PAYROLL_GENERATE_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const b = reqBody;
    const run = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(payrollFlagMatch[1]);
    if (run && !run.flagged) {
      db.prepare(
        `UPDATE payroll_runs SET flagged = 1, flagged_by = ?, flagged_at = datetime('now'), flagged_reason = ? WHERE id = ?`
      ).run(user.id, (b.reason || '').trim() || null, run.id);
      logAudit(user.id, 'flag', 'payroll_run', run.id, b.reason || null);
    }
    return redirect(res, `/payroll/${payrollFlagMatch[1]}`);
  }
  const payrollItemMatch = pathname.match(/^\/payroll\/items\/(\d+)$/);
  if (payrollItemMatch && req.method === 'GET') {
    if (!OVERSIGHT_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const html = renderPayrollItemDetail(payrollItemMatch[1], user);
    if (!html) return send(res, 404, 'Not found');
    return send(res, 200, layout({ title: 'Payroll item', user, currentPath: '/payroll', body: html }));
  }
  const deductionMatch = pathname.match(/^\/payroll\/items\/(\d+)\/deductions$/);
  if (deductionMatch && req.method === 'POST') {
    if (!PAYROLL_GENERATE_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const b = reqBody;
    const amount = parseFloat(b.amount);
    if (!(amount > 0)) {
      const html = renderPayrollItemDetail(deductionMatch[1], user);
      return send(
        res,
        400,
        layout({
          title: 'Payroll item',
          user,
          currentPath: '/payroll',
          flash: { type: 'error', message: 'Deduction amount must be a positive number.' },
          body: html,
        })
      );
    }
    db.prepare('INSERT INTO payroll_deductions (payroll_item_id, reason, amount) VALUES (?, ?, ?)').run(
      deductionMatch[1],
      b.reason,
      amount
    );
    return redirect(res, `/payroll/items/${deductionMatch[1]}`);
  }
  const payrollDetailMatch = pathname.match(/^\/payroll\/(\d+)$/);
  if (payrollDetailMatch && req.method === 'GET') {
    if (!OVERSIGHT_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const html = renderPayrollDetail(payrollDetailMatch[1], user);
    if (!html) return send(res, 404, 'Not found');
    return send(res, 200, layout({ title: 'Payroll run', user, currentPath: '/payroll', body: html }));
  }
  const payrollCsvMatch = pathname.match(/^\/payroll\/(\d+)\/export\.csv$/);
  if (payrollCsvMatch && req.method === 'GET') {
    if (!OVERSIGHT_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const run = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(payrollCsvMatch[1]);
    if (!run) return send(res, 404, 'Not found');
    const items = payrollItemsWithNet(payrollCsvMatch[1]);
    const rows = [
      ['Worker', 'Vendor', 'Days present', 'Hours worked', 'Overtime hours', 'Leave hours', 'Base pay', 'Overtime pay', 'Deductions', 'Net pay'],
      ...items.map((i) => [
        i.worker_name,
        i.vendor_name || '',
        i.days_present,
        i.hours_worked,
        i.overtime_hours,
        i.leave_hours,
        i.base_pay.toFixed(2),
        i.overtime_pay.toFixed(2),
        i.deductions_total.toFixed(2),
        i.net_pay.toFixed(2),
      ]),
    ];
    return sendCsv(res, `payroll_${run.period_start}_to_${run.period_end}.csv`, rows);
  }
  const payrollVerifyMatch = pathname.match(/^\/payroll\/(\d+)\/verify$/);
  if (payrollVerifyMatch && req.method === 'POST') {
    if (!PAYROLL_APPROVE_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const run = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(payrollVerifyMatch[1]);
    // Legacy fallback only — runs generated after the site-verification
    // feature always have payroll_item_sites rows and must be verified site
    // by site via /payroll/:id/sites/:siteId/verify instead.
    const hasSiteBreakdown = run
      ? db
          .prepare(
            `SELECT COUNT(*) c FROM payroll_item_sites pis JOIN payroll_items pi ON pi.id = pis.payroll_item_id WHERE pi.payroll_run_id = ?`
          )
          .get(run.id).c > 0
      : false;
    if (run && run.status === 'pending_verification' && !hasSiteBreakdown) {
      db.prepare(`UPDATE payroll_runs SET status = 'verified', verified_by = ?, verified_at = datetime('now') WHERE id = ?`).run(user.id, run.id);
      logAudit(user.id, 'verify', 'payroll_run', run.id, null);
    }
    return redirect(res, `/payroll/${payrollVerifyMatch[1]}`);
  }
  const payrollSiteVerifyMatch = pathname.match(/^\/payroll\/(\d+)\/sites\/(\d+)\/verify$/);
  if (payrollSiteVerifyMatch && req.method === 'POST') {
    if (!PAYROLL_APPROVE_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const runId = payrollSiteVerifyMatch[1];
    const siteId = payrollSiteVerifyMatch[2];
    const run = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(runId);
    if (run && run.status === 'pending_verification') {
      db.prepare(
        `INSERT INTO payroll_run_site_verifications (payroll_run_id, site_id, verified_by) VALUES (?, ?, ?)
         ON CONFLICT(payroll_run_id, site_id) DO NOTHING`
      ).run(runId, siteId, user.id);
      logAudit(user.id, 'verify_site', 'payroll_run', runId, `site ${siteId}`);
      const totalSites = db
        .prepare(
          `SELECT COUNT(DISTINCT pis.site_id) c FROM payroll_item_sites pis JOIN payroll_items pi ON pi.id = pis.payroll_item_id WHERE pi.payroll_run_id = ?`
        )
        .get(runId).c;
      const verifiedSites = db.prepare('SELECT COUNT(*) c FROM payroll_run_site_verifications WHERE payroll_run_id = ?').get(runId).c;
      if (totalSites > 0 && verifiedSites >= totalSites) {
        db.prepare(`UPDATE payroll_runs SET status = 'verified', verified_by = ?, verified_at = datetime('now') WHERE id = ?`).run(user.id, runId);
        logAudit(user.id, 'verify', 'payroll_run', runId, 'all sites verified');
      }
    }
    return redirect(res, `/payroll/${runId}`);
  }
  const payrollCompleteMatch = pathname.match(/^\/payroll\/(\d+)\/complete$/);
  if (payrollCompleteMatch && req.method === 'POST') {
    if (!PAYROLL_APPROVE_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const run = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(payrollCompleteMatch[1]);
    if (run && run.status === 'verified') {
      db.prepare(`UPDATE payroll_runs SET status = 'completed', completed_by = ?, completed_at = datetime('now') WHERE id = ?`).run(user.id, run.id);
      logAudit(user.id, 'complete', 'payroll_run', run.id, null);
    }
    return redirect(res, `/payroll/${payrollCompleteMatch[1]}`);
  }

  // ---- Sites ----
  if (pathname === '/sites' && req.method === 'GET') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    return send(res, 200, layout({ title: 'Sites', user, currentPath: pathname, body: renderSites() }));
  }
  if (pathname === '/sites' && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const b = reqBody;
    const newSiteInfo = db.prepare('INSERT INTO sites (name, location, address, district, state, maps_link) VALUES (?, ?, ?, ?, ?, ?)').run(
      b.name,
      b.location || null,
      b.address || null,
      b.district || null,
      b.state || null,
      b.maps_link || null
    );
    logAudit(user.id, 'create', 'site', newSiteInfo.lastInsertRowid, b.name);
    return redirect(res, '/sites');
  }
  const siteEditMatch = pathname.match(/^\/sites\/(\d+)\/edit$/);
  if (siteEditMatch && req.method === 'GET') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const s = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteEditMatch[1]);
    if (!s) return send(res, 404, 'Not found');
    return send(res, 200, layout({ title: 'Edit site', user, currentPath: '/sites', body: renderSiteForm(s) }));
  }
  const siteUpdateMatch = pathname.match(/^\/sites\/(\d+)$/);
  if (siteUpdateMatch && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const s = db.prepare('SELECT * FROM sites WHERE id = ?').get(siteUpdateMatch[1]);
    if (!s) return send(res, 404, 'Not found');
    const b = reqBody;
    const status = ['active', 'on_hold', 'completed'].includes(b.status) ? b.status : 'active';
    db.prepare('UPDATE sites SET name = ?, location = ?, status = ?, address = ?, district = ?, state = ?, maps_link = ? WHERE id = ?').run(
      b.name,
      b.location || null,
      status,
      b.address || null,
      b.district || null,
      b.state || null,
      b.maps_link || null,
      siteUpdateMatch[1]
    );
    logAudit(user.id, 'update', 'site', siteUpdateMatch[1], b.name);
    return redirect(res, '/sites');
  }
  // Site hard-delete was removed per Zen's request (v9, same policy as
  // workers) — a site is retired via Status=Completed only, never permanently
  // deleted, regardless of whether anything is attached to it. Any lingering
  // POST to the old /sites/:id/delete URL falls through to the 404 handler at
  // the bottom of the router. (This immediately followed a real bug fix: the
  // old delete route crashed with a raw 500 on a site that had, e.g., an
  // off-day or a PM/SE assignment attached but zero workers/attendance/users
  // — siteDependencyCounts only checked those three tables, not every table
  // with a site_id foreign key. Rather than widen that check further, the
  // capability is gone outright — Completed sites stay fully visible, with
  // their attendance history still queryable by date range, in Attendance
  // History.)
  const siteReassignMatch = pathname.match(/^\/sites\/(\d+)\/reassign-workers$/);
  if (siteReassignMatch && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const sourceId = siteReassignMatch[1];
    const b = reqBody;
    const targetId = b.target_site_id;
    if (targetId && String(targetId) !== String(sourceId)) {
      db.prepare(`UPDATE workers SET site_id = ? WHERE site_id = ? AND status = 'active'`).run(targetId, sourceId);
    }
    return redirect(res, `/sites/${sourceId}/edit`);
  }

  // ---- Site performance (cuts / bonuses / additional payments) ----
  if (pathname === '/site-performance' && req.method === 'GET') {
    if (!OVERSIGHT_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    return send(res, 200, layout({ title: 'Site performance', user, currentPath: pathname, body: renderSitePerformance({ editingId: query.edit, user }) }));
  }
  if (pathname === '/site-performance' && req.method === 'POST') {
    if (!SITE_ADJUSTMENT_MANAGE_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const b = reqBody;
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(b.site_id);
    const adjustmentType = ['cut', 'bonus', 'additional_payment'].includes(b.adjustment_type) ? b.adjustment_type : 'cut';
    const cutPercent = Number(b.cut_percent);
    const flatAmount = Number(b.flat_amount);
    const validPercent = adjustmentType === 'additional_payment' || (Number.isFinite(cutPercent) && cutPercent > 0 && cutPercent <= 100);
    const validFlat = adjustmentType !== 'additional_payment' || (Number.isFinite(flatAmount) && flatAmount > 0);
    const snapped = snapToPayPeriod(b.period_start);
    if (!site || !validPercent || !validFlat || !snapped) {
      return send(
        res,
        400,
        layout({
          title: 'Site performance',
          user,
          currentPath: '/site-performance',
          body: renderSitePerformance({
            error: !site
              ? 'Select a valid site.'
              : !validPercent
              ? 'Percent must be greater than 0 and no more than 100.'
              : !validFlat
              ? 'Flat amount must be a positive number.'
              : 'Enter a valid period start date.',
            values: b,
            user,
          }),
        })
      );
    }
    b.period_start = snapped.start;
    b.period_end = snapped.end;
    const newAdjInfo = db.prepare(
      `INSERT INTO site_performance (site_id, period_start, period_end, adjustment_type, cut_percent, flat_amount, reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      site.id,
      b.period_start,
      b.period_end,
      adjustmentType,
      adjustmentType === 'additional_payment' ? null : cutPercent,
      adjustmentType === 'additional_payment' ? flatAmount : null,
      b.reason || null,
      user.id
    );
    logAudit(user.id, 'create', 'site_performance', newAdjInfo.lastInsertRowid, `${site.name} — ${adjustmentType}`);
    return redirect(res, '/site-performance');
  }
  const sitePerfDeleteMatch = pathname.match(/^\/site-performance\/(\d+)\/delete$/);
  if (sitePerfDeleteMatch && req.method === 'POST') {
    if (!SITE_ADJUSTMENT_MANAGE_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    db.prepare('DELETE FROM site_performance WHERE id = ?').run(sitePerfDeleteMatch[1]);
    logAudit(user.id, 'delete', 'site_performance', sitePerfDeleteMatch[1], null);
    return redirect(res, '/site-performance');
  }
  const sitePerfEditMatch = pathname.match(/^\/site-performance\/(\d+)$/);
  if (sitePerfEditMatch && req.method === 'POST') {
    if (!SITE_ADJUSTMENT_MANAGE_ROLES.includes(user.role)) return forbidden(res, user, pathname, layout);
    const existing = db.prepare('SELECT * FROM site_performance WHERE id = ?').get(sitePerfEditMatch[1]);
    if (!existing) return send(res, 404, 'Not found');
    const b = reqBody;
    const site = db.prepare('SELECT * FROM sites WHERE id = ?').get(b.site_id);
    const adjustmentType = ['cut', 'bonus', 'additional_payment'].includes(b.adjustment_type) ? b.adjustment_type : 'cut';
    const cutPercent = Number(b.cut_percent);
    const flatAmount = Number(b.flat_amount);
    const validPercent = adjustmentType === 'additional_payment' || (Number.isFinite(cutPercent) && cutPercent > 0 && cutPercent <= 100);
    const validFlat = adjustmentType !== 'additional_payment' || (Number.isFinite(flatAmount) && flatAmount > 0);
    const snapped = snapToPayPeriod(b.period_start);
    if (!site || !validPercent || !validFlat || !snapped) {
      return send(
        res,
        400,
        layout({
          title: 'Site performance',
          user,
          currentPath: '/site-performance',
          body: renderSitePerformance({
            error: !site
              ? 'Select a valid site.'
              : !validPercent
              ? 'Percent must be greater than 0 and no more than 100.'
              : !validFlat
              ? 'Flat amount must be a positive number.'
              : 'Enter a valid period start date.',
            values: Object.assign({}, b, { id: existing.id }),
            editingId: existing.id,
            user,
          }),
        })
      );
    }
    b.period_start = snapped.start;
    b.period_end = snapped.end;
    db.prepare(
      `UPDATE site_performance SET site_id = ?, period_start = ?, period_end = ?, adjustment_type = ?, cut_percent = ?, flat_amount = ?, reason = ? WHERE id = ?`
    ).run(
      site.id,
      b.period_start,
      b.period_end,
      adjustmentType,
      adjustmentType === 'additional_payment' ? null : cutPercent,
      adjustmentType === 'additional_payment' ? flatAmount : null,
      b.reason || null,
      existing.id
    );
    logAudit(user.id, 'update', 'site_performance', existing.id, `${site.name} — ${adjustmentType}`);
    return redirect(res, '/site-performance');
  }

  // ---- Users ----
  if (pathname === '/users' && req.method === 'GET') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    return send(res, 200, layout({ title: 'Users', user, currentPath: pathname, body: renderUsers({ actingUser: user, page: pageFromQuery(query) }) }));
  }
  if (pathname === '/users' && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const b = reqBody;
    const contactDigits = digitsOnly(b.contact);
    if (!EMAIL_RE.test((b.username || '').trim())) {
      return send(res, 400, layout({ title: 'Users', user, currentPath: '/users', body: renderUsers({ actingUser: user, error: 'Username must be a valid email address.', values: b }) }));
    }
    if (!PHONE_RE.test(contactDigits)) {
      return send(res, 400, layout({ title: 'Users', user, currentPath: '/users', body: renderUsers({ actingUser: user, error: 'A phone number (at least 10 digits) is required.', values: b }) }));
    }
    if (!ALL_ROLES.includes(b.role)) {
      return send(res, 400, layout({ title: 'Users', user, currentPath: '/users', body: renderUsers({ actingUser: user, error: 'Select a valid role.', values: b }) }));
    }
    const saGuard = superAdminGuardError(user, { submittedRole: b.role });
    if (saGuard) return send(res, 403, layout({ title: 'Users', user, currentPath: '/users', body: renderUsers({ actingUser: user, error: saGuard, values: b }) }));
    if (!b.password || b.password.length < 8) {
      return send(res, 400, layout({ title: 'Users', user, currentPath: '/users', body: renderUsers({ actingUser: user, error: 'Password must be at least 8 characters.', values: b }) }));
    }
    try {
      // v10: none of the seven approved roles carry a single site_id
      // anymore (that was 'supervisor'-only; the two multi-site roles use
      // user_site_assignments via the Site assignments page instead), so
      // this always creates with site_id null now — kept as a real column
      // rather than dropped, since historical supervisor rows still use it.
      const newUserId = auth.createUser({
        username: b.username.trim(),
        password: b.password,
        name: b.name,
        role: b.role,
        site_id: null,
        contact: contactDigits,
        mustChangePassword: !!b.must_change_password,
      });
      logAudit(user.id, 'create', 'user', newUserId, `${b.username.trim()} (role: ${b.role})`);
    } catch (e) {
      return send(res, 400, layout({ title: 'Users', user, currentPath: '/users', body: renderUsers({ actingUser: user, error: 'A user with this username already exists.', values: b }) }));
    }
    return redirect(res, '/users');
  }
  const userEditMatch = pathname.match(/^\/users\/(\d+)\/edit$/);
  if (userEditMatch && req.method === 'GET') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userEditMatch[1]);
    if (!target) return send(res, 404, 'Not found');
    const saGuard = superAdminGuardError(user, { targetRole: target.role });
    if (saGuard) return forbidden(res, user, pathname, layout);
    return send(res, 200, layout({ title: 'Edit user', user, currentPath: '/users', body: renderUserForm(target, { actingUser: user }) }));
  }
  const userUpdateMatch = pathname.match(/^\/users\/(\d+)$/);
  if (userUpdateMatch && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userUpdateMatch[1]);
    if (!target) return send(res, 404, 'Not found');
    const b = reqBody;
    // Checked before any field validation below on purpose — an admin actor
    // editing a super_admin's row, or trying to hand the super_admin role to
    // someone via this form, is rejected outright rather than partially
    // validated first.
    const saGuardEarly = superAdminGuardError(user, { targetRole: target.role, submittedRole: b.role });
    if (saGuardEarly) return send(res, 403, layout({ title: 'Edit user', user, currentPath: '/users', body: renderUserForm(target, { actingUser: user, error: saGuardEarly, values: b }) }));
    const contactDigits = digitsOnly(b.contact);
    if (!EMAIL_RE.test((b.username || '').trim())) {
      return send(res, 400, layout({ title: 'Edit user', user, currentPath: '/users', body: renderUserForm(target, { actingUser: user, error: 'Username must be a valid email address.', values: b }) }));
    }
    if (!PHONE_RE.test(contactDigits)) {
      return send(res, 400, layout({ title: 'Edit user', user, currentPath: '/users', body: renderUserForm(target, { actingUser: user, error: 'A phone number (at least 10 digits) is required.', values: b }) }));
    }
    if (!ALL_ROLES.includes(b.role)) {
      return send(res, 400, layout({ title: 'Edit user', user, currentPath: '/users', body: renderUserForm(target, { actingUser: user, error: 'Select a valid role.', values: b }) }));
    }
    const dupe = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(b.username.trim(), target.id);
    if (dupe) {
      return send(res, 400, layout({ title: 'Edit user', user, currentPath: '/users', body: renderUserForm(target, { actingUser: user, error: 'A user with this username already exists.', values: b }) }));
    }
    db.prepare('UPDATE users SET name = ?, username = ?, contact = ?, role = ?, site_id = ?, must_change_password = ? WHERE id = ?').run(
      b.name,
      b.username.trim(),
      contactDigits,
      b.role,
      null, // v10: no approved role carries a single site_id anymore — see the create route above
      b.must_change_password ? 1 : 0,
      target.id
    );
    if (b.password && b.password.trim()) {
      if (b.password.trim().length < 8) {
        return send(res, 400, layout({ title: 'Edit user', user, currentPath: '/users', body: renderUserForm(target, { actingUser: user, error: 'Password must be at least 8 characters.', values: b }) }));
      }
      const { hash, salt } = auth.hashPassword(b.password.trim());
      db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, target.id);
    }
    logAudit(user.id, 'update', 'user', target.id, `${b.username.trim()} (role: ${b.role})`);
    return redirect(res, '/users');
  }
  const userToggleMatch = pathname.match(/^\/users\/(\d+)\/toggle$/);
  if (userToggleMatch && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userToggleMatch[1]);
    if (target) {
      const saGuard = superAdminGuardError(user, { targetRole: target.role });
      if (saGuard) {
        return send(res, 403, layout({ title: 'Users', user, currentPath: '/users', flash: { type: 'error', message: saGuard }, body: renderUsers({ actingUser: user }) }));
      }
      const disabling = !!target.active;
      // v10 fix: this route only ever flips `active` — it never touches
      // `role`. A historical account whose role predates the v10 reduction
      // (e.g. 'supervisor') keeps that value in the DB indefinitely (the
      // CHECK constraint still allows it, on purpose, so old audit/history
      // rows keep attributing correctly — see permissions.js's module
      // comment). Toggling ENABLE on such a row would silently resurrect a
      // removed role's ability to log in, defeating the "exactly seven
      // roles" guarantee this whole migration exists to enforce. Only
      // ENABLE is blocked here — disabling (or leaving as-is) a legacy-role
      // row is always fine, since that's strictly reducing access.
      if (!disabling && !ALL_ROLES.includes(target.role)) {
        return send(
          res,
          400,
          layout({
            title: 'Users',
            user,
            currentPath: '/users',
            flash: {
              type: 'error',
              message: `${target.username}'s role ("${ROLE_LABEL[target.role] || target.role}") was removed in v10 and can no longer be re-enabled directly. Change their role to one of the seven current roles via Edit first, then re-enable.`,
            },
            body: renderUsers({ actingUser: user }),
          })
        );
      }
      if (disabling && target.id === user.id) {
        return send(
          res,
          400,
          layout({
            title: 'Users',
            user,
            currentPath: '/users',
            flash: { type: 'error', message: "You can't disable your own account." },
            body: renderUsers({ actingUser: user }),
          })
        );
      }
      if (disabling && target.role === 'admin') {
        const otherActiveAdmins = db
          .prepare(`SELECT COUNT(*) c FROM users WHERE role = 'admin' AND active = 1 AND id != ?`)
          .get(target.id).c;
        if (otherActiveAdmins === 0) {
          return send(
            res,
            400,
            layout({
              title: 'Users',
              user,
              currentPath: '/users',
              flash: { type: 'error', message: 'This is the last active admin account — disabling it would lock everyone out. Make another user an active admin first.' },
              body: renderUsers({ actingUser: user }),
            })
          );
        }
      }
      // v10: parallel safety net for super_admin — independent of the admin
      // count above, since Super Admin's protection is about there always
      // being at least one active super_admin, not about admin at all.
      if (disabling && target.role === 'super_admin') {
        const otherActiveSuperAdmins = db
          .prepare(`SELECT COUNT(*) c FROM users WHERE role = 'super_admin' AND active = 1 AND id != ?`)
          .get(target.id).c;
        if (otherActiveSuperAdmins === 0) {
          return send(
            res,
            400,
            layout({
              title: 'Users',
              user,
              currentPath: '/users',
              flash: { type: 'error', message: 'This is the last active Super Admin account — disabling it would leave nobody able to manage Super Admin accounts. Promote another user to Super Admin first.' },
              body: renderUsers({ actingUser: user }),
            })
          );
        }
      }
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(target.active ? 0 : 1, target.id);
      logAudit(user.id, target.active ? 'disable_user' : 'enable_user', 'user', target.id, `${target.username} (role: ${target.role})`);
    }
    return redirect(res, '/users');
  }

  // v10.1: hard delete, added alongside deactivate per Zen's request — but
  // only ever permitted when it's actually safe. `users(id)` is referenced
  // by REFERENCES-constrained columns across 9 tables (audit_log.user_id,
  // attendance.marked_by, payroll_runs.*_by, payroll_run_site_verifications
  // .verified_by, site_off_days.created_by, site_performance.created_by,
  // worker_skill_ratings.rated_by, sessions.user_id, user_site_assignments
  // .user_id), and PRAGMA foreign_keys = ON (db.js) means SQLite itself
  // refuses the DELETE if any of those still point at this row — the same
  // backstop the app already relies on for "never orphan a foreign key"
  // elsewhere. This route deletes the account's own sessions and site
  // assignments first (pure current-state, not history — same as what
  // reassigning/deactivating already discards), then attempts the actual
  // DELETE inside a transaction; if SQLite rejects it (real audit/
  // attendance/payroll history exists), everything rolls back and the admin
  // gets the same "deactivate instead" guidance the app already uses for
  // workers and sites, rather than a raw DB error.
  const userDeleteMatch = pathname.match(/^\/users\/(\d+)\/delete$/);
  if (userDeleteMatch && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(userDeleteMatch[1]);
    if (!target) return redirect(res, '/users');
    const saGuard = superAdminGuardError(user, { targetRole: target.role });
    if (saGuard) {
      return send(res, 403, layout({ title: 'Users', user, currentPath: '/users', flash: { type: 'error', message: saGuard }, body: renderUsers({ actingUser: user }) }));
    }
    if (target.id === user.id) {
      return send(res, 400, layout({ title: 'Users', user, currentPath: '/users', flash: { type: 'error', message: "You can't delete your own account." }, body: renderUsers({ actingUser: user }) }));
    }
    if (target.active && target.role === 'admin') {
      const otherActiveAdmins = db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'admin' AND active = 1 AND id != ?`).get(target.id).c;
      if (otherActiveAdmins === 0) {
        return send(res, 400, layout({ title: 'Users', user, currentPath: '/users', flash: { type: 'error', message: 'This is the last active admin account — deleting it would lock everyone out. Make another user an active admin first.' }, body: renderUsers({ actingUser: user }) }));
      }
    }
    if (target.active && target.role === 'super_admin') {
      const otherActiveSuperAdmins = db.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'super_admin' AND active = 1 AND id != ?`).get(target.id).c;
      if (otherActiveSuperAdmins === 0) {
        return send(res, 400, layout({ title: 'Users', user, currentPath: '/users', flash: { type: 'error', message: 'This is the last active Super Admin account — deleting it would leave nobody able to manage Super Admin accounts. Promote another user to Super Admin first.' }, body: renderUsers({ actingUser: user }) }));
      }
    }
    let deleted = false;
    let fkBlocked = false;
    db.exec('BEGIN TRANSACTION;');
    try {
      // Backed up into the audit trail itself (id/username/role/active/
      // created_at) BEFORE the delete — this row only persists if the
      // whole transaction (including the DELETE below) actually commits,
      // so a blocked delete leaves no dangling "deleted" record behind.
      logAudit(
        user.id,
        'delete',
        'user',
        target.id,
        `${target.username} (role: ${target.role}, was ${target.active ? 'active' : 'disabled'}, created ${target.created_at}) — permanently deleted`
      );
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM user_site_assignments WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
      db.exec('COMMIT;');
      deleted = true;
    } catch (e) {
      db.exec('ROLLBACK;');
      fkBlocked = /FOREIGN KEY/i.test(e.message || '');
      if (!fkBlocked) throw e; // an unexpected error — never swallow silently
    }
    if (!deleted) {
      return send(
        res,
        400,
        layout({
          title: 'Users',
          user,
          currentPath: '/users',
          flash: {
            type: 'error',
            message: `${target.username} has attendance, payroll, audit, or other historical records attached and can't be permanently deleted without losing that history. Deactivate the account instead — it stays visible for audit purposes but can no longer log in.`,
          },
          body: renderUsers({ actingUser: user }),
        })
      );
    }
    return redirect(res, '/users');
  }

  // ---- Audit log ----
  if (pathname === '/audit-log' && req.method === 'GET') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    return send(res, 200, layout({ title: 'Audit log', user, currentPath: pathname, body: renderAuditLog(query) }));
  }

  // ---- Site assignments (Project Managers / Site Engineers -> many sites) ----
  if (pathname === '/site-assignments' && req.method === 'GET') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    return send(
      res,
      200,
      layout({
        title: 'Site assignments',
        user,
        currentPath: pathname,
        body: renderSiteAssignments({ savedSummary: query.saved ? decodeURIComponent(query.saved) : null }),
      })
    );
  }
  if (pathname === '/site-assignments' && req.method === 'POST') {
    if (!can(user, 'admin.full')) return forbidden(res, user, pathname, layout);
    const b = reqBody;
    // One submit carries EVERY person's checkboxes (named u<userId>_site_<siteId>
    // — the form parser doesn't collect repeated keys into arrays, so each
    // box gets a unique name). Rebuild every PM/SE's assignment set in a
    // single transaction so the whole page saves atomically — no more losing
    // one person's changes by saving another's.
    const people = db.prepare(`SELECT * FROM users WHERE role IN ('project_manager','site_engineer')`).all();
    const summaryParts = [];
    db.exec('BEGIN TRANSACTION');
    try {
      const del = db.prepare('DELETE FROM user_site_assignments WHERE user_id = ?');
      const insert = db.prepare('INSERT INTO user_site_assignments (user_id, site_id) VALUES (?, ?)');
      for (const p of people) {
        const re = new RegExp(`^u${p.id}_site_(\\d+)$`);
        const siteIds = Object.keys(b)
          .map((k) => k.match(re))
          .filter(Boolean)
          .map((m) => Number(m[1]));
        del.run(p.id);
        for (const sid of siteIds) insert.run(p.id, sid);
        summaryParts.push(`${p.name}: ${siteIds.length} site(s)`);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    logAudit(user.id, 'update', 'site_assignments', null, summaryParts.join(' · '));
    return redirect(res, `/site-assignments?saved=${encodeURIComponent(summaryParts.join(' · '))}`);
  }

  send(res, 404, layout({ title: 'Not found', user, currentPath: pathname, body: '<div class="card"><h1>404</h1><p>Page not found.</p></div>' }));
}

module.exports = { handleRequest };
