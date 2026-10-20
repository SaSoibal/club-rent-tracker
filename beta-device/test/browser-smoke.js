'use strict';
// Browser test of the phone app (run after `node build.mjs` with the app served on port 8080).
//   node test/browser-smoke.js
// Needs the 'playwright' package and Chromium. Not part of `npm test` (which is the fast core test).
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:8080/';
const RECEIPT = path.join(__dirname, 'fixtures', 'receipt.png');
const BACKUP = '/tmp/club-beta-backup.json';
const OUT = process.env.SHOT_DIR || '/tmp';
const ADMIN = { phone: '01700000001', password: 'admin-pass-1', name: 'Beta Admin' };
const results = [];
const check = (name, ok, extra = '') => { results.push([name, !!ok]); console.log(ok ? 'PASS' : 'FAIL', name, extra); };

(async () => {
  const browser = await chromium.launch();
  const external = [];
  const newPage = async (ctx) => {
    const page = await ctx.newPage();
    page.on('request', r => {
      const u = r.url();
      if (!u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
    });
    page.on('pageerror', e => console.log('  [pageerror]', e.message));
    return page;
  };

  // ---- Phone A: set up the club on this phone ----
  const ctxA = await browser.newContext({ acceptDownloads: true });
  const a = await newPage(ctxA);
  await a.goto(BASE);
  await a.waitForSelector('form[data-form=setup]', { timeout: 20000 });
  check('first open shows the setup screen (no server login)', true);
  await a.fill('input[name=name]', ADMIN.name);
  await a.fill('input[name=phone]', ADMIN.phone);
  await a.fill('input[name=password]', ADMIN.password);
  await a.fill('input[name=password2]', 'different-pass');
  await a.click('button[type=submit]');
  await a.waitForTimeout(800);
  check('mismatched passwords are refused', await a.locator('form[data-form=setup]').count() === 1);
  await a.fill('input[name=password2]', ADMIN.password);
  await a.click('button[type=submit]');
  await a.waitForSelector('nav.tabs', { timeout: 20000 });
  check('setup creates the admin and signs in', true);
  await a.screenshot({ path: path.join(OUT, 'beta-admin-home.png'), fullPage: true });

  await a.click('[data-act=tab][data-tab=setup]');
  await a.waitForSelector('text=Backup on this phone');
  check('admin sees the backup section in Setup', true);

  const [dl] = await Promise.all([a.waitForEvent('download'), a.click('[data-act=exportBackup]')]);
  await dl.saveAs(BACKUP);
  const backup = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
  check('backup file downloads and has the club database', backup.format === 'club-rent-backup' && backup.db.length > 1000);

  await a.reload();
  await a.waitForSelector('nav.tabs', { timeout: 20000 });
  check('stays signed in after reload (data kept on the phone)', true);

  await ctxA.setOffline(true);
  await a.reload();
  await a.waitForSelector('nav.tabs', { timeout: 20000 });
  check('app opens and works with no internet connection', true);
  await ctxA.setOffline(false);

  await a.click('[data-act=tab][data-tab=setup]');
  a.once('dialog', d => d.accept());
  await a.click('[data-act=eraseDevice]');
  await a.waitForSelector('form[data-form=setup]', { timeout: 20000 });
  check('erase returns the phone to first-time setup', true);

  a.once('dialog', d => d.accept());
  await a.setInputFiles('input[data-change=restoreBackup]', BACKUP);
  await a.waitForSelector('form[data-form=login]', { timeout: 20000 });
  await a.fill('input[name=phone]', ADMIN.phone);
  await a.fill('input[name=password]', ADMIN.password);
  await a.click('button[type=submit]');
  await a.waitForSelector('nav.tabs', { timeout: 20000 });
  check('restoring the backup brings back the admin login', true);
  await ctxA.close();

  // ---- Phone B: sample data, member pays by bKash screenshot ----
  const ctxB = await browser.newContext();
  const b = await newPage(ctxB);
  await b.goto(BASE);
  await b.waitForSelector('[data-act=startDemo]', { timeout: 20000 });
  await b.click('[data-act=startDemo]');
  await b.waitForSelector('button[data-act=demo]', { timeout: 30000 });
  check('sample data loads on this phone', true);
  // The sample member's October screenshot is already waiting for review. The admin rejects it,
  // so the member is Due again and can pay with a new screenshot.
  await b.click('button[data-act=demo]:has-text("Admin")');
  await b.waitForSelector('nav.tabs', { timeout: 20000 });
  await b.click('[data-act=tab][data-tab=requests]');
  const rejected = await b.evaluate(() => {
    for (const f of document.querySelectorAll('form[data-form=reject]')) {
      let el = f.parentElement;
      while (el && !el.textContent.includes('Sabbir Ahmed')) el = el.parentElement;
      if (el && el.querySelectorAll('form[data-form=reject]').length === 1) { f.querySelector('button[type=submit]').click(); return true; }
    }
    return false;
  });
  check('admin rejects the pending screenshot of the sample member', rejected);
  await b.waitForTimeout(1000);
  await b.click('[data-act=logout]');
  await b.waitForSelector('button[data-act=demo]', { timeout: 20000 });
  await b.click('button[data-act=demo]:has-text("Member")');
  await b.waitForSelector('nav.tabs', { timeout: 20000 });
  check('demo member signs in', true);

  // Find a month that is due for this member (the sample data has paid and due months).
  const months = await b.locator('button[data-act=month]').evaluateAll(els => els.map(e => e.dataset.p));
  let dueFound = await b.locator('[data-act=paySheet]').count() > 0;
  for (const p of months) {
    if (dueFound) break;
    await b.click(`button[data-act=month][data-p="${p}"]`);
    dueFound = await b.locator('[data-act=paySheet]').count() > 0;
  }
  check('sample member has a due month to pay', dueFound);
  await b.click('[data-act=paySheet]');
  await b.waitForSelector('input[name=file]', { timeout: 10000 });
  await b.setInputFiles('input[name=file]', RECEIPT);
  await b.waitForFunction(() => /Read from the screenshot|could not find|Could not read/.test(document.querySelector('#ocrState')?.textContent || ''), null, { timeout: 120000 });
  const state = await b.textContent('#ocrState');
  const amount = await b.inputValue('input[name=amount]');
  const trx = await b.inputValue('input[name=trx]');
  check('screenshot is read on the phone: amount ৳200 and TrxID', amount === '200' && trx === '8N7A2K9X1B', `amount=${amount} trx=${trx} (${state})`);
  await b.screenshot({ path: path.join(OUT, 'beta-member-pay.png'), fullPage: false });

  await b.click('form[data-form=shot] button[type=submit]');
  await b.waitForFunction(() => !document.querySelector('form[data-form=shot]'), null, { timeout: 20000 }).catch(() => {});
  check('payment screenshot is sent to the collector', await b.locator('form[data-form=shot]').count() === 0);

  await ctxB.setOffline(true);
  await b.reload();
  await b.waitForSelector('nav.tabs', { timeout: 20000 });
  check('member still signed in and data present with no internet', true);
  await b.screenshot({ path: path.join(OUT, 'beta-member-home.png'), fullPage: true });
  await ctxB.close();
  await browser.close();

  const ext = [...new Set(external)];
  check('no request went to any other website or server', ext.length === 0, ext.slice(0, 5).join(' ') || '');
  const failed = results.filter(r => !r[1]);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
