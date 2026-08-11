'use strict';

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtMoney(n) {
  n = Number(n) || 0;
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Role labels and the capability matrix come from permissions.js — a leaf
// module both this file and app.js can require without a circular import, so
// the nav below is driven by exactly the same rules the route gates enforce.
const { ROLE_LABEL, can } = require('./permissions');

function navLink(href, label, currentPath, icon) {
  const active = currentPath === href ? ' class="active"' : '';
  return `<a href="${href}"${active}>${icon ? `<span class="nav-icon">${icon}</span>` : ''}<span>${label}</span></a>`;
}

function navGroup(title, linksHtml) {
  return `<div class="nav-group"><div class="nav-group-title">${title}</div>${linksHtml}</div>`;
}

function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
}

// Light/dark toggle link — GET, no permission needed (works even logged
// out, on the login page), just flips the "theme" cookie and bounces back to
// wherever the user was. `returnPath` round-trips through the query string
// rather than relying on a Referer header, which isn't always sent.
function themeToggleLink(theme, returnPath, extraClass) {
  const next = theme === 'dark' ? 'light' : 'dark';
  const icon = theme === 'dark' ? '&#9728;' : '&#127769;'; // sun / crescent moon
  const label = theme === 'dark' ? 'Light mode' : 'Dark mode';
  return `<a href="/theme/toggle?theme=${next}&return=${encodeURIComponent(returnPath || '/')}" class="theme-toggle${
    extraClass ? ` ${extraClass}` : ''
  }" title="Switch to ${label.toLowerCase()}"><span class="nav-icon">${icon}</span><span>${label}</span></a>`;
}

function layout({ title, user, currentPath, body, flash, theme, csrfToken }) {
  const resolvedTheme = theme === 'dark' ? 'dark' : 'light';
  const sidebar = user
    ? `
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">L</span>
        <span class="brand-name">Labour<br>Management</span>
      </div>
      <nav class="nav">
        ${navGroup(
          'Overview',
          [
            navLink('/', 'Dashboard', currentPath, '&#9673;'),
            navLink('/workers', 'Workers', currentPath, '&#128101;'),
            can(user, 'workers.skill_assess') ? navLink('/skill-assessments', 'Skill assessments', currentPath, '&#127942;') : '',
            can(user, 'attendance.mark')
              ? navLink('/attendance', 'Attendance', currentPath, '&#128197;')
              : navLink('/attendance/history', 'Attendance', currentPath, '&#128197;'),
          ].join('')
        )}
        ${
          can(user, 'payroll.view')
            ? navGroup(
                'Payroll',
                [
                  navLink('/payroll', 'Payroll', currentPath, '&#128181;'),
                  navLink('/site-performance', 'Site performance', currentPath, '&#128200;'),
                ].join('')
              )
            : ''
        }
        ${
          // Hidden entirely (no group heading) rather than shown-but-empty
          // when the only item it could ever hold isn't visible to this
          // role — same "don't render a heading over nothing" rule the
          // Payroll and Administration groups already follow above.
          can(user, 'analytics.view')
            ? navGroup('Reports', [navLink('/analytics', 'Analytics', currentPath, '&#128202;')].join(''))
            : ''
        }
        ${
          can(user, 'admin.full')
            ? navGroup(
                'Administration',
                [
                  navLink('/sites', 'Sites', currentPath, '&#127959;'),
                  navLink('/vendors', 'Vendors', currentPath, '&#129309;'),
                  navLink('/worker-types', 'Worker types', currentPath, '&#127991;'),
                  navLink('/users', 'Users', currentPath, '&#128100;'),
                  navLink('/site-assignments', 'Site assignments', currentPath, '&#128204;'),
                  navLink('/audit-log', 'Audit log', currentPath, '&#128220;'),
                ].join('')
              )
            : ''
        }
        ${navGroup('Display', [themeToggleLink(resolvedTheme, currentPath)].join(''))}
      </nav>
      <div class="sidebar-user">
        <span class="avatar">${esc(initials(user.name))}</span>
        <div class="sidebar-user-info">
          <span class="sidebar-user-name">${esc(user.name)}</span>
          <span class="role-badge">${esc(ROLE_LABEL[user.role] || user.role)}</span>
        </div>
        <form method="POST" action="/logout" class="logout-form">
          <button type="submit" class="logout-link" title="Log out">&#10140;</button>
        </form>
      </div>
    </aside>`
    : '';

  const flashHtml = flash ? `<div class="flash flash-${flash.type}">${esc(flash.message)}</div>` : '';
  // Logged-out pages (just the login screen) have no sidebar to hold the
  // toggle, so it gets a small floating one instead.
  const loggedOutToggle = !user ? themeToggleLink(resolvedTheme, currentPath, 'theme-toggle-floating') : '';

  return `<!DOCTYPE html>
<html lang="en" data-theme="${resolvedTheme}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="csrf-token" content="${esc(csrfToken || '')}">
<title>${esc(title)} · LMS</title>
<link rel="stylesheet" href="/style.css">
</head>
<body class="${user ? 'has-sidebar' : ''}">
${sidebar}
${loggedOutToggle}
<main class="container">
${flashHtml}
${body}
</main>
${csrfInjectScript}
</body>
</html>`;
}

// Every mutation in this app is a plain HTML POST form (no fetch/XHR
// anywhere), so the one thing every such form needs is a hidden `_csrf`
// field carrying this page's token. Rather than hand-adding that field to
// each of the 30+ form blocks scattered across app.js — real risk of a new
// form someday forgetting it — this runs once per page and stamps it onto
// every POST form already in the DOM by the time this script tag runs
// (script tags execute in document order, after the markup above them has
// already been parsed, so no DOMContentLoaded listener is needed — same
// assumption the existing pay-period-snap script already relies on).
//
// If the token is missing (e.g. it expired between page load and submit, or
// something upstream stripped the meta tag), forms are deliberately left
// alone rather than sent with a bad field: the server-side check rejects a
// missing/invalid token with a plain "refresh and try again" page, which is
// the same safe-fail outcome as sending a wrong one.
const csrfInjectScript = `<script>
(function () {
  var meta = document.querySelector('meta[name="csrf-token"]');
  var token = meta ? meta.getAttribute('content') : '';
  if (!token) return;
  var forms = document.querySelectorAll('form');
  for (var i = 0; i < forms.length; i++) {
    var f = forms[i];
    if ((f.getAttribute('method') || 'get').toLowerCase() !== 'post') continue;
    if (f.querySelector('input[name="_csrf"]')) continue;
    var input = document.createElement('input');
    input.type = 'hidden';
    input.name = '_csrf';
    input.value = token;
    f.appendChild(input);
  }
})();
</script>`;

module.exports = { esc, fmtMoney, layout };
