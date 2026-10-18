'use strict';
// Runs against a throwaway database. Usage: npm test
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { createApp } = require('../server/index');
const pwmod = require('../server/auth');

let pass = 0, fails = [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-test-'));
process.env.CLUB_TODAY = '2026-10';

async function run(name, fn) {
  try { await fn(); pass++; console.log('  PASS', name); }
  catch (e) { fails.push(name); console.log('  FAIL', name, '\n       ', e.message); }
}

(async () => {
  const { app, db } = createApp({ dbPath: path.join(tmp, 'test.db'), uploadsDir: path.join(tmp, 'uploads'), demo: true });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const tokens = {};

  async function call(method, url, body, token) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.arrayBuffer();
    return { status: r.status, data };
  }
  const DEMO_PW = 'demo1234';
  async function login(phone, password = DEMO_PW) {
    const v = await call('POST', '/api/auth/login', { phone, password });
    assert.strictEqual(v.status, 200, 'login failed: ' + JSON.stringify(v.data));
    return v.data.token;
  }
  const expectStatus = (r, s) => assert.strictEqual(r.status, s, `expected ${s} got ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  const receiptDataUrl = 'data:image/png;base64,' + fs.readFileSync(path.join(__dirname, 'fixtures', 'receipt.png')).toString('base64');

  console.log('Password storage');
  await run('scrypt hashes verify and never store the plain password', () => {
    const h = pwmod.hashPassword('correct horse');
    assert.match(h, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    assert.ok(!h.includes('correct horse'));
    assert.ok(pwmod.verifyPassword('correct horse', h));
    assert.ok(!pwmod.verifyPassword('correct hors', h));
    assert.ok(!pwmod.verifyPassword('anything', null));
    assert.ok(!pwmod.validPassword('short'));
    assert.ok(pwmod.validPassword('eight888'));
  });
  await run('databases from before password login get the column and lose the OTP table', () => {
    const Database = require('better-sqlite3');
    const f = path.join(tmp, 'old.db');
    const old = new Database(f);
    old.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, role TEXT NOT NULL, pays INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, collector_id TEXT, bkash TEXT, join_period TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE otps (phone TEXT PRIMARY KEY, code TEXT, expires_at INTEGER, attempts INTEGER);");
    old.close();
    const { openDb } = require('../server/db');
    const db2 = openDb(f);
    assert.ok(db2.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'password_hash'));
    assert.strictEqual(db2.prepare("SELECT name FROM sqlite_master WHERE name = 'otps'").get(), undefined);
    db2.close();
  });

  console.log('Auth');
  await run('health endpoint responds', async () => {
    const h = await call('GET', '/api/health'); expectStatus(h, 200); assert.strictEqual(h.data.today, '2026-10');
  });
  await run('wrong password and unknown number give the same message', async () => {
    const wrong = await call('POST', '/api/auth/login', { phone: '01711000001', password: 'nope-nope' });
    const unknown = await call('POST', '/api/auth/login', { phone: '01799999998', password: DEMO_PW });
    expectStatus(wrong, 401); expectStatus(unknown, 401);
    assert.strictEqual(wrong.data.error, unknown.data.error);
  });
  await run('missing or malformed input is rejected', async () => {
    expectStatus(await call('POST', '/api/auth/login', { phone: '123', password: DEMO_PW }), 400);
    expectStatus(await call('POST', '/api/auth/login', { phone: '01711000001', password: '' }), 400);
  });
  await run('five wrong passwords lock the number for 15 minutes, even for the right password', async () => {
    for (let i = 0; i < 5; i++) expectStatus(await call('POST', '/api/auth/login', { phone: '01711000005', password: 'wrong-one' }), 401);
    expectStatus(await call('POST', '/api/auth/login', { phone: '01711000005', password: 'wrong-one' }), 429);
    expectStatus(await call('POST', '/api/auth/login', { phone: '01711000005', password: DEMO_PW }), 429);
  });
  await run('admin, collector and member can sign in', async () => {
    tokens.admin = await login('01711000001');
    tokens.tanvir = await login('01711000002');   // collector, group A (u4-u8)
    tokens.shakil = await login('01711000003');   // collector, group B (u9-u11)
    tokens.sabbir = await login('01711000006');   // member u6 in group A
    tokens.rahim = await login('01711000004');    // member u4 in group A, paid October
    tokens.nabil = await login('01711000009');    // member u9 in group B
    assert.ok(tokens.sabbir && tokens.admin);
  });
  await run('password hashes are never sent to the app', async () => {
    const b = await call('GET', '/api/bootstrap', undefined, tokens.admin);
    assert.ok(!JSON.stringify(b.data).includes('scrypt$'));
    const d = db.prepare("SELECT password_hash FROM users WHERE phone = '01711000006'").get();
    assert.match(d.password_hash, /^scrypt\$/);
    assert.ok(!d.password_hash.includes(DEMO_PW));
  });
  await run('bootstrap needs a session', async () => {
    expectStatus(await call('GET', '/api/bootstrap'), 401);
    expectStatus(await call('GET', '/api/bootstrap', undefined, 'bogus'), 401);
  });
  await run('role is determined by phone', async () => {
    const b = await call('GET', '/api/bootstrap', undefined, tokens.tanvir);
    expectStatus(b, 200); assert.strictEqual(b.data.me.role, 'collector');
  });

  console.log('Privacy and board');
  await run('member board shows others as status only', async () => {
    const b = await call('GET', '/api/bootstrap', undefined, tokens.rahim);
    const rahimOct = b.data.board['u5']['2026-10'];       // Karim, paid
    assert.strictEqual(rahimOct.s, 'paid');
    assert.strictEqual(rahimOct.trx, undefined, 'other member TrxID must be hidden');
    assert.strictEqual(rahimOct.method, undefined, 'other member method must be hidden');
    assert.strictEqual(rahimOct.receiver, undefined);
    assert.strictEqual(b.data.members.find(m => m.id === 'u5').phone, undefined, 'other member phone hidden');
  });
  await run('member sees own full history', async () => {
    const b = await call('GET', '/api/bootstrap', undefined, tokens.rahim);
    const own = b.data.board['u4']['2026-02'];
    assert.strictEqual(own.s, 'paid');
    assert.ok(own.trx && own.trx !== '—' || own.method === 'Cash', 'own payment detail visible');
  });
  await run('seeded October status matches design (7 paid)', async () => {
    const b = await call('GET', '/api/bootstrap', undefined, tokens.admin);
    const paid = Object.keys(b.data.board).filter(id => b.data.board[id]['2026-10'].s === 'paid');
    assert.strictEqual(paid.length, 7, 'paid count ' + paid.length);
    assert.strictEqual(b.data.board['u7']['2026-10'].s, 'note');
    assert.strictEqual(b.data.board['u6']['2026-10'].s, 'review');
  });
  await run('admin bootstrap includes all 200 requests and tasks', async () => {
    const b = await call('GET', '/api/bootstrap', undefined, tokens.admin);
    assert.ok(b.data.requests.length >= 3);
    assert.ok(b.data.tasks.length >= 1);
  });

  console.log('Members and screenshot flow');
  let m1, m2;   // M1: Test Member (group A, Tanvir). M2: Due Member (group B, Shakil).
  let ocrRes;
  await run('OCR reads the receipt fixture', async () => {
    const r = await call('POST', '/api/ocr', { imageDataUrl: receiptDataUrl }, tokens.sabbir);
    expectStatus(r, 200); ocrRes = r.data;
    assert.strictEqual(r.data.ok, true, JSON.stringify(r.data));
    assert.strictEqual(r.data.amount, 200);
    assert.strictEqual(r.data.trx, '8N7A2K9X1B');
    assert.strictEqual(r.data.receiver, '01711000002');
    assert.strictEqual(r.data.paidText, '18/10/2026 9:05 PM');
  });
  await run('OCR rejects non-image uploads', async () => {
    expectStatus(await call('POST', '/api/ocr', { imageDataUrl: 'data:text/plain;base64,aGk=' }, tokens.sabbir), 400);
  });
  await run('collector adds members to own group only', async () => {
    const a = await call('POST', '/api/members', { name: 'Test Member', phone: '01811000001', joinPeriod: '2026-10', password: 'start-pass1' }, tokens.tanvir);
    expectStatus(a, 200); m1 = a.data.id;
    const b = await call('POST', '/api/members', { name: 'Due Member', phone: '01811000002', joinPeriod: '2026-10', password: 'start-pass1' }, tokens.shakil);
    expectStatus(b, 200); m2 = b.data.id;
    const bs = await call('GET', '/api/bootstrap', undefined, tokens.tanvir);
    assert.strictEqual(bs.data.members.find(m => m.id === m1).collectorId, 'u2');
    assert.strictEqual(bs.data.members.find(m => m.id === m2).collectorId, 'u3', 'Due Member belongs to Shakil');
  });
  await run('member cannot add members', async () => {
    expectStatus(await call('POST', '/api/members', { name: 'X', phone: '01811000003' }, tokens.sabbir), 403);
  });
  console.log('Passwords');
  await run('adding a member needs a starting password of 8+ characters', async () => {
    const base = { name: 'No Pass', phone: '01811000003', joinPeriod: '2026-10' };
    expectStatus(await call('POST', '/api/members', base, tokens.tanvir), 400);
    expectStatus(await call('POST', '/api/members', { ...base, password: 'short' }, tokens.tanvir), 400);
  });
  await run('member signs in with the starting password the collector set', async () => {
    expectStatus(await call('POST', '/api/members', { name: 'Pass Member', phone: '01811000003', joinPeriod: '2026-10', password: 'start-pass1' }, tokens.tanvir), 200);
    tokens.pass = await login('01811000003', 'start-pass1');
    expectStatus(await call('POST', '/api/auth/login', { phone: '01811000003', password: 'start-pass2' }), 401);
  });
  await run('member cannot reset passwords or edit members', async () => {
    expectStatus(await call('PATCH', '/api/members/u6', { password: 'hijack-pass' }, tokens.sabbir), 403);
  });
  await run('collector cannot reset a password outside their group', async () => {
    expectStatus(await call('PATCH', '/api/members/u9', { password: 'hijack-pass' }, tokens.tanvir), 403);
    await login('01711000009');   // u9 still has the demo password
  });
  await run('member changes own password: wrong current password refused, still signed in', async () => {
    expectStatus(await call('POST', '/api/auth/password', { current: 'bad-guess', password: 'new-pass-22' }, tokens.pass), 401);
    expectStatus(await call('GET', '/api/bootstrap', undefined, tokens.pass), 200);
  });
  await run('new password must be 8+ characters and different from the old one', async () => {
    expectStatus(await call('POST', '/api/auth/password', { current: 'start-pass1', password: 'short' }, tokens.pass), 400);
    expectStatus(await call('POST', '/api/auth/password', { current: 'start-pass1', password: 'start-pass1' }, tokens.pass), 400);
  });
  await run('changing password signs out other devices but not this one', async () => {
    const other = await login('01811000003', 'start-pass1');
    expectStatus(await call('POST', '/api/auth/password', { current: 'start-pass1', password: 'new-pass-22' }, tokens.pass), 200);
    expectStatus(await call('GET', '/api/bootstrap', undefined, tokens.pass), 200);
    expectStatus(await call('GET', '/api/bootstrap', undefined, other), 401);
    expectStatus(await call('POST', '/api/auth/login', { phone: '01811000003', password: 'start-pass1' }), 401);
    await login('01811000003', 'new-pass-22');
  });
  await run('admin resets a member password: old password fails and the member is signed out', async () => {
    const id = db.prepare("SELECT id FROM users WHERE phone = '01811000003'").get().id;
    expectStatus(await call('PATCH', `/api/members/${id}`, { password: 'reset-pass3' }, tokens.tanvir), 200);
    expectStatus(await call('GET', '/api/bootstrap', undefined, tokens.pass), 401);
    expectStatus(await call('POST', '/api/auth/login', { phone: '01811000003', password: 'new-pass-22' }), 401);
    await login('01811000003', 'reset-pass3');
    expectStatus(await call('PATCH', `/api/members/${id}`, { password: 'x' }, tokens.tanvir), 400);
  });
  await run('dup TrxID: Test Member submits a screenshot reusing a pending TrxID', async () => {
    const m1t = await login('01811000001', 'start-pass1');
    tokens.m1 = m1t;
    const r = await call('POST', '/api/requests', { kind: 'screenshot', period: '2026-10', amount: 200, trx: 'BK7Q2M9X1A', imageDataUrl: receiptDataUrl }, m1t);
    expectStatus(r, 200);
    const c = await call('GET', '/api/bootstrap', undefined, tokens.tanvir);
    const req = c.data.requests.find(x => x.id === r.data.id);
    assert.ok(req.dup, 'collector should see a duplicate warning');
    const conf = await call('POST', `/api/requests/${r.data.id}/confirm`, { vok: true }, tokens.tanvir);
    expectStatus(conf, 409); assert.match(conf.data.error, /already used/);
    expectStatus(await call('POST', `/api/requests/${r.data.id}/reject`, { reason: 'TrxID already used' }, tokens.tanvir), 200);
    const after = await call('GET', '/api/bootstrap', undefined, m1t);
    assert.strictEqual(after.data.board[m1]['2026-10'].s, 'due');
    assert.ok(after.data.notifications.some(n => n.kind === 'bad'), 'member notified of rejection');
  });
  await run('Due Member submits a clean screenshot and collector confirms', async () => {
    const m2t = await login('01811000002', 'start-pass1');
    tokens.m2 = m2t;
    const r = await call('POST', '/api/requests', { kind: 'screenshot', period: '2026-10', amount: 200, trx: '8N7A2K9X1B', receiver: '01711000002', paidText: ocrRes.paidText, ocr: true, imageDataUrl: receiptDataUrl }, m2t);
    expectStatus(r, 200);
    const shot = await call('GET', `/api/requests/${r.data.id}/shot`, undefined, m2t);
    expectStatus(shot, 200);
    expectStatus(await call('GET', `/api/requests/${r.data.id}/shot`, undefined, tokens.tanvir), 403);
    expectStatus(await call('POST', `/api/requests/${r.data.id}/confirm`, { vok: true }, tokens.tanvir), 403);
    expectStatus(await call('POST', `/api/requests/${r.data.id}/confirm`, { vok: false }, tokens.shakil), 400);
    expectStatus(await call('POST', `/api/requests/${r.data.id}/confirm`, { vok: true }, tokens.shakil), 200);
    const after = await call('GET', '/api/bootstrap', undefined, m2t);
    assert.strictEqual(after.data.board[m2]['2026-10'].s, 'paid');
    assert.strictEqual(after.data.board[m2]['2026-10'].trx, '8N7A2K9X1B');
  });
  await run('member cannot submit again once paid', async () => {
    expectStatus(await call('POST', '/api/requests', { kind: 'screenshot', period: '2026-10', amount: 200, trx: 'ZZZ99999', imageDataUrl: receiptDataUrl }, tokens.m2), 409);
  });
  await run('pending screenshot blocks a second one', async () => {
    expectStatus(await call('POST', '/api/requests', { kind: 'screenshot', period: '2026-10', amount: 200, trx: 'QQQ11111', imageDataUrl: receiptDataUrl }, tokens.sabbir), 409);
  });
  await run('amount mismatch is blocked on confirm (Fahim ৳150 vs ৳200)', async () => {
    const r = await call('POST', '/api/requests/3/confirm', { vok: true }, tokens.tanvir);
    expectStatus(r, 409); assert.match(r.data.error, /does not match/);
  });
  await run('rejection requires a reason', async () => {
    expectStatus(await call('POST', '/api/requests/3/reject', { reason: '' }, tokens.tanvir), 400);
  });
  await run('collector outside the group cannot reject either', async () => {
    expectStatus(await call('POST', '/api/requests/3/reject', { reason: 'x' }, tokens.shakil), 403);
  });
  await run('Sabbir request 1 confirms (real TrxID, amount matches)', async () => {
    expectStatus(await call('POST', '/api/requests/1/confirm', { vok: true }, tokens.tanvir), 200);
    const b = await call('GET', '/api/bootstrap', undefined, tokens.sabbir);
    assert.strictEqual(b.data.board['u6']['2026-10'].s, 'paid');
    assert.strictEqual(b.data.board['u6']['2026-10'].trx, 'BK7Q2M9X1A');
    expectStatus(await call('POST', '/api/requests/1/confirm', { vok: true }, tokens.tanvir), 409);
  });
  await run('shot of a request is only for self and group collector', async () => {
    expectStatus(await call('GET', '/api/requests/1/shot', undefined, tokens.sabbir), 200);
    expectStatus(await call('GET', '/api/requests/1/shot', undefined, tokens.shakil), 403);
    expectStatus(await call('GET', '/api/requests/1/shot', undefined, tokens.tanvir), 200);
  });

  console.log('Notes, notifications, tasks');
  await run('Test Member posts a "won\'t pay" note (status becomes note)', async () => {
    expectStatus(await call('POST', '/api/remarks', { period: '2026-10', reason: 'Travelling' }, tokens.rahim), 409);
    expectStatus(await call('POST', '/api/remarks', { period: '2026-10', reason: 'Travelling', text: 'Back in November' }, tokens.m1), 200);
    const b = await call('GET', '/api/bootstrap', undefined, tokens.sabbir);
    assert.strictEqual(b.data.board[m1]['2026-10'].s, 'note');
    assert.strictEqual(b.data.board[m1]['2026-10'].reason, 'Travelling');
  });
  await run('member payment request (update kind) notifies collector', async () => {
    const r = await call('POST', '/api/requests', { kind: 'update', period: '2026-10', message: 'Will pay on Friday', method: 'bKash' }, tokens.m1);
    expectStatus(r, 200);
    const c = await call('GET', '/api/bootstrap', undefined, tokens.tanvir);
    assert.ok(c.data.notifications.some(n => /Status update/.test(n.title)));
  });
  await run('collector notifies only selected unpaid members', async () => {
    const r = await call('POST', '/api/notify', { period: '2026-10', mode: 'selected', userIds: ['u4', m1], message: 'Hi {name}, October is due.' }, tokens.tanvir);
    expectStatus(r, 200); assert.strictEqual(r.data.sent, 1);
    expectStatus(await call('POST', '/api/notify', { period: '2026-10', mode: 'selected', userIds: ['u4'], message: 'x' }, tokens.tanvir), 400);
  });
  await run('bulk notify to all unpaid group members', async () => {
    const r = await call('POST', '/api/notify', { period: '2026-10', mode: 'unpaid', message: 'Reminder for {month}' }, tokens.tanvir);
    expectStatus(r, 200); assert.ok(r.data.sent >= 1);
  });
  await run('collector cannot notify another group', async () => {
    expectStatus(await call('POST', '/api/notify', { period: '2026-10', mode: 'selected', userIds: ['u9'], message: 'x' }, tokens.tanvir), 400);
  });
  await run('admin creates a collection task for a collector', async () => {
    expectStatus(await call('POST', '/api/tasks', { collectorId: 'u2', period: '2026-10', title: 'Collect October – Group A', dueText: '20 Oct' }, tokens.admin), 200);
    expectStatus(await call('POST', '/api/tasks', { collectorId: 'u2', period: '2026-10', title: 'x' }, tokens.tanvir), 403);
  });
  await run('collector updates own bKash number; member cannot', async () => {
    expectStatus(await call('PUT', '/api/me/bkash', { bkash: '01712345678' }, tokens.tanvir), 200);
    expectStatus(await call('PUT', '/api/me/bkash', { bkash: '01712345678' }, tokens.sabbir), 403);
  });
  await run('monthly amount: collector and admin can set; member cannot', async () => {
    expectStatus(await call('PUT', '/api/amounts/2026-10', { amount: 250 }, tokens.sabbir), 403);
    expectStatus(await call('PUT', '/api/amounts/2026-10', { amount: 250 }, tokens.tanvir), 200);
    const b = await call('GET', '/api/bootstrap', undefined, tokens.admin);
    assert.strictEqual(b.data.board['u8']['2026-10'].amount, 250);
    expectStatus(await call('PUT', '/api/amounts/2026-10', { amount: 200 }, tokens.admin), 200);
  });
  await run('admin-only settings: share and club bKash', async () => {
    expectStatus(await call('PUT', '/api/settings', { defaultShare: 200, dueDay: 10 }, tokens.tanvir), 403);
    expectStatus(await call('PUT', '/api/settings', { defaultShare: 200, dueDay: 10 }, tokens.admin), 200);
    expectStatus(await call('PUT', '/api/settings/club-bkash', { name: 'Mahbub Alam', no: '01711000001' }, tokens.admin), 200);
  });
  await run('admin assigns collector; collector cannot reassign', async () => {
    expectStatus(await call('PATCH', '/api/members/u4', { collectorId: 'u3' }, tokens.tanvir), 200); // ignored
    let b = await call('GET', '/api/bootstrap', undefined, tokens.admin);
    assert.strictEqual(b.data.members.find(m => m.id === 'u4').collectorId, 'u2');
    expectStatus(await call('PATCH', '/api/members/u4', { collectorId: 'u3' }, tokens.admin), 200);
    expectStatus(await call('PATCH', '/api/members/u4', { collectorId: 'u2' }, tokens.admin), 200);
  });

  console.log('Payments and removal');
  await run('collector records cash for own member; duplicate blocked', async () => {
    expectStatus(await call('POST', '/api/payments', { userId: m1, period: '2026-10', method: 'Cash' }, tokens.tanvir), 200);
    expectStatus(await call('POST', '/api/payments', { userId: m1, period: '2026-10', method: 'Cash' }, tokens.tanvir), 409);
  });
  await run('collector cannot record for another group', async () => {
    expectStatus(await call('POST', '/api/payments', { userId: 'u9', period: '2026-10', method: 'Cash' }, tokens.tanvir), 403);
  });
  await run('bKash payment needs TrxID and rejects duplicates', async () => {
    expectStatus(await call('POST', '/api/payments', { userId: 'u7', period: '2026-10', method: 'bKash', trx: '' }, tokens.tanvir), 400);
    expectStatus(await call('POST', '/api/payments', { userId: 'u7', period: '2026-10', method: 'bKash', trx: '8N7A2K9X1B' }, tokens.tanvir), 409);
    expectStatus(await call('POST', '/api/payments', { userId: 'u7', period: '2026-10', method: 'bKash', trx: 'MANUAL77XY' }, tokens.tanvir), 200);
  });
  await run('admin removes a member (deactivates, keeps history)', async () => {
    expectStatus(await call('PATCH', `/api/members/${m1}`, { active: false }, tokens.tanvir), 200);
    const b = await call('GET', '/api/bootstrap', undefined, tokens.admin);
    assert.ok(!b.data.members.find(m => m.id === m1), 'inactive member hidden from roster');
    const h = db.prepare('SELECT COUNT(*) c FROM payments WHERE user_id = ?').get(m1).c;
    assert.strictEqual(h, 1, 'payment history kept');
    expectStatus(await call('POST', '/api/auth/login', { phone: '01811000001', password: 'start-pass1' }), 401);
  });

  console.log('Board privacy and logout');
  await run('admin board: all payers have a row for every month', async () => {
    const b = await call('GET', '/api/bootstrap', undefined, tokens.admin);
    assert.strictEqual(Object.keys(b.data.board).length, 12, '10 seeded payers + Due Member + Pass Member (Test Member removed)');
    assert.ok(b.data.periods.includes('2026-10') && b.data.periods[0] === '2026-01');
  });
  await run('logout invalidates the session', async () => {
    const t = await login('01711000006');
    expectStatus(await call('GET', '/api/bootstrap', undefined, t), 200);
    expectStatus(await call('POST', '/api/auth/logout', {}, t), 200);
    expectStatus(await call('GET', '/api/bootstrap', undefined, t), 401);
  });
  await run('session persists across requests until logout', async () => {
    const t = await login('01711000008');
    for (let i = 0; i < 3; i++) expectStatus(await call('GET', '/api/bootstrap', undefined, t), 200);
  });

  console.log('Production mode (DEMO=0)');
  {
    const prodDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crt-prod-'));
    process.env.ADMIN_PHONE = '01700000001';
    process.env.ADMIN_NAME = 'Test Admin';
    process.env.ADMIN_PASSWORD = 'admin-pass-1';
    const prod = createApp({ dbPath: path.join(prodDir, 'prod.db'), uploadsDir: path.join(prodDir, 'up'), demo: false });
    delete process.env.ADMIN_PHONE; delete process.env.ADMIN_NAME; delete process.env.ADMIN_PASSWORD;
    const ps = await new Promise(r => { const x = prod.app.listen(0, '127.0.0.1', () => r(x)); });
    const pbase = `http://127.0.0.1:${ps.address().port}`;
    const pcall = async (method, url, body) => {
      const r = await fetch(pbase + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, data: await r.json().catch(() => null) };
    };
    await run('production: no demo accounts are exposed', async () => {
      const d = await pcall('GET', '/api/demo-accounts'); assert.deepStrictEqual(d.data.accounts, []);
      const h = await pcall('GET', '/api/health'); assert.strictEqual(h.data.demo, false);
    });
    await run('production: first admin created from ADMIN_PHONE and ADMIN_PASSWORD, no demo members', async () => {
      const count = prod.db.prepare('SELECT COUNT(*) c FROM users').get().c;
      assert.strictEqual(count, 1, 'only the admin should exist');
      const u = prod.db.prepare('SELECT name, phone, role, password_hash FROM users').get();
      assert.deepStrictEqual([u.name, u.phone, u.role], ['Test Admin', '01700000001', 'admin']);
      assert.match(u.password_hash, /^scrypt\$/);
      assert.strictEqual(prod.db.prepare('SELECT COUNT(*) c FROM payments').get().c, 0);
    });
    await run('production: admin signs in with ADMIN_PASSWORD only', async () => {
      expectStatus(await pcall('POST', '/api/auth/login', { phone: '01700000001', password: 'admin-pass-1' }), 200);
      expectStatus(await pcall('POST', '/api/auth/login', { phone: '01700000001', password: DEMO_PW }), 401);
    });
    await run('production: no demo accounts are offered and the health check says demo:false', async () => {
      const d = await pcall('GET', '/api/demo-accounts'); assert.deepStrictEqual(d.data.accounts, []);
      assert.strictEqual(d.data.password, undefined, 'no demo password exposed');
      const h = await pcall('GET', '/api/health'); assert.strictEqual(h.data.demo, false);
    });
    await run('production: startup refuses ADMIN_PHONE without a valid ADMIN_PASSWORD', async () => {
      process.env.ADMIN_PHONE = '01700000009';
      delete process.env.ADMIN_PASSWORD;
      let threw = false;
      try { createApp({ dbPath: path.join(prodDir, 'nopw.db'), uploadsDir: path.join(prodDir, 'up3'), demo: false }); }
      catch (e) { threw = /ADMIN_PASSWORD/.test(e.message); }
      process.env.ADMIN_PASSWORD = 'short';
      let threwShort = false;
      try { createApp({ dbPath: path.join(prodDir, 'nopw.db'), uploadsDir: path.join(prodDir, 'up3'), demo: false }); }
      catch (e) { threwShort = /ADMIN_PASSWORD/.test(e.message); }
      delete process.env.ADMIN_PHONE; delete process.env.ADMIN_PASSWORD;
      assert.ok(threw && threwShort, 'expected startup error for missing and short ADMIN_PASSWORD');
    });
    await run('production: invalid ADMIN_PHONE is rejected at startup', async () => {
      process.env.ADMIN_PHONE = 'abc';
      process.env.ADMIN_PASSWORD = 'admin-pass-1';
      let threw = false;
      try { createApp({ dbPath: path.join(prodDir, 'bad.db'), uploadsDir: path.join(prodDir, 'up2'), demo: false }); }
      catch (e) { threw = /ADMIN_PHONE/.test(e.message); }
      delete process.env.ADMIN_PHONE; delete process.env.ADMIN_PASSWORD;
      assert.ok(threw, 'expected startup error');
    });
    ps.close();
    fs.rmSync(prodDir, { recursive: true, force: true });
  }

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { console.log('Failed:', fails.join('; ')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
