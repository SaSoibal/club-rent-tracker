'use strict';
// Drop-in replacement for the parts of better-sqlite3 used by server/db.js and server/index.js,
// backed by sql.js (SQLite compiled to WebAssembly). Each database instance keeps its own engine
// and its own save function, so several apps can run in one process (the tests do this).

let pending = null; // set by Database.open(); consumed by the next `new Database()` (made by openDb)

const norm = v => {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
};
const flat = args => (args.length === 1 && Array.isArray(args[0]) ? args[0] : args).map(norm);

class Statement {
  constructor(owner, sql) { this.owner = owner; this.sql = sql; }
  _open(args) {
    const stmt = this.owner.raw.prepare(this.sql);
    stmt.bind(flat(args));
    return stmt;
  }
  get(...args) {
    const stmt = this._open(args);
    try { return stmt.step() ? stmt.getAsObject() : undefined; } finally { stmt.free(); }
  }
  all(...args) {
    const stmt = this._open(args), rows = [];
    try { while (stmt.step()) rows.push(stmt.getAsObject()); return rows; } finally { stmt.free(); }
  }
  run(...args) {
    const raw = this.owner.raw;
    const stmt = this._open(args);
    try { stmt.step(); } finally { stmt.free(); }
    const changes = raw.getRowsModified();
    const idStmt = raw.prepare('SELECT last_insert_rowid() AS id');
    idStmt.step();
    const lastInsertRowid = idStmt.getAsObject().id;
    idStmt.free();
    this.owner.persist();
    return { changes, lastInsertRowid };
  }
}

class Database {
  constructor(file) {
    if (!pending) throw new Error(`Database "${file}" was not opened by the device core`);
    this.file = file;
    this.raw = pending.raw;
    this.persist = pending.persist;
    pending = null;
  }
  pragma(s) { try { this.raw.exec('PRAGMA ' + s); } catch (e) { /* not supported in the browser build */ } }
  exec(sql) { this.raw.exec(sql); this.persist(); return this; }
  prepare(sql) { return new Statement(this, sql); }
  transaction(fn) {
    return (...args) => {
      this.raw.exec('BEGIN');
      try {
        const out = fn(...args);
        this.raw.exec('COMMIT');
        this.persist();
        return out;
      } catch (e) {
        this.raw.exec('ROLLBACK');
        throw e;
      }
    };
  }
  // The whole database as bytes (for saving to device storage and for backups).
  export() { return this.raw.export(); }
  close() {}
}

// Used by the device core: opens an engine that the next Database() call will take over.
Database.open = ({ sqlJs, bytes, persist }) => {
  pending = { raw: bytes ? new sqlJs.Database(bytes) : new sqlJs.Database(), persist };
  return pending;
};

module.exports = Database;
