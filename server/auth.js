'use strict';
// Password login helpers. Uses Node's built-in scrypt, so no extra dependency.
// Stored format: scrypt$<saltHex>$<hashHex>
const crypto = require('crypto');

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= MIN_PASSWORD && pw.length <= MAX_PASSWORD;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  if (typeof pw !== 'string' || !stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(pw, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Limits password guessing: after 5 wrong passwords for one number, block that number for 15 minutes.
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
const failures = new Map(); // phone -> { count, lockedUntil }

function isLocked(phone) {
  const f = failures.get(phone);
  return !!(f && f.lockedUntil && f.lockedUntil > Date.now());
}
function recordFailure(phone) {
  const f = failures.get(phone) || { count: 0, lockedUntil: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS) { f.lockedUntil = Date.now() + LOCK_MS; f.count = 0; }
  failures.set(phone, f);
}
function clearFailures(phone) { failures.delete(phone); }

module.exports = { MIN_PASSWORD, validPassword, hashPassword, verifyPassword, isLocked, recordFailure, clearFailures };
