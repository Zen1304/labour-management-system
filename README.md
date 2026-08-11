# Labour Management System — Prototype

A working prototype for labour management and attendance workflow: worker records
(direct BilaraGroup + vendor-supplied), vendor/payment routing, multi-site hourly
attendance, and payroll with itemized deductions — with role-based access for
exactly seven supported roles: Super Admin, Admin, Site Engineer, Project
Manager, Labour Manager, HR, and Audit Manager (v10).

## Why this stack

This was built as a **zero-dependency Node.js app** — no `npm install` needed, no
external services required. It uses only Node's built-ins:

- `node:http` for the web server
- `node:sqlite` for the database (built into Node 22.5+, file-based, no setup)
- `node:crypto` for password hashing and session tokens
- Server-rendered HTML (no frontend build step)

This means it runs anywhere with a modern Node.js install, with no network access or
package registry required — useful for a locked-down environment, and easy to swap
out later (see "Growing this into production" below).

## Requirements

- Node.js **22.5 or later** (for built-in `node:sqlite`). Check with `node -v`.

## Running it

```bash
cd labour-management-system
node src/seed.js   # creates data/lms.sqlite and seeds demo data (run once)
node server.js     # starts the server on http://localhost:3000
```

Then open **http://localhost:3000** in your browser.

To reset all data, delete `data/lms.sqlite` and re-run the seed script.

## Demo accounts (seeded)

These are **local demo/seed credentials only** — generated fresh by `src/seed.js`
against a throwaway database, never real account data. Change or remove them before
any real deployment.

| Username         | Password        | Role           | Scope                          |
|-------------------|-----------------|----------------|----------------------------------|
| superadmin1       | superadmin123   | Super Admin    | Everything, incl. managing Super Admin accounts |
| admin             | admin123        | Admin          | Everything except managing Super Admin accounts |
| hr                | hr123           | HR             | Workers, attendance, payroll     |
| labormanager1     | labor123        | Labour Manager | Workers, attendance, payroll, site performance |
| auditmanager1     | audit123        | Audit Manager  | Read-only oversight; payroll verify/complete |
| pm1               | pm123           | Project Manager| Assigned sites (multi-site)      |
| se1               | se123           | Site Engineer  | Assigned sites (multi-site)      |

Seed data includes 3 real sites (101–103) plus the built-in Unassigned Pool (100),
3 vendors (including the built-in "Bilara (Direct)" vendor), 7 worker types, ~27
workers, and 7 days of randomized hourly attendance history — including a couple
of workers still sitting in the Unassigned Pool and one example of a worker who
split a day across two sites.

## What's included

- **Auth & roles** — session-based login (hashed + salted passwords via `scrypt`),
  exactly seven supported roles as of v10 (see `src/permissions.js` for the full
  capability matrix — the single source of truth every route and UI element reads
  from):
  - **Super Admin**: everything Admin has, plus the only role that can create,
    edit, deactivate, or reset a Super Admin account, or grant the Super Admin
    role to anyone. The last active Super Admin can't be deactivated.
  - **Admin**: manages sites, vendors, worker types, users (other than Super
    Admin), workers; views/generates payroll
  - **HR**: manages workers, views attendance, generates payroll
  - **Labour Manager**: manages workers, marks/deletes attendance, generates
    payroll, manages site performance
  - **Audit Manager**: primarily read-only oversight (attendance, payroll,
    reports); verifies and completes payroll runs
  - **Project Manager** / **Site Engineer**: scoped to their assigned sites
    (see Site assignments), view-only across workers/attendance/history for
    those sites
  - A new account can be created with a one-time temporary password that
    forces a password change on first login (`must_change_password`) —
    passwords are never stored or logged in plaintext.
- **Vendors** — every worker belongs to a vendor. Direct BilaraGroup employees use
  the built-in "Bilara (Direct)" vendor; vendor-supplied workers use their supply
  vendor. Payroll payouts are grouped and totaled by vendor, since that's who
  actually gets paid for vendor-supplied labour.
- **Worker types** — an admin-managed list (Mason, Helper, Tile Worker, Electrician,
  Plumber, Welder, Carpenter seeded) so new trades can be added from the UI as the
  workforce mix grows, with no code changes.
- **Site numbering** — site IDs run **100–999**. Site **100** is a permanent,
  undeletable "Unassigned Pool" that every new worker is auto-assigned to; an
  admin/HR user then reassigns them to a real site (101+) from the Edit screen.
  New sites created via the Sites page are auto-numbered upward from 101.
- **Worker records** — name, worker type, vendor, mandatory unique **Aadhar
  number** (validated as 12 digits; duplicate Aadhar numbers are rejected outright,
  both on create and edit), hourly wage rate, overtime multiplier, site, contact.
