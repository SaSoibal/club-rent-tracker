'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { openDb, seed, bootstrapAdmin } = require('./db');
const ocr = require('./ocr');
const otp = require('./otp');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data'); // Render persistent disk mount in production
const PUBLIC = path.join(ROOT, 'public');
const YEAR_START = '2026-01';
const STAFF = ['admin', 'collector'];
const FULLM = ['January','February','March','April','May','June','July','August','September','October','November','December'];

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const nowIso = () => new Date().toISOString();
const rid = (n = 12) => crypto.randomBytes(n).toString('hex');

function todayPeriod() {
  if (process.env.CLUB_TODAY) return process.env.CLUB_TODAY.slice(0, 7);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).slice(0, 7);
}
function dayText(date = new Date()) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}
function periodsUpTo(today) {
  const out = []; let [y, m] = YEAR_START.split('-').map(Number);
  const [ty, tm] = today.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
}
const monthName = p => `${FULLM[+p.slice(5) - 1]} ${p.slice(0, 4)}`;
const first = n => String(n).split(' ')[0];
function normPhone(raw) { let s = String(raw || '').replace(/\D/g, ''); if (s.startsWith('8801')) s = s.slice(2); return s; }
const validPhone = p => /^01[3-9]\d{8}$/.test(p);
const validPeriod = p => /^\d{4}-(0[1-9]|1[0-2])$/.test(p || '');
const validTrx = t => /^[A-Z0-9]{6,20}$/.test(t);

function parseImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) fail(400, 'Upload a PNG, JPG or WEBP screenshot');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) fail(413, 'Screenshot is too large (max 8 MB)');
  const ext = m[1] === 'png' ? 'png' : m[1] === 'webp' ? 'webp' : 'jpg';
  return { ext, buf };
}

