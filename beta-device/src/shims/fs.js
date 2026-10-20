'use strict';
// In-memory file store for the device build. Files (screenshots, seed images) are saved to device storage by entry.js.
const files = new Map(); // absolute-ish path -> Uint8Array
let onWrite = () => {};

const toBytes = data => (data instanceof Uint8Array ? data : new TextEncoder().encode(String(data)));

module.exports = {
  _setWriteHook(fn) { onWrite = fn; },
  _load(entries) { for (const [k, v] of entries) files.set(k, v); },
  _files: files,
  mkdirSync() {},
  existsSync(p) { return files.has(p); },
  writeFileSync(p, data) { const bytes = toBytes(data); files.set(p, bytes); onWrite(p, bytes); },
  readFileSync(p) {
    if (!files.has(p)) { const e = new Error(`ENOENT: no such file '${p}'`); e.code = 'ENOENT'; throw e; }
    return files.get(p);
  },
};