- **Attendance (hourly, multi-site)** — pay is hourly-only company-wide. Each
  attendance record is one worker + one date + one site, with hours worked, leave
  hours, and overtime hours on the same row — so a 2-hour leave + 6-hour worked day
  is one entry, and a worker splitting a day across two sites gets two entries (one
  per site). The Attendance page offers a bulk grid (mark a whole site's crew for a
  date in one submit) plus a single-entry form for the split-site/leave cases.
  History is filterable by date range and each entry can be deleted.
- **Payroll with deductions** — generate a payroll run for a date range; it sums
  hours/overtime/leave per worker across all sites and dates in range, computes
  base pay (hours × hourly rate) and overtime pay (OT hours × rate × multiplier).
  Each worker's payroll line supports itemized deductions (reason + amount, e.g.
  "Advance repayment"), and net pay = base + overtime − deductions. The run detail
  page also shows a **Payments by vendor** summary, since vendor-supplied workers'
  pay is routed to their vendor, not paid to them directly.
- **Dashboard** — today's attendance %, active worker counts, per-site breakdown,
  and a nudge when workers are still sitting unassigned in the Pool.
- **Sites, Vendors, Worker types & Users management** — admin-only CRUD screens.

## Project structure

```
server.js              Entry point — HTTP server
src/db.js               SQLite schema + connection
src/auth.js               Password hashing, sessions, login/logout
src/app.js                 All routes + page rendering (the bulk of the app)
src/render.js                Shared HTML layout, escaping, formatting helpers
src/helpers.js                 Cookie/body parsing, date utilities
src/seed.js                      Demo data generator
public/style.css                   Styling
data/lms.sqlite                      SQLite database file (created on first seed/run)
```

## Environment variables (production)

Added in v9.8 alongside CSRF protection:

- **`CSRF_SECRET`** — required when `NODE_ENV=production`; the app refuses to start
  without it (or with a value that isn't at least 64 hex characters / 32 random
  bytes). Not required for local/dev use — an ephemeral secret is generated at
  startup automatically when unset outside production, which just means a restart
  invalidates any already-open forms (same "refresh and try again" experience as a
  deliberate rotation, below).
  - **Generate one:** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  - **Multiple instances / restarts:** set the *same* `CSRF_SECRET` value on every
    instance behind your load balancer or process manager, and keep it stable across
    restarts/deploys (e.g. in your process manager's env config, not generated fresh
    per deploy) — a token minted by one instance has to validate on whichever
    instance receives the follow-up POST.
  - **Rotation:** rotating this value immediately invalidates every currently
    rendered page's CSRF token. Anyone with a page open when you rotate will see a
    plain "refresh and try again" message on their next form submission — not an
    error, not data loss, just a refresh. Rotate during a low-traffic window if you
    want to minimize how many people see that message at once.
  - Never logged or exposed on any response — if you need to confirm it's set,
    check your process manager's environment configuration directly, not app output.
- **`COOKIE_SECURE`** — set to `true` once this app is served over HTTPS (directly or
  behind a TLS-terminating proxy) to add the `Secure` flag to the session, CSRF, and
  theme cookies. Leave it unset for local HTTP use — a `Secure` cookie is withheld by
  the browser entirely on a plain HTTP connection, which would silently break login.
- **`NODE_ENV`** — set to `production` in production so the `CSRF_SECRET`
  requirement above is enforced. The automated test suite forces this to `test`
  regardless of the shell it's run from.

## Known limitations of this prototype

- Single SQLite file — fine for a prototype or small deployment, but for 500+
  workers in production you'd want PostgreSQL/MySQL for concurrent writes,
  backups, and replication.
- No CSV/PDF export for payroll/payslips yet.
- Attendance is marked by Admin/HR/Labour Manager (Super Admin included) —
  no biometric/QR integration.
- Leave hours are recorded but currently unpaid in the payroll calculation — flag
  this if paid leave policies apply to some worker categories.
- The bulk attendance grid marks one site at a time; the single-entry form is the
  intended path for a worker who works at two sites in the same day.
- No automated test suite yet — this was manually verified end-to-end via curl and
  a Playwright screenshot walkthrough (login, worker creation with Aadhar
  validation/duplicate rejection, pool→site reassignment, split-site attendance,
  payroll generation, vendor grouping, deductions, and role restrictions).

## Growing this into production

The data model (see `src/db.js`) and route logic (`src/app.js`) are deliberately
plain SQL and vanilla JS, so they translate directly if you later want to move to
a framework like Next.js + Prisma + PostgreSQL, or Django/FastAPI. Natural next
steps, roughly in priority order:
1. Move from SQLite to PostgreSQL for multi-user concurrency at scale.
2. Add CSV/PDF payslip export for payroll runs, itemized by vendor.
3. Add leave requests/approval workflow and shift scheduling.
4. Add an audit trail for attendance edits and payroll changes.
5. Add automated tests (the route logic in `src/app.js` is straightforward to
   unit test once split into smaller handler functions).
6. Revisit the "Payments by vendor" dashboard/segregation view in more depth —
   flagged by Zen as a follow-up discussion, not yet built out.
