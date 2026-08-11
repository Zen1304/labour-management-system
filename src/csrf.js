'use strict';
// ---------------------------------------------------------------------------
// CSRF protection (v9.8).
//
// Design: a synchronizer token derived from an "identity" string — the
// session token for a logged-in user, or a dedicated anonymous cookie for the
// one pre-login form (POST /login). The token itself is never stored: it's
// HMAC-SHA256(secret, identity), so verifying it just means recomputing the
// same HMAC from the current request's own cookies and comparing. No new
// database table or column, no per-token bookkeeping to expire.
//
// Binding to identity is what makes "tokens from another session fail" true
// for free: a token minted for session A only ever equals HMAC(secret, A),
// so replaying it against a request carrying session B's cookie recomputes a
// different expected value and fails the comparison.
//
// This is NOT a defense against XSS. If an attacker can run script in this
// origin, they can read the <meta name="csrf-token"> tag or the DOM-injected
// hidden field directly and submit it like any other legitimate request —
// CSRF tokens only ever defend against a *different* origin forging a
// request using the browser's ambient cookies, not against script already
// running on this one.
// ---------------------------------------------------------------------------

const crypto = require('node:crypto');

const ANON_COOKIE = 'csrf_anon';
const MIN_SECRET_HEX_LEN = 64; // 32 bytes, hex-encoded
// A submitted token is a hex-encoded SHA-256 HMAC: always exactly 64 hex
// chars. Anything wildly longer than that is either garbage or an attempt to
// abuse the comparison path, so it's rejected before it ever reaches
// timingSafeEqual — belt-and-braces alongside the length check inside
// safeEqual below.
const MAX_TOKEN_LEN = 512;

function resolveSecret() {
  const fromEnv = process.env.CSRF_SECRET;
  const isProd = process.env.NODE_ENV === 'production';

  if (fromEnv) {
    if (!/^[0-9a-fA-F]+$/.test(fromEnv) || fromEnv.length < MIN_SECRET_HEX_LEN) {
      // Wrong-shaped secret is worse than a missing one — it *looks*
      // configured. Fail loudly in every environment, not just production.
      throw new Error(
        `CSRF_SECRET is set but invalid: expected a hex string of at least ${MIN_SECRET_HEX_LEN} characters ` +
          `(32 random bytes). Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
      );
    }
    return Buffer.from(fromEnv, 'hex');
  }

  if (isProd) {
    // No fallback in production — a silently-generated per-process secret
    // would (a) differ across instances behind a load balancer, breaking
    // legitimate users at random, and (b) reset on every restart/deploy,
    // invalidating every open form. Both are worse than refusing to boot.
    throw new Error(
      'CSRF_SECRET is required when NODE_ENV=production. Generate one with: ' +
        `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" and set it identically ` +
        'on every instance of this app (see README for rotation notes).'
    );
  }

  // Dev/test: an ephemeral per-process secret is fine — it only means a
  // restart invalidates in-flight forms, which is the same "refresh and
  // retry" experience a rotation causes in production, just automatic and
  // low-stakes locally.
  return crypto.randomBytes(32);
}

// Resolved once at module load (server startup), not per-request — matches
// how auth.js's session TTL and the rest of the app's config-at-boot pattern
// works. Never logged, never exposed on any response.
const SECRET = resolveSecret();

function csrfToken(identity) {
  if (!identity || typeof identity !== 'string') return null;
  return crypto.createHmac('sha256', SECRET).update(identity).digest('hex');
}

// timingSafeEqual throws on a length mismatch instead of returning false, so
// every caller in this codebase that needs a constant-time string compare
// (auth.js's verifyPassword included) has to guard the length first. Kept
// here too, self-contained, so a bad/missing submitted value can never throw
// past validation and accidentally short-circuit into an unhandled rejection
// that a route might not expect.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bufB = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  if (bufA.length === 0) return false; // two empty strings must never "match"
  return crypto.timingSafeEqual(bufA, bufB);
}

// Verifies a submitted token against the token this identity should have.
// Rejects missing/malformed/oversized input up front (never even reaches the
// HMAC compare), and cross-session or stale tokens fail the compare itself.
function verifyCsrf(identity, submitted) {
  if (!identity || typeof identity !== 'string') return false;
  if (typeof submitted !== 'string' || !submitted) return false;
  if (submitted.length > MAX_TOKEN_LEN) return false;
  const expected = csrfToken(identity);
  if (!expected) return false;
  return safeEqual(expected, submitted);
}

module.exports = { ANON_COOKIE, csrfToken, verifyCsrf, safeEqual };
