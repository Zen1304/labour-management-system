# Labour Management System — Architecture Review
**Date:** 2026-08-10 · **Scope:** full-codebase inspection (async/concurrency, security, performance, maintainability, UX/page structure)

This review was requested as a "think like a solution architect" pass over the whole app, prompted by feedback that the newest page (Skill assessments) felt cluttered. It turned into a full inspection. Findings are grouped by area, most important first. Items marked **FIXED** were corrected and deployed as part of this same review; items marked **BACKLOG** are documented but not yet acted on — flagging them now so nothing gets lost, not because they're urgent.

## 1. Security — FIXED

**Supervisor site-spoofing (IDOR) on attendance routes.** The three attendance-writing routes (`/attendance`, `/attendance/entry`, `/attendance/site-off`, plus the site-off delete route) checked that a user's *role* could mark attendance, but never verified that the `site_id` in the submitted form actually belonged to that supervisor. The page correctly hid the site picker for supervisors, but that's a UI convenience, not a security boundary — the underlying POST trusted whatever `site_id` arrived in the request body. A supervisor could edit the hidden field (or replay/craft a request) and mark attendance, leave, or overtime hours — or an entire site-off day — for a site they have no assignment to, corrupting another site's payroll-relevant records.

Fixed by clamping `site_id` server-side to the supervisor's own assigned site on every write, and by verifying ownership before allowing a supervisor to delete a site-off day. Covered by 8 new regression tests, including a mutation test that confirmed the check fails loudly if the clamp is ever removed.

**Everything else checked and found safe:** all SQL queries use bound parameters (no injection surface found); `esc()` is applied consistently everywhere user data reaches HTML; session tokens are cryptographically random; passwords use per-user-salted scrypt with constant-time comparison; login lockout (8 attempts/15 min) is real; every one of the 36+ POST routes has a permission check as its first statement.

**Residual, not fixed (low priority):** logout is a GET link rather than POST — low-impact (can only force a logout, not a data change) but noted for consistency. No CSRF tokens exist anywhere in the app — acceptable for an internal LAN tool with `SameSite=Lax` cookies, but worth knowing if the app is ever exposed beyond the LAN.

## 2. Concurrency & node:sqlite compatibility — mostly clean, one hardened

The app pairs an async HTTP server with a fully synchronous database (`node:sqlite`'s `DatabaseSync`). This pairing is actually safe by construction here: every route handler awaits the request body exactly once, at the very top, before touching the database — so once a handler resumes, it runs to completion without yielding, and two concurrent requests can never interleave mid-transaction. The "generate the next Worker/Vendor ID" logic, the site-assignments save, and the skill-category creation all either rely on this property correctly or (better) have a database-level UNIQUE constraint as a backstop.

One spot didn't have that backstop: the payroll "duplicate period" check was purely application-level (a `SELECT` followed later by an `INSERT`, with no constraint enforcing it). It was safe today only by convention — nothing awaits in between — but a future change that added any async step there (an external call, a file write) could silently let two concurrent "Generate payroll" clicks create two runs for the same week. **FIXED**: added a partial unique index (`idx_payroll_runs_period_unflagged`) matching the app's own "not flagged" condition exactly, plus a try/catch so a race hits the same friendly error message instead of a raw 500. Verified with a direct database-level test that the constraint actually rejects a duplicate.

**Also fixed:** `package.json`'s `engines` field said `node >= 22.5.0`, but `node:sqlite` required an experimental flag until Node 22.13.0 — any Node install in that gap would fail to start with a confusing flag error. Bumped the stated minimum to `22.13.0`.

## 3. Performance — BACKLOG (not urgent at current scale)

Two N+1 query patterns exist: the Skill assessments worker list runs 2 extra queries per row (up to 200 on a full 100-row page), and the dashboard's vendor comparison table runs 3 queries per vendor with no cap at all. At today's scale (a few hundred workers, a couple dozen vendors) this is milliseconds, not a real problem — flagging for awareness if either list grows an order of magnitude.

**FIXED regardless, since it's cheap and future-proofing:** added indexes on every foreign-key column in the tables that grow continuously — `attendance(worker_id)`, `attendance(site_id, date)`, `workers(site_id/vendor_id/worker_type_id)`, `payroll_items(payroll_run_id/worker_id)`, `payroll_item_sites(payroll_item_id)`, `worker_skill_ratings(worker_id)`. SQLite doesn't auto-index foreign keys, so these were genuinely absent before. Verified present after boot via a new test.

## 4. Maintainability — BACKLOG

`src/app.js` is ~3,700 lines and mixes routing, permission checks, validation, SQL, and full HTML rendering in one file. This isn't broken — `permissions.js` was already split out specifically to stop the class of bug where a route gate and a UI condition drift apart, and that pattern is holding up — but the file's size makes it easy for a second copy of some validation or error-response pattern to get pasted in rather than reused (the repeated `send(res, 400, layout({...}))` boilerplate across POST handlers is the clearest example). Not touched in this pass — a genuine module split (routes vs. renders vs. a shared error-response helper) is a bigger, riskier refactor that deserves its own dedicated pass with full regression coverage, not something to bundle into a feature-driven session.

## 5. UX / page structure — FIXED (the original complaint)

Two pages mixed an occasional admin/setup task with the daily operational workflow on the same page:

- **Skill assessments** (`/skill-assessments`) had "Manage skill categories" (admin, rare) on the same page as "rate a worker" (everyone with access, daily). **Fixed**: category management is now its own page, `/skill-assessments/categories`, linked from the main page — the same pattern the app already uses for `/worker-types` being separate from `/workers`.
- **Mark attendance** (`/attendance`) had "Site off days" (occasional) glued onto the daily bulk-marking grid. **Fixed**: it's now its own page, `/attendance/site-off`, linked from the main page the same way.

Every other page was checked against this pattern and found to already be reasonably single-purpose (vendors, sites, worker types, users, site assignments, site performance, payroll, audit log) — the app wasn't deliberately minimizing page count, these two had just organically grown a second concern over successive feature additions. No other instances found.

## Summary of what shipped in this pass

| Area | Change |
|---|---|
| Security | Supervisor site-spoofing (IDOR) closed on 4 attendance routes |
| Concurrency | Payroll-period race backstop added (DB constraint + friendly error) |
| Compatibility | `package.json` engines range corrected for `node:sqlite` |
| Performance | 9 missing indexes added on hot foreign-key columns |
| UX | Skill categories and Site off days each split into their own page |

Regression suite: 504/504 passing, including 15 new checks written for this pass (IDOR fixes, page-split routing, index/constraint verification), each confirmed to actually catch its corresponding regression via mutation testing before being trusted.