function createApp(opts = {}) {
  const dbPath = opts.dbPath || path.join(DATA_DIR, 'club.db');
  const uploadsDir = opts.uploadsDir || path.join(DATA_DIR, 'uploads');
  const demo = opts.demo ?? (process.env.DEMO !== '0');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
  const db = openDb(dbPath);
  if (demo) {
    seed(db, uploadsDir);
  } else if (process.env.ADMIN_PHONE) {
    const adminPhone = normPhone(process.env.ADMIN_PHONE);
    if (!validPhone(adminPhone)) throw new Error('ADMIN_PHONE must be an 11-digit mobile number, e.g. 01XXXXXXXXX');
    bootstrapAdmin(db, adminPhone, (process.env.ADMIN_NAME || 'Club Admin').slice(0, 60));
  } else {
    console.warn('[setup] No users yet. Set ADMIN_PHONE (and optionally ADMIN_NAME) to create the first admin.');
  }

  // ---------- data helpers ----------
  const getUser = id => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const settings = () => {
    const o = {}; db.prepare('SELECT key, value FROM settings').all().forEach(r => { o[r.key] = r.value; });
    return { defaultShare: +o.default_share, dueDay: +o.due_day, clubBkash: { name: o.club_bkash_name, no: o.club_bkash_no } };
  };
  const amountFor = p => {
    const r = db.prepare('SELECT amount FROM period_amounts WHERE period = ?').get(p);
    return r ? r.amount : settings().defaultShare;
  };
  const payment = (uid, p) => db.prepare('SELECT * FROM payments WHERE user_id = ? AND period = ?').get(uid, p);
  const pendingShot = (uid, p) => db.prepare("SELECT * FROM requests WHERE user_id = ? AND period = ? AND kind = 'screenshot' AND status = 'pending'").get(uid, p);
  const remarkOf = (uid, p) => db.prepare('SELECT * FROM remarks WHERE user_id = ? AND period = ?').get(uid, p);
  const statusOf = (u, p) => {
    if (p < u.join_period) return 'na';
    if (p > todayPeriod()) return 'future';
    if (payment(u.id, p)) return 'paid';
    if (pendingShot(u.id, p)) return 'review';
    if (remarkOf(u.id, p)) return 'note';
    return 'due';
  };
  const unpaid = (u, p) => ['due', 'note', 'review'].includes(statusOf(u, p));
  const payers = () => db.prepare('SELECT * FROM users WHERE active = 1 AND pays = 1 ORDER BY name').all();
  const inScope = (staff, t) => staff.role === 'admin' || (staff.role === 'collector' && t.collector_id === staff.id);
  const payeeOf = u => {
    if (u.role === 'member') {
      const c = u.collector_id && getUser(u.collector_id);
      if (c && c.bkash) return { name: c.name + ' (Collector)', no: c.bkash, uid: c.id };
    }
    const s = settings();
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 LIMIT 1").get();
    return { name: s.clubBkash.name + ' (Admin)', no: s.clubBkash.no, uid: admin ? admin.id : null };
  };
  const notifyUser = (uid, title, body, kind = 'info', period = null, requestId = null) => {
    if (!uid) return;
    db.prepare('INSERT INTO notifications (user_id,title,body,kind,period,request_id,read,created_at) VALUES (?,?,?,?,?,?,0,?)')
      .run(uid, title, body, kind, period, requestId, nowIso());
  };
  const dupTrx = (trx, exceptReqId = -1) => {
    if (!trx) return null;
    const r = db.prepare("SELECT r.period, u.name FROM requests r JOIN users u ON u.id = r.user_id WHERE r.trx = ? AND r.status IN ('pending','confirmed') AND r.id <> ? LIMIT 1").get(trx, exceptReqId);
    if (r) return `${r.name} · ${monthName(r.period)}`;
    const p = db.prepare('SELECT p.period, u.name FROM payments p JOIN users u ON u.id = p.user_id WHERE p.trx = ? LIMIT 1').get(trx);
    if (p) return `${p.name} · ${monthName(p.period)}`;
    return null;
  };
  const publicMe = u => ({
    id: u.id, name: u.name, phone: u.phone, role: u.role, pays: !!u.pays,
    collectorId: u.collector_id, bkash: u.bkash, payee: u.pays ? payeeOf(u) : null
  });
  const cellFor = (uid, p, viewer) => {
    const u = getUser(uid);
    const full = viewer.id === uid || STAFF.includes(viewer.role);
    const s = statusOf(u, p);
    const c = { s };
    if (s === 'paid') {
      const pm = payment(uid, p);
      c.amount = pm.amount;
      if (full) { c.method = pm.method; c.date = pm.paid_text; c.trx = pm.trx; c.receiver = pm.receiver; c.verifiedBy = pm.verified_by; }
    } else if (s === 'note') {
      const r = remarkOf(uid, p);
      c.amount = amountFor(p); c.reason = r.reason; c.text = r.text; c.promise = r.promise; c.at = r.created_at;
    } else if (s === 'due' || s === 'review') {
      c.amount = amountFor(p);
    }
    return c;
  };
  const reqDto = (r, viewer) => {
    const staff = STAFF.includes(viewer.role);
    return {
      id: r.id, userId: r.user_id, userName: (getUser(r.user_id) || {}).name, period: r.period, kind: r.kind,
      amount: r.amount, expected: r.expected, trx: r.trx, receiver: r.receiver, paidText: r.paid_text,
      message: r.message, method: r.method, status: r.status, reason: r.reason, ocr: !!r.ocr,
      createdAt: r.created_at, reviewedBy: r.reviewed_by, hasShot: !!r.shot_path,
      shotUrl: r.shot_path ? `/api/requests/${r.id}/shot` : null,
      dup: staff && r.status === 'pending' ? dupTrx(r.trx, r.id) : null
    };
  };

  // ---------- middleware ----------
  function auth(req, res, next) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const u = token && db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1').get(token);
    if (!u) return res.status(401).json({ error: 'Please sign in again' });
    req.user = u; req.token = token; next();
  }
  const staffOnly = (req, res, next) => STAFF.includes(req.user.role) ? next() : res.status(403).json({ error: 'Staff only' });
  const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
  const H = fn => (req, res) => {
    Promise.resolve().then(() => fn(req, res)).catch(e => {
      if (!(e instanceof HttpError)) console.error(e);
      res.status(e.status || 500).json({ error: e instanceof HttpError ? e.message : 'Something went wrong' });
    });
  };

  // ---------- app ----------
  const app = express();
  // The Android app loads the UI from inside the APK and calls this server cross-origin.
  // Auth uses bearer tokens (no cookies), so a wildcard origin is safe here.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.set('trust proxy', 1); // Render sits behind a proxy
  app.use(express.json({ limit: '12mb' }));
  app.use(express.static(PUBLIC));

  app.get('/api/health', (req, res) => res.json({ ok: true, today: todayPeriod(), demo }));

  app.get('/api/demo-accounts', H((req, res) => {
    if (!demo) return res.json({ accounts: [] });
    const pick = (role, pref) => db.prepare('SELECT name, phone FROM users WHERE role = ? AND active = 1 ORDER BY (name = ?) DESC, name LIMIT 1').get(role, pref);
    const list = [['Admin', 'admin', ''], ['Collector', 'collector', ''], ['Member', 'member', 'Sabbir Ahmed']]
      .map(([label, role, pref]) => ({ label, phone: (pick(role, pref) || {}).phone })).filter(a => a.phone);
    res.json({ accounts: list });
  }));

  // --- auth ---
  app.post('/api/auth/otp', H(async (req, res) => {
    const phone = normPhone(req.body.phone);
    if (!validPhone(phone)) fail(400, 'Enter a valid 11-digit mobile number');
    // Outside demo mode a real OTP provider (WhatsApp) is required. Without one, nobody can log in.
    if (!demo && !otp.otpReady()) fail(503, 'Sign-in is not available yet: WhatsApp OTP is not configured.');
    const u = db.prepare('SELECT id FROM users WHERE phone = ? AND active = 1').get(phone);
    if (!u) fail(404, 'This number is not registered. Ask your admin or collector to add you.');
    // Each code costs money to send: allow one new code per phone per minute.
    const prev = db.prepare('SELECT expires_at FROM otps WHERE phone = ?').get(phone);
    if (prev && prev.expires_at - 5 * 60 * 1000 > Date.now() - 60 * 1000) fail(429, 'Please wait a minute before asking for a new code.');
    const code = String(crypto.randomInt(1000, 10000));
    db.prepare('INSERT OR REPLACE INTO otps (phone,code,expires_at,attempts) VALUES (?,?,?,0)').run(phone, code, Date.now() + 5 * 60 * 1000);
    if (demo) {
      // Demo mode only: the code is returned so the flow can be tested without WhatsApp.
      console.log(`[otp] demo code for ${phone}: ${code}`);
      return res.json({ ok: true, devCode: code });
    }
    try {
      await otp.sendOtp(phone, code);
    } catch (e) {
      db.prepare('DELETE FROM otps WHERE phone = ?').run(phone);
      console.error('[otp] send failed:', e.message);
      fail(502, 'Could not send the WhatsApp code. Check that this number uses WhatsApp, then try again.');
    }
    res.json({ ok: true });
  }));

  app.post('/api/auth/verify', H((req, res) => {
    const phone = normPhone(req.body.phone), code = String(req.body.code || '').trim();
    const o = db.prepare('SELECT * FROM otps WHERE phone = ?').get(phone);
    if (!o || o.expires_at < Date.now()) fail(400, 'OTP expired. Request a new one.');
    if (o.attempts >= 5) fail(429, 'Too many wrong attempts. Request a new OTP.');
    if (o.code !== code) { db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE phone = ?').run(phone); fail(401, 'Wrong OTP'); }
    db.prepare('DELETE FROM otps WHERE phone = ?').run(phone);
    const u = db.prepare('SELECT * FROM users WHERE phone = ? AND active = 1').get(phone);
    if (!u) fail(404, 'This number is not registered.');
    const token = rid(24);
    db.prepare('INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)').run(token, u.id, nowIso());
    res.json({ token, user: publicMe(u) });
  }));

  app.post('/api/auth/logout', auth, H((req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
    res.json({ ok: true });
  }));

  // --- bootstrap: everything the signed-in user may see ---
  app.get('/api/bootstrap', auth, H((req, res) => {
    const me = req.user, today = todayPeriod(), periods = periodsUpTo(today), staff = STAFF.includes(me.role);
    const s = settings();
    const members = db.prepare('SELECT * FROM users WHERE active = 1 ORDER BY name').all().map(u => ({
      id: u.id, name: u.name, role: u.role, pays: !!u.pays, collectorId: u.collector_id, joinPeriod: u.join_period,
      phone: (staff || u.id === me.id) ? u.phone : undefined,
      bkash: u.role === 'collector' ? u.bkash : undefined
    }));
    const board = {};
    for (const u of payers()) {
      board[u.id] = {};
      for (const p of periods) board[u.id][p] = cellFor(u.id, p, me);
    }
    let rows;
    if (me.role === 'admin') rows = db.prepare('SELECT * FROM requests ORDER BY id DESC LIMIT 200').all();
    else if (me.role === 'collector') rows = db.prepare('SELECT r.* FROM requests r JOIN users u ON u.id = r.user_id WHERE u.collector_id = ? OR r.user_id = ? ORDER BY r.id DESC LIMIT 200').all(me.id, me.id);
    else rows = db.prepare('SELECT * FROM requests WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(me.id);
    const requests = rows.map(r => reqDto(r, me));
    const notifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(me.id)
      .map(n => ({ id: n.id, title: n.title, body: n.body, kind: n.kind, period: n.period, requestId: n.request_id, read: !!n.read, at: n.created_at }));
    const tRows = me.role === 'admin' ? db.prepare('SELECT * FROM tasks ORDER BY id DESC').all()
      : me.role === 'collector' ? db.prepare('SELECT * FROM tasks WHERE collector_id = ? ORDER BY id DESC').all(me.id) : [];
    const tasks = tRows.map(t => {
      const targets = JSON.parse(t.targets);
      const done = targets.filter(id => payment(id, t.period)).length;
      return { id: t.id, title: t.title, collectorId: t.collector_id, collectorName: (getUser(t.collector_id) || {}).name, period: t.period, dueText: t.due_text, targets, done };
    });
    const amounts = {};
    db.prepare('SELECT period, amount FROM period_amounts').all().forEach(r => { amounts[r.period] = r.amount; });
    res.json({
      me: publicMe(me), today, periods,
      settings: { defaultShare: s.defaultShare, dueDay: s.dueDay, clubBkash: me.role === 'admin' ? s.clubBkash : undefined },
      amounts, members, board, requests, notifications,
      unread: notifications.filter(n => !n.read).length, tasks
    });
  }));

  // --- members ---
  app.post('/api/members', auth, staffOnly, H((req, res) => {
    const me = req.user, b = req.body || {};
    const name = String(b.name || '').trim().slice(0, 60), phone = normPhone(b.phone);
    if (!name) fail(400, 'Enter the member name');
    if (!validPhone(phone)) fail(400, 'Enter a valid 11-digit mobile number');
    const role = me.role === 'admin' ? (['member', 'collector', 'admin'].includes(b.role) ? b.role : 'member') : 'member';
    let collectorId = me.role === 'collector' ? me.id : (b.collectorId || null);
    if (role === 'member') {
      const c = collectorId && getUser(collectorId);
      if (!c || c.role !== 'collector') fail(400, 'Assign a collector');
    } else collectorId = null;
    const joinPeriod = validPeriod(b.joinPeriod) ? b.joinPeriod : todayPeriod();
    const existing = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    if (existing && existing.active) fail(409, 'This number already belongs to a member');
    if (existing) {
      db.prepare('UPDATE users SET name=?, role=?, pays=?, active=1, collector_id=?, join_period=? WHERE id=?')
        .run(name, role, role === 'admin' ? 0 : 1, collectorId, joinPeriod, existing.id);
      return res.json({ ok: true, id: existing.id, reactivated: true });
    }
    const id = 'u' + rid(4);
    db.prepare('INSERT INTO users (id,name,phone,role,pays,active,collector_id,bkash,join_period,created_at) VALUES (?,?,?,?,?,1,?,?,?,?)')
      .run(id, name, phone, role, role === 'admin' ? 0 : 1, collectorId, role === 'collector' ? phone : null, joinPeriod, nowIso());
    notifyUser(id, 'Welcome to Club Rent Tracker', 'Sign in with your mobile number. You will get an OTP each time.', 'info');
    res.json({ ok: true, id });
  }));

  app.patch('/api/members/:id', auth, staffOnly, H((req, res) => {
    const me = req.user, t = getUser(req.params.id);
    if (!t) fail(404, 'Member not found');
    if (!inScope(me, t) && t.id !== me.id) fail(403, 'This member is not in your group');
    const b = req.body || {}, set = {};
    if (b.name !== undefined) { const n = String(b.name).trim(); if (!n) fail(400, 'Name is required'); set.name = n.slice(0, 60); }
    if (b.phone !== undefined) {
      const p = normPhone(b.phone); if (!validPhone(p)) fail(400, 'Invalid mobile number');
      if (db.prepare('SELECT id FROM users WHERE phone = ? AND id <> ?').get(p, t.id)) fail(409, 'This number is already used');
      set.phone = p;
    }
    if (me.role === 'admin' && b.role !== undefined) {
      if (!['member', 'collector', 'admin'].includes(b.role)) fail(400, 'Invalid role');
      set.role = b.role; set.pays = b.role === 'admin' ? 0 : 1;
      if (b.role !== 'member') set.collector_id = null;
    }
    if (me.role === 'admin' && b.collectorId !== undefined) { // only admin assigns collectors
      const c = getUser(b.collectorId); if (!c || c.role !== 'collector') fail(400, 'Pick a collector');
      set.collector_id = c.id;
    }
    if (b.active !== undefined) {
      if (t.id === me.id && !b.active) fail(400, "You can't remove yourself");
      set.active = b.active ? 1 : 0;
    }
    const finalRole = set.role || t.role;
    const finalCollector = set.collector_id !== undefined ? set.collector_id : t.collector_id;
    if (finalRole === 'member' && !finalCollector && set.active !== 0) fail(400, 'Assign a collector');
    const keys = Object.keys(set);
    if (keys.length) db.prepare(`UPDATE users SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map(k => set[k]), t.id);
    if (set.role && set.role !== t.role) notifyUser(t.id, 'Your role was updated', `You are now a ${set.role}.`, 'info');
    res.json({ ok: true });
  }));

  // --- payments (collector records cash / bKash) ---
  app.post('/api/payments', auth, staffOnly, H((req, res) => {
    const me = req.user, b = req.body || {}, t = getUser(b.userId);
    if (!t || !t.pays || !t.active) fail(404, 'Member not found');
    if (!inScope(me, t)) fail(403, 'This member is not in your group');
    const p = b.period;
    if (!validPeriod(p) || p > todayPeriod()) fail(400, 'Pick a valid month');
    if (p < t.join_period) fail(400, 'Member had not joined in this month');
    if (payment(t.id, p)) fail(409, 'Already paid for this month');
    const method = b.method === 'bKash' ? 'bKash' : 'Cash';
    const trx = method === 'bKash' ? String(b.trx || '').trim().toUpperCase() : '—';
    if (method === 'bKash') {
      if (!validTrx(trx)) fail(400, 'Enter a valid bKash TrxID');
      const d = dupTrx(trx); if (d) fail(409, 'This TrxID is already used: ' + d);
    }
    const amount = amountFor(p);
    db.transaction(() => {
      db.prepare(`INSERT INTO payments (user_id,period,amount,method,trx,receiver,paid_text,shot_path,source,recorded_by,verified_by,created_at)
                  VALUES (?,?,?,?,?,NULL,?,NULL,'collector',?,?,?)`).run(t.id, p, amount, method, trx, dayText(), me.id, me.name, nowIso());
      db.prepare("UPDATE requests SET status='closed', reason='Payment recorded by collector', reviewed_by=?, reviewed_at=? WHERE user_id=? AND period=? AND status='pending'")
        .run(me.name, nowIso(), t.id, p);
    })();
    notifyUser(t.id, 'Payment recorded', `${monthName(p)} rent ৳${amount} recorded by ${me.name} (${method}).`, 'ok', p);
    res.json({ ok: true });
  }));

  // --- monthly amount & rent setup ---
  app.put('/api/amounts/:period', auth, staffOnly, H((req, res) => {
    const p = req.params.period, amount = parseInt(req.body.amount, 10);
    if (!validPeriod(p)) fail(400, 'Invalid month');
    if (!(amount > 0 && amount <= 100000)) fail(400, 'Enter a valid amount');
    db.prepare('INSERT INTO period_amounts (period,amount) VALUES (?,?) ON CONFLICT(period) DO UPDATE SET amount = excluded.amount').run(p, amount);
    res.json({ ok: true });
  }));

  app.put('/api/settings', auth, adminOnly, H((req, res) => {
    const share = parseInt(req.body.defaultShare, 10), due = parseInt(req.body.dueDay, 10);
    if (!(share > 0 && share <= 100000)) fail(400, 'Enter a valid monthly share');
    if (!(due >= 1 && due <= 28)) fail(400, 'Due day must be 1–28');
    db.prepare("INSERT INTO settings (key,value) VALUES ('default_share',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(share));
    db.prepare("INSERT INTO settings (key,value) VALUES ('due_day',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(due));
    res.json({ ok: true });
  }));

  app.put('/api/settings/club-bkash', auth, adminOnly, H((req, res) => {
    const name = String(req.body.name || '').trim(), no = normPhone(req.body.no);
    if (!name) fail(400, 'Enter the account name');
    if (!validPhone(no)) fail(400, 'Enter a valid bKash number');
    db.prepare("INSERT INTO settings (key,value) VALUES ('club_bkash_name',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(name);
    db.prepare("INSERT INTO settings (key,value) VALUES ('club_bkash_no',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(no);
    res.json({ ok: true });
  }));

  app.put('/api/me/bkash', auth, H((req, res) => {
    if (req.user.role !== 'collector') fail(403, 'Only collectors set a bKash number here');
    const no = normPhone(req.body.bkash);
    if (!validPhone(no)) fail(400, 'Enter a valid bKash number');
    db.prepare('UPDATE users SET bkash = ? WHERE id = ?').run(no, req.user.id);
    res.json({ ok: true });
  }));

  // --- "I can't pay this month" note ---
  app.post('/api/remarks', auth, H((req, res) => {
    const me = req.user, b = req.body || {};
    if (!me.pays) fail(403, 'Not applicable');
    const p = b.period;
    if (!validPeriod(p)) fail(400, 'Pick a month');
    const s = statusOf(me, p);
    if (s === 'paid') fail(409, 'This month is already paid');
    if (s === 'review') fail(409, 'A screenshot for this month is under review');
    if (s !== 'due' && s !== 'note') fail(409, 'Nothing due for this month');
    const reason = String(b.reason || '').trim().slice(0, 60), text = String(b.text || '').trim().slice(0, 300);
    if (!reason && !text) fail(400, 'Choose a reason or write a note');
    db.prepare(`INSERT INTO remarks (user_id,period,reason,text,promise,created_at) VALUES (?,?,?,?,?,?)
                ON CONFLICT(user_id,period) DO UPDATE SET reason=excluded.reason, text=excluded.text, promise=excluded.promise, created_at=excluded.created_at`)
      .run(me.id, p, reason || 'Other', text, String(b.promise || '').slice(0, 20), nowIso());
    notifyUser(payeeOf(me).uid, `${me.name} won't pay ${monthName(p).split(' ')[0]}`, `${reason || 'Other'}${text ? ': ' + text : ''}`, 'info', p);
    res.json({ ok: true });
  }));

  // --- screenshot reader ---
  app.post('/api/ocr', auth, H(async (req, res) => {
    const img = parseImage(req.body.imageDataUrl);
    try {
      const r = await ocr.readReceipt(img.buf);
      res.json({ ok: true, ...r });
    } catch (e) {
      console.error('[ocr]', e.message);
      res.json({ ok: false, error: 'Could not read this screenshot. Please type the details.' });
    }
  }));

  // --- payment requests from members ---
  app.post('/api/requests', auth, H((req, res) => {
    const me = req.user, b = req.body || {};
    if (!me.pays) fail(403, 'Not applicable');
    const p = b.period;
    if (!validPeriod(p)) fail(400, 'Pick a month');
    const s = statusOf(me, p);
    if (s === 'paid') fail(409, 'This month is already paid');
    if (s === 'review') fail(409, 'A screenshot for this month is already under review');
    if (s !== 'due' && s !== 'note') fail(409, 'Nothing due for this month');
    const to = payeeOf(me).uid;

    if (b.kind === 'screenshot') {
      const amount = parseInt(b.amount, 10);
      if (!(amount > 0)) fail(400, 'Enter the amount');
      const trx = String(b.trx || '').trim().toUpperCase();
      if (!validTrx(trx)) fail(400, 'Enter the bKash TrxID');
      const img = parseImage(b.imageDataUrl);
      const file = rid(10) + '.' + img.ext;
      fs.writeFileSync(path.join(uploadsDir, file), img.buf);
      const expected = amountFor(p);
      const receiver = String(b.receiver || '').replace(/\s+/g, ' ').trim().slice(0, 30);
      const info = db.prepare(`INSERT INTO requests (user_id,period,kind,amount,expected,trx,receiver,paid_text,shot_path,message,method,status,ocr,created_at)
                               VALUES (?,?,'screenshot',?,?,?,?,?,?,NULL,'bKash','pending',?,?)`)
        .run(me.id, p, amount, expected, trx, receiver, String(b.paidText || '').slice(0, 60), file, b.ocr ? 1 : 0, nowIso());
      const dup = dupTrx(trx, info.lastInsertRowid);
      notifyUser(to, 'New bKash screenshot', `${me.name} · ${monthName(p)} · ৳${amount} · TrxID ${trx}${dup ? ' ⚠ TrxID already used' : ''}`, 'review', p, info.lastInsertRowid);
      notifyUser(me.id, 'Screenshot sent', 'Your collector will verify the payment and update your status.', 'info', p);
      return res.json({ ok: true, id: info.lastInsertRowid });
    }
    if (b.kind === 'update') {
      const message = String(b.message || '').trim().slice(0, 300);
      if (!message) fail(400, 'Write a short message');
      const method = b.method === 'bKash' ? 'bKash' : 'Cash';
      const amount = amountFor(p);
      const info = db.prepare(`INSERT INTO requests (user_id,period,kind,amount,expected,message,method,status,ocr,created_at)
                               VALUES (?,?,'update',?,?,?,?,'pending',0,?)`).run(me.id, p, amount, amount, `[${method}] ${message}`, method, nowIso());
      notifyUser(to, 'Status update request', `${me.name}: ${message}`, 'review', p, info.lastInsertRowid);
      notifyUser(me.id, 'Request sent', 'Your collector has been notified.', 'info', p);
      return res.json({ ok: true, id: info.lastInsertRowid });
    }
    fail(400, 'Unknown request type');
  }));

  const loadRequest = id => db.prepare('SELECT * FROM requests WHERE id = ?').get(id);

  app.post('/api/requests/:id/confirm', auth, staffOnly, H((req, res) => {
    const me = req.user, r = loadRequest(req.params.id);
    if (!r) fail(404, 'Request not found');
    const t = getUser(r.user_id);
    if (!inScope(me, t)) fail(403, 'This member is not in your group');
    if (r.status !== 'pending') fail(409, 'This request is already ' + r.status);
    if (payment(t.id, r.period)) fail(409, 'This month is already paid');
    const b = req.body || {};
    if (b.vok !== true) fail(400, 'Tick the verification box first');
    let method, trx, amount = r.amount;
    if (r.kind === 'screenshot') {
      if (r.amount !== r.expected) fail(409, `Amount ৳${r.amount} does not match the due ৳${r.expected}. Reject and ask the member to upload again.`);
      if (!r.trx) fail(409, 'TrxID is missing');
      const d = dupTrx(r.trx, r.id); if (d) fail(409, 'TrxID already used by ' + d);
      method = 'bKash'; trx = r.trx;
    } else {
      method = b.method === 'bKash' ? 'bKash' : 'Cash';
      trx = method === 'bKash' ? String(b.trx || '').trim().toUpperCase() : '—';
      if (method === 'bKash') {
        if (!validTrx(trx)) fail(400, 'Enter the bKash TrxID');
        const d = dupTrx(trx, r.id); if (d) fail(409, 'TrxID already used by ' + d);
      }
      amount = r.expected;
    }
    db.transaction(() => {
      db.prepare(`INSERT INTO payments (user_id,period,amount,method,trx,receiver,paid_text,shot_path,source,recorded_by,verified_by,created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(t.id, r.period, amount, method, trx, r.receiver || null, r.paid_text || dayText(), r.shot_path,
          r.kind === 'screenshot' ? 'screenshot' : 'request', me.id, me.name, nowIso());
      db.prepare("UPDATE requests SET status='confirmed', method=?, trx=?, reviewed_by=?, reviewed_at=? WHERE id=?")
        .run(method, trx, me.name, nowIso(), r.id);
      db.prepare("UPDATE requests SET status='closed', reason='Superseded by confirmed payment', reviewed_by=?, reviewed_at=? WHERE user_id=? AND period=? AND status='pending'")
        .run(me.name, nowIso(), t.id, r.period);
    })();
    notifyUser(t.id, 'Payment confirmed ✓', `Your ${monthName(r.period)} rent of ৳${amount} was verified by ${me.name}.`, 'ok', r.period, r.id);
    res.json({ ok: true });
  }));

  app.post('/api/requests/:id/reject', auth, staffOnly, H((req, res) => {
    const me = req.user, r = loadRequest(req.params.id);
    if (!r) fail(404, 'Request not found');
    const t = getUser(r.user_id);
    if (!inScope(me, t)) fail(403, 'This member is not in your group');
    if (r.status !== 'pending') fail(409, 'This request is already ' + r.status);
    const reason = String((req.body || {}).reason || '').trim().slice(0, 200);
    if (!reason) fail(400, 'Write or choose a reason');
    db.prepare("UPDATE requests SET status='rejected', reason=?, reviewed_by=?, reviewed_at=? WHERE id=?").run(reason, me.name, nowIso(), r.id);
    notifyUser(t.id, 'Payment request rejected', `${reason}. Please check and upload again or contact your collector.`, 'bad', r.period, r.id);
    res.json({ ok: true });
  }));

  app.get('/api/requests/:id/shot', auth, H((req, res) => {
    const r = loadRequest(req.params.id);
    if (!r || !r.shot_path) fail(404, 'No screenshot');
    const t = getUser(r.user_id);
    const allowed = r.user_id === req.user.id || (STAFF.includes(req.user.role) && inScope(req.user, t));
    if (!allowed) fail(403, 'Not allowed');
    res.sendFile(path.join(uploadsDir, path.basename(r.shot_path)));
  }));

  // --- notifications ---
  app.post('/api/notifications/read', auth, H((req, res) => {
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
    res.json({ ok: true });
  }));

  app.post('/api/notify', auth, staffOnly, H((req, res) => {
    const me = req.user, b = req.body || {}, p = b.period;
    if (!validPeriod(p)) fail(400, 'Pick a month');
    const msg = String(b.message || '').trim().slice(0, 500);
    if (!msg) fail(400, 'Write a message');
    const scope = payers().filter(t => inScope(me, t));
    let targets;
    if (b.mode === 'unpaid') targets = scope.filter(t => unpaid(t, p) && statusOf(t, p) !== 'review');
    else {
      const ids = Array.isArray(b.userIds) ? b.userIds : [];
      targets = scope.filter(t => ids.includes(t.id) && unpaid(t, p) && statusOf(t, p) !== 'review');
    }
    if (!targets.length) fail(400, 'No unpaid members selected');
    for (const t of targets) {
      notifyUser(t.id, `${monthName(p)} rent reminder`,
        msg.replace(/\{name\}/g, first(t.name)).replace(/\{month\}/g, monthName(p)), 'pay', p);
    }
    res.json({ ok: true, sent: targets.length });
  }));

  // --- collection tasks (admin) ---
  app.post('/api/tasks', auth, adminOnly, H((req, res) => {
    const b = req.body || {}, c = getUser(b.collectorId);
    if (!c || c.role !== 'collector') fail(400, 'Pick a collector');
    if (!validPeriod(b.period)) fail(400, 'Pick a month');
    const title = String(b.title || '').trim().slice(0, 100);
    if (!title) fail(400, 'Enter a task title');
    const targets = payers().filter(t => t.collector_id === c.id && unpaid(t, b.period) && statusOf(t, b.period) !== 'review').map(t => t.id);
    if (!targets.length) fail(400, 'No unpaid members in this group for that month');
    db.prepare('INSERT INTO tasks (title,collector_id,period,due_text,targets,created_at) VALUES (?,?,?,?,?,?)')
      .run(title, c.id, b.period, String(b.dueText || '').slice(0, 20), JSON.stringify(targets), nowIso());
    notifyUser(c.id, 'New collection task', `${title} · ${targets.length} member(s) · due ${b.dueText || 'soon'}`, 'info', b.period);
    res.json({ ok: true, targets: targets.length });
  }));

  // SPA fallback
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

  return { app, db };
}

if (require.main === module) {
  const port = +process.env.PORT || 3000;
  const demo = process.env.DEMO !== '0';
  const { app } = createApp();
  if (demo) console.warn('[security] DEMO mode is ON: OTP codes are returned to the app. Set DEMO=0 before any public deployment.');
  app.listen(port, '0.0.0.0', () => console.log(`Club Rent Tracker running on http://0.0.0.0:${port} (demo=${demo})`));
}

module.exports = { createApp, normPhone, todayPeriod, periodsUpTo };
