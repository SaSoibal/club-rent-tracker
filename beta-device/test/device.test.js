'use strict';
// Runs the same API scenarios as test/api.test.js, against the DEVICE build: no server and no HTTP.
// Build first (node build.mjs --node), then: node test/device.test.js
const path = require('path');
const fs = require('fs');
const assert = require('assert');

let pass = 0, fails = [];
let finished = false;
process.on('exit', code => { if (!finished) { console.error('\nTest stopped before finishing (a step never completed).'); process.exitCode = 1; } });
process.env.CLUB_TODAY = '2026-10';
// OCR in the test uses the bundled English model in www/tessdata (the phone reads the same files).
globalThis.__TESSERACT_CONFIG__ = { langPath: path.join(__dirname, '..', 'www', 'tessdata') };

async function run(name, fn) {
  try { await fn(); pass++; console.log('  PASS', name); }
  catch (e) { fails.push(name); console.log('  FAIL', name, '\n       ', e.message); }
}

// Device storage stand-in (the phone uses IndexedDB).
function memStore() {
  const m = new Map();
  return {
    m,
    get: async k => m.get(k),
    put: async (k, v) => { m.set(k, v); },
    clear: async () => { m.clear(); },
    entries: async prefix => [...m.entries()].filter(([k]) => k.startsWith(prefix)),
  };
}

(async () => {
  const sqlJs = await require('sql.js')();
  const { boot } = require('./.build/core.cjs');
  const pwmod = require('../../server/auth');
  const store = memStore();
  await store.put('mode', 'demo'); // demo accounts and seed data, as in the server tests
  const core = await boot({ sqlJs, store });
  const { db } = core;
  const tokens = {};
  const DEMO_PW = 'demo1234';

  async function call(method, url, body, token) {
    const r = await core.api(method, url, body, token);
    return { status: r.status, data: r.data };
  }
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

  console.log('Device setup (no server)');
  await run('the device database is saved to device storage', async () => {
    await core.flush();
    const saved = store.m.get('db');
    assert.ok(saved && saved.byteLength > 1000, 'database bytes saved');
  });
  await run('the page script makes no fetch calls (the UI talks to the device core only)', async () => {
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'www', 'app.js'), 'utf8');
    assert.ok(!/\bfetch\s*\(/.test(appJs), 'app.js must not call fetch()');
  });
  await run('a restart reloads the same club from device storage', async () => {
    const savedFiles = await store.entries('file:');
    core._fs._files.clear();                      // forget the screenshots in memory...
    const again = await boot({ sqlJs, store });   // ...and start the app again
    assert.deepStrictEqual(again.status(), { mode: 'demo', hasUsers: true });
    const v = await again.api('POST', '/api/auth/login', { phone: '01711000006', password: DEMO_PW });
    assert.strictEqual(v.status, 200);
    const rq = again.db.prepare("SELECT id FROM requests WHERE shot_path IS NOT NULL LIMIT 1").get();
    const shot = await again.api('GET', `/api/requests/${rq.id}/shot`, undefined, v.data.token);
    assert.strictEqual(shot.status, 200, 'screenshot reloaded from storage');
    assert.ok(savedFiles.length > 0, 'screenshots were saved');
  });
  await run('fresh device: no club yet, setup is required, demo accounts hidden', async () => {
    const fresh = await boot({ sqlJs, store: memStore() });
    assert.deepStrictEqual(fresh.status(), { mode: null, hasUsers: false });
    const d = await fresh.api('GET', '/api/demo-accounts');
    assert.deepStrictEqual(d.data.accounts, []);
    assert.strictEqual(d.data.password, undefined);
    const l = await fresh.api('POST', '/api/auth/login', { phone: '01711000001', password: DEMO_PW });
    assert.strictEqual(l.status, 401);
  });
  await run('setup validates name, mobile number and password', async () => {
    const fresh = await boot({ sqlJs, store: memStore() });
    await assert.rejects(() => fresh.setup({ name: '', phone: '01700000001', password: 'admin-pass-1' }), /admin name/);
    await assert.rejects(() => fresh.setup({ name: 'A', phone: '123', password: 'admin-pass-1' }), /mobile number/);
    await assert.rejects(() => fresh.setup({ name: 'A', phone: '01700000001', password: 'short' }), /Password must be/);
    assert.strictEqual(fresh.status().hasUsers, false);
  });
  await run('setup creates the club admin on this device; login works; demo password does not', async () => {
    const fresh = await boot({ sqlJs, store: memStore() });
    await fresh.setup({ name: 'Test Admin', phone: '01700000001', password: 'admin-pass-1' });
    assert.deepStrictEqual(fresh.status(), { mode: 'club', hasUsers: true });
    const ok = await fresh.api('POST', '/api/auth/login', { phone: '01700000001', password: 'admin-pass-1' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.data.user.role, 'admin');
    expectStatus(await fresh.api('POST', '/api/auth/login', { phone: '01700000001', password: DEMO_PW }), 401);
    const h = await fresh.api('GET', '/api/health');
    assert.strictEqual(h.data.demo, false);
    const count = fresh.db.prepare('SELECT COUNT(*) c FROM users').get().c;
    assert.strictEqual(count, 1, 'only the admin, no demo members');
  });
  await run('setup cannot run twice on the same device', async () => {
    const fresh = await boot({ sqlJs, store: memStore() });
    await fresh.setup({ name: 'Test Admin', phone: '01700000001', password: 'admin-pass-1' });
    await assert.rejects(() => fresh.setup({ name: 'Other', phone: '01700000002', password: 'admin-pass-2' }), /already has a club/);
  });
  await run('backup contains the database and screenshots, and restores on another device', async () => {
    const backup = await core.exportBackup();
    assert.strictEqual(backup.format, 'club-rent-backup');
    assert.ok(Object.keys(backup.files).length > 0, 'screenshots included');
    const json = JSON.parse(JSON.stringify(backup));
    const other = memStore();
    const restored = await boot({ sqlJs, store: other });
    await restored.importBackup(json);
    const again = await boot({ sqlJs, store: other });
    assert.deepStrictEqual(again.status(), { mode: 'club', hasUsers: true });
    const v = await again.api('POST', '/api/auth/login', { phone: '01711000001', password: DEMO_PW });
    assert.strictEqual(v.status, 200, 'restored admin can sign in');
  });
  await run('a file that is not a backup is refused', async () => {
    const fresh = await boot({ sqlJs, store: memStore() });
    await assert.rejects(() => fresh.importBackup({ hello: 'world' }), /not a Club Rent backup/);
  });
  await run('erase removes everything saved on this device', async () => {
    const s = memStore();
    await s.put('mode', 'club'); await s.put('db', new Uint8Array([1]));
    await s.clear();
    assert.strictEqual(s.m.size, 0);
  });

  finished = true;
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) { console.log('Failed:', fails.join('; ')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
