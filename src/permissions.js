'use strict';

// ---------------------------------------------------------------------------
// Single source of truth for who can do what.
//
// Every route gate in app.js AND every piece of conditional UI (nav groups,
// buttons, forms, action links) derives from this one matrix, so the server's
// rules and what each role sees on screen can never drift apart. The v8.4
// verify-button fix and the v9 attendance-delete/site-performance/deduction
// UI-gating fixes were all the same class of bug — a route gate and a render
// condition maintained separately, disagreeing. This module removes the
// "separately".
//
// To change what a role can do, edit ONLY this table. Route gates and UI
// both follow automatically.
//
// v10 role reduction (per Zen, security/architecture review): the
// application now supports exactly seven roles — super_admin, admin,
// site_engineer, project_manager, labor_manager, hr, audit_manager.
// 'supervisor', 'operation_head', and 'ceo' are no longer selectable or
// grantable anywhere in the app; they're deliberately still valid values in
// the users.role DB CHECK constraint (see db.js) and still have entries in
// ROLE_LABEL below purely so a handful of deactivated historical accounts
// (and any attendance/audit rows attributed to them) keep rendering a real
// label instead of a raw slug — they are not part of ROLES and cannot be
// assigned to anyone going forward.
// ---------------------------------------------------------------------------

const ROLES = ['super_admin', 'admin', 'site_engineer', 'project_manager', 'labor_manager', 'hr', 'audit_manager'];

const ROLE_LABEL = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  hr: 'HR',
  project_manager: 'Project Manager',
  site_engineer: 'Site Engineer',
  labor_manager: 'Labour Manager', // internal identifier kept as-is (established, referenced by stored rows); display label only
  audit_manager: 'Audit Manager',
  // Historical/removed — retained ONLY so old rows still render a label.
  // Never added to ROLES; never a valid target for create/edit.
  supervisor: 'Supervisor',
  operation_head: 'Operation Head',
  ceo: 'CEO',
};

// Company-wide oversight (dashboards with analytics, payroll pages,
// site-performance pages — read access). Site Engineer and Project Manager
// are NOT here: they get site/project-scoped views instead of company-wide
// financials. super_admin is included as a strict superset of admin's
// access everywhere in this file — see the module comment above.
const OVERSIGHT = ['super_admin', 'admin', 'hr', 'labor_manager', 'audit_manager'];

// capability -> roles allowed. Keep alphabetical-ish by area for scanability.
const CAPABILITIES = {
  // Workers
  'workers.manage': ['super_admin', 'admin', 'hr', 'labor_manager'], // add/edit/assign-to-site/absorb (v8.4)
  'workers.verify': ['super_admin', 'admin', 'hr'], // Aadhar identity check-off stays HR/Admin (v7/v8.4)
  'workers.skill_assess': ['super_admin', 'admin', 'hr', 'labor_manager'], // per-category skill ratings (v9.2)
  'skillcategories.manage': ['super_admin', 'admin'], // define which skill categories exist per worker type

  // Attendance
  // v10: 'supervisor' removed (role retired). Zen's explicit choice: field
  // attendance marking moves to Admin + HR (unchanged) plus Labour Manager
  // (new) rather than inventing a replacement site-level role.
  'attendance.mark': ['super_admin', 'admin', 'hr', 'labor_manager'],
  'attendance.delete': ['super_admin', 'admin', 'hr', 'labor_manager'], // remove a history entry (v9, per Zen)

  // Payroll & site performance
  'payroll.view': OVERSIGHT,
  'payroll.generate': ['super_admin', 'admin', 'labor_manager'], // generate runs, flag runs, add item deductions
  'payroll.approve': ['super_admin', 'admin', 'audit_manager'], // verify sites, complete runs
  'siteperf.view': OVERSIGHT,
  'siteperf.manage': ['super_admin', 'admin', 'labor_manager'], // log/edit/remove cuts, bonuses, additional payments

  // Analytics (the /analytics page, split out of the Dashboard in v9.9)
  'analytics.view': OVERSIGHT,

  // Administration (sites, vendors, worker types, users, site assignments,
  // audit log). Additional Super-Admin-only restrictions on TOP of this
  // capability (who may touch a super_admin account, self-promotion, the
  // last-active-super_admin safety net) live as explicit checks in app.js's
  // /users routes — they're actor-vs-target comparisons, not a plain
  // role-list, so they don't fit this table's shape.
  'admin.full': ['super_admin', 'admin'],
};

// Roles whose data visibility is scoped to a set of assigned sites rather
// than company-wide, via user_site_assignments (many-to-many).
const MULTI_SITE_ROLES = ['project_manager', 'site_engineer'];

function can(user, capability) {
  if (!user) return false;
  const allowed = CAPABILITIES[capability];
  if (!allowed) throw new Error(`Unknown capability: ${capability}`); // typo guard — fail loud in dev, never silently deny
  return allowed.includes(user.role);
}

module.exports = {
  ROLES,
  ROLE_LABEL,
  CAPABILITIES,
  MULTI_SITE_ROLES,
  can,
  // Legacy-named role groups, derived from the matrix above so existing
  // call sites keep working while reading from the single source of truth.
  OVERSIGHT_ROLES: CAPABILITIES['analytics.view'],
  PAYROLL_GENERATE_ROLES: CAPABILITIES['payroll.generate'],
  PAYROLL_APPROVE_ROLES: CAPABILITIES['payroll.approve'],
  SITE_ADJUSTMENT_MANAGE_ROLES: CAPABILITIES['siteperf.manage'],
  ATTENDANCE_MARK_ROLES: CAPABILITIES['attendance.mark'],
  WORKER_MANAGE_ROLES: CAPABILITIES['workers.manage'],
  WORKER_VERIFY_ROLES: CAPABILITIES['workers.verify'],
};
