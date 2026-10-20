'use strict';
// A small in-process stand-in for the parts of Express that server/index.js uses.
// There is no network: the UI calls dispatch() directly, so requests never leave the device.

function compilePath(p) {
  if (p instanceof RegExp) return { re: p, keys: [] };
  const keys = [];
  const src = String(p).replace(/[.+*?^${}()|[\]\\]/g, '\\$&').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  return { re: new RegExp('^' + src + '$'), keys };
}

function makeRes(finish) {
  const res = {
    statusCode: 200, headers: {}, _done: false,
    status(n) { res.statusCode = n; return res; },
    setHeader(k, v) { res.headers[k] = v; return res; },
    set(k, v) { res.headers[k] = v; return res; },
    type(t) { res.headers['Content-Type'] = t; return res; },
    json(obj) { return finish({ status: res.statusCode, data: obj }); },
    send(body) { return finish({ status: res.statusCode, data: body }); },
    sendStatus(n) { return finish({ status: n, data: null }); },
    sendFile(file) {
      const fs = require('fs');
      let data;
      try { data = fs.readFileSync(file); } catch (e) { return finish({ status: 404, data: { error: 'File not found' } }); }
      const ext = String(file).split('.').pop().toLowerCase();
      const contentType = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', html: 'text/html' }[ext] || 'application/octet-stream';
      return finish({ status: 200, data, contentType });
    },
  };
  return res;
}

function express() {
  const layers = []; // { method|null, match|null, handlers[] }
  const app = {
    _layers: layers,
    set() { return app; },
    use(...args) {
      const fn = typeof args[0] === 'function' ? args[0] : args[1];
      layers.push({ method: null, match: null, handlers: [fn] });
      return app;
    },
    listen() { throw new Error('listen() is not used in the device build'); },
  };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    app[method] = (path, ...handlers) => {
      layers.push({ method: method.toUpperCase(), match: compilePath(path), handlers });
      return app;
    };
  }
  // Runs one request through the layers. Resolves with { status, data, contentType? } once a response is sent.
  app._dispatch = (method, url, req, readFile) => new Promise(resolve => {
    const path = url.split('?')[0];
    req.method = method; req.path = path; req.params = {}; req.query = {};
    req.headers = req.headers || {};
    const res = makeRes(out => { if (!res._done) { res._done = true; resolve(out); } });
    res.readFile = readFile;
    let i = 0;
    const run = () => {
      while (i < layers.length) {
        const layer = layers[i++];
        if (layer.method && layer.method !== method) continue;
        if (layer.match) {
          const m = layer.match.re.exec(path);
          if (!m) continue;
          req.params = {};
          layer.match.keys.forEach((k, idx) => { req.params[k] = decodeURIComponent(m[idx + 1]); });
        }
        return runHandlers(layer.handlers, 0);
      }
      if (!res._done) { res._done = true; resolve({ status: 404, data: { error: 'Not found' } }); }
    };
    const runHandlers = (handlers, idx) => {
      if (res._done) return;
      if (idx >= handlers.length) return run();
      const h = handlers[idx];
      let called = false;
      const next = () => { if (!called) { called = true; runHandlers(handlers, idx + 1); } };
      try {
        const r = h(req, res, next);
        if (r && typeof r.catch === 'function') r.catch(e => { if (!res._done) { res._done = true; resolve({ status: 500, data: { error: 'Something went wrong' } }); console.error(e); } });
      } catch (e) {
        if (!res._done) { res._done = true; resolve({ status: 500, data: { error: 'Something went wrong' } }); console.error(e); }
      }
    };
    run();
  });
  return app;
}

express.json = () => (req, res, next) => next();
express.static = () => (req, res, next) => next();

module.exports = express;
