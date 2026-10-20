'use strict';
// Crypto for the device build. Same algorithms as Node: scrypt (N=16384, r=8, p=1) and secure random bytes.
const { scrypt } = require('@noble/hashes/scrypt');
const { Buffer } = require('buffer');

function randomBytes(n) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  return Buffer.from(a);
}

function randomInt(min, max) {
  const range = max - min;
  const a = new Uint32Array(1);
  globalThis.crypto.getRandomValues(a);
  return min + (a[0] % range);
}

function scryptSync(password, salt, keylen) {
  const pw = typeof password === 'string' ? new TextEncoder().encode(password) : password;
  const s = typeof salt === 'string' ? new TextEncoder().encode(salt) : salt;
  return Buffer.from(scrypt(pw, s, { N: 16384, r: 8, p: 1, dkLen: keylen }));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

module.exports = { randomBytes, randomInt, scryptSync, timingSafeEqual };
