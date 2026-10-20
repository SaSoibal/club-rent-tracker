'use strict';
// Browser entry for the phone app. Opens device storage (IndexedDB), starts the core and exposes it to the UI.
const initSqlJs = require('sql.js/dist/sql-wasm-browser.js');
const { boot } = require('./core');

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('club-rent-device', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function makeStore(idb) {
  const write = (fn) => new Promise((resolve, reject) => {
    const t = idb.transaction('kv', 'readwrite');
    fn(t.objectStore('kv'));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
  return {
    get: (k) => new Promise((resolve, reject) => {
      const r = idb.transaction('kv').objectStore('kv').get(k);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }),
    put: (k, v) => write(st => st.put(v, k)),
    clear: () => write(st => st.clear()),
    entries: (prefix) => new Promise((resolve, reject) => {
      const out = [];
      const range = IDBKeyRange.bound(prefix, prefix + '\uffff');
      const req = idb.transaction('kv').objectStore('kv').openCursor(range);
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) { out.push([cur.key, cur.value]); cur.continue(); } else resolve(out);
      };
      req.onerror = () => reject(req.error);
    }),
  };
}

window.clubBoot = (async () => {
  const sqlJs = await initSqlJs({ locateFile: f => f }); // sql-wasm-browser.wasm sits next to this page
  const store = makeStore(await openIdb());
  const core = await boot({ sqlJs, store });
  window.clubApi = (method, url, body, token) => core.api(method, url, body, token);
  window.clubStatus = () => core.status();
  window.clubSetup = d => core.setup(d);
  window.clubStartDemo = async () => { await core.startDemo(); location.reload(); };
  window.clubExport = () => core.exportBackup();
  window.clubImport = async obj => { await core.importBackup(obj); location.reload(); };
  window.clubErase = async () => { await core.erase(); location.reload(); };
  return core;
})();
