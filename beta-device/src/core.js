'use strict';
// Device core: runs the club server code (../../server) in-process with a device-local database.
// Nothing here makes a network request. `store` is the device storage (IndexedDB in the app, memory in tests).
const Database = require('better-sqlite3');
const fs = require('fs');
const { createApp, normPhone } = require('../../server/index');
const { bootstrapAdmin } = require('../../server/db');
const pw = require('../../server/auth');

const MODE_KEY = 'mode';   // 'club' (real club), 'demo' (sample data), or absent (first-time setup)
const DB_KEY = 'db';
const FILE_PREFIX = 'file:';
const SAVE_DELAY_MS = 300;

const validPhone = p => /^01[3-9]\d{8}$/.test(p);
const b64 = bytes => Buffer.from(bytes).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));

async function boot({ sqlJs, store }) {
  // 1. Load the saved screenshot files from device storage.
  const savedDb = await store.get(DB_KEY);
  const savedFiles = await store.entries(FILE_PREFIX);
  fs._load(savedFiles.map(([k, v]) => [k.slice(FILE_PREFIX.length), v]));
  fs._setWriteHook((path, bytes) => { store.put(FILE_PREFIX + path, bytes); });

  // 2. Open the SQLite database and save it to device storage shortly after each change.
  let timer = null;
  let db = null;
  const persistNow = async () => { timer = null; if (db) await store.put(DB_KEY, db.export()); };
  const schedule = () => { if (!timer) timer = setTimeout(persistNow, SAVE_DELAY_MS); };
  Database.open({ sqlJs, bytes: savedDb || null, persist: schedule });

  // 3. Create the app. Demo data is seeded only in demo mode and only when the database is empty.
  let mode = await store.get(MODE_KEY) || null;
  const created = createApp({ dbPath: 'club.db', uploadsDir: 'uploads', demo: mode === 'demo' });
  db = created.db;
  const app = created.app;
  if (!mode && db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0) mode = 'club'; // e.g. restored from a backup

  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    await store.put(DB_KEY, db.export());
  };

  return {
    db,           // for tests
    _fs: fs,      // for tests: lets a test clear the in-memory files to prove they reload from storage
    get mode() { return mode; },
    // Same routes and JSON as the server build. Returns { status, data }.
    api(method, url, body, token) {
      const headers = token ? { authorization: 'Bearer ' + token } : {};
      return app._dispatch(method, url, { body: body || {}, headers }, null).then(out => {
        // Same as HTTP: the page gets a JSON copy, never the live database objects.
        if (out.data != null && !(out.data instanceof Uint8Array)) out.data = JSON.parse(JSON.stringify(out.data));
        return out;
      });
    },
    status() {
      return { mode, hasUsers: db.prepare('SELECT COUNT(*) AS c FROM users').get().c > 0 };
    },
    // First-time setup: create the club admin on this device.
    async setup({ name, phone, password }) {
      const cleanName = String(name || '').trim().slice(0, 60);
      const p = normPhone(phone);
      if (!cleanName) throw new Error('Enter the admin name');
      if (!validPhone(p)) throw new Error('Enter a valid 11-digit mobile number');
      if (!pw.validPassword(password)) throw new Error(`Password must be ${pw.MIN_PASSWORD} to 128 characters`);
      if (!bootstrapAdmin(db, p, cleanName, pw.hashPassword(password))) throw new Error('This device already has a club');
      mode = 'club';
      await store.put(MODE_KEY, mode);
      await flush();
      return { ok: true };
    },
    // Demo data is seeded when the app starts, so the page reloads after this.
    async startDemo() { await store.put(MODE_KEY, 'demo'); await flush(); return { ok: true }; },
    // Backup: the whole database and all screenshots as one JSON object.
    async exportBackup() {
      await flush();
      const files = {};
      for (const [k, v] of await store.entries(FILE_PREFIX)) files[k.slice(FILE_PREFIX.length)] = b64(v);
      return { format: 'club-rent-backup', version: 1, createdAt: new Date().toISOString(), db: b64(db.export()), files };
    },
    // Replaces everything on this device with the backup. The page reloads after this.
    async importBackup(backup) {
      if (!backup || backup.format !== 'club-rent-backup' || backup.version !== 1 || typeof backup.db !== 'string') {
        throw new Error('This is not a Club Rent backup file');
      }
      await store.clear();
      await store.put(DB_KEY, unb64(backup.db));
      for (const [name, data] of Object.entries(backup.files || {})) await store.put(FILE_PREFIX + name, unb64(data));
      await store.put(MODE_KEY, 'club');
      return { ok: true };
    },
    async erase() { await store.clear(); return { ok: true }; },
    flush,
  };
}

module.exports = { boot };
