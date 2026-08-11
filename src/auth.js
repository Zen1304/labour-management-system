'use strict';
const crypto = require('node:crypto');
const { pool, nowSqliteStyle } = require('./db');

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function createUser({ username, password, name, role, site_id, contact, mustChangePassword }) {
  const { hash, salt } = hashPassword(password);
  const result = await pool.query(
    `INSERT INTO users (username, password_hash, salt, name, role, site_id, contact, must_change_password, active, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9) RETURNING id`,
    [username, hash, salt, name, role, site_id || null, contact || null, mustChangePassword ? 1 : 0, nowSqliteStyle()]
  );
  return result.rows[0].id;
}

// v10: for one-time temporary passwords (new accounts, and password resets
// via the Edit User form) rather than an admin hand-typing something
// memorable. crypto.randomInt over a fixed, unambiguous alphabet (no
// 0/O/1/l/I) — long enough to be a strong one-time secret, short enough to
// read aloud or retype once before the recipient is forced to replace it
// with their own password on first login (see the must_change_password gate
// in app.js). Never logged, never written to any file — the only place a
// generated value should ever appear in plaintext is the one-time report to
// whoever is setting up the account.
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function generateTempPassword(length) {
  const len = length || 16;
  let out = '';
  for (let i = 0; i < len; i++) {
    out += TEMP_PASSWORD_ALPHABET[crypto.randomInt(TEMP_PASSWORD_ALPHABET.length)];
  }
  return out;
}

async function findUserByUsername(username) {
  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return rows[0];
}

async function findUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0];
}

// Login lockout: 8 failed attempts for a username locks it out for 15
// minutes, regardless of source IP — deliberately simple for a small
// internal user base rather than a full IP-based rate limiter.
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

async function isLockedOut(username) {
  const { rows } = await pool.query('SELECT * FROM login_attempts WHERE username = $1', [username]);
  const row = rows[0];
  if (!row || !row.locked_until) return false;
  if (new Date(row.locked_until).getTime() <= Date.now()) return false;
  return true;
}

async function recordFailedAttempt(username) {
  const { rows } = await pool.query('SELECT * FROM login_attempts WHERE username = $1', [username]);
  const row = rows[0];
  const count = (row ? row.failed_count : 0) + 1;
  const lockedUntil = count >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS).toISOString() : row ? row.locked_until : null;
  await pool.query(
    `INSERT INTO login_attempts (username, failed_count, locked_until) VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET failed_count = EXCLUDED.failed_count, locked_until = EXCLUDED.locked_until`,
    [username, count, lockedUntil]
  );
}

async function clearFailedAttempts(username) {
  await pool.query('DELETE FROM login_attempts WHERE username = $1', [username]);
}

async function login(username, password) {
  if (await isLockedOut(username)) return { locked: true };
  const user = await findUserByUsername(username);
  if (!user || !user.active) {
    await recordFailedAttempt(username);
    return null;
  }
  if (!verifyPassword(password, user.salt, user.password_hash)) {
    await recordFailedAttempt(username);
    return null;
  }
  await clearFailedAttempts(username);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await pool.query('INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)', [
    token,
    user.id,
    expiresAt,
    nowSqliteStyle(),
  ]);
  return token;
}

async function logout(token) {
  await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

async function getUserFromToken(token) {
  if (!token) return null;
  const { rows } = await pool.query('SELECT * FROM sessions WHERE token = $1', [token]);
  const session = rows[0];
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    return null;
  }
  const user = await findUserById(session.user_id);
  // v10 fix: deactivating a user previously only blocked *new* logins —
  // login() already checked user.active, but this function (called on
  // every single request to resolve "who is this session") never did, so
  // someone already logged in stayed fully logged in until their 12-hour
  // session naturally expired. Deactivation now takes effect immediately:
  // the session row itself is cleaned up too, rather than left to expire on
  // its own, so a background admin action visibly and immediately signs the
  // person out instead of quietly leaving a live-but-orphaned session.
  if (!user || !user.active) {
    await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    return null;
  }
  return user;
}

module.exports = {
  hashPassword,
  verifyPassword,
  createUser,
  generateTempPassword,
  findUserByUsername,
  findUserById,
  login,
  logout,
  getUserFromToken,
};
