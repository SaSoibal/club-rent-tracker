/* Club Rent Tracker (beta, device-only) — mobile-first SPA.
 * Same screens and rules as the server app. Data lives on this phone; the server code runs inside the page. */
(() => {
'use strict';

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONF = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const LBL = { paid: 'Paid', due: 'Due', note: "Won't pay", review: 'Under review', future: '—', na: '—' };
const UNPAID = ['due', 'note', 'review'];
const BKASH_INTENT = 'intent://#Intent;package=com.bKash.customerapp;end';
const REASONS = ['Travelling', 'Money problem', 'Out of town', 'Family emergency', 'Other'];
const REJECTS = ['Amount does not match the due', 'TrxID not found or wrong', 'Screenshot unclear', 'Already paid', 'Other'];

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '৳' + Number(n || 0).toLocaleString('en-US');
const pl = p => { const [y, m] = p.split('-'); return MON[+m - 1] + ' ' + y; };
const plLong = p => { const [y, m] = p.split('-'); return MONF[+m - 1] + ' ' + y; };
const when = iso => iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dhaka', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)) : '';

const S = {
  token: localStorage.getItem('crt_token'),
  mode: null, boot: null, tab: 'home', month: null,
  demo: [], demoPassword: '', login: { phone: '' },
  shots: {}, pendingShot: null, busy: false
};
const app = document.getElementById('app');
const modalRoot = document.getElementById('modal');

/* ---------- plumbing ---------- */
let toastTimer;
function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show ' + kind;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.className = 'toast', 2800);
}
class AuthError extends Error {}
async function api(method, url, body) {
  // Calls the club server code that runs on this phone. No network request is made.
  const r = await window.clubApi(method, url, body, S.token);
  const data = r.data;
  if (r.status === 401 && S.token && !url.startsWith('/api/auth/')) { signOutLocal(); throw new AuthError('Please sign in again'); }
  if (r.status >= 400) throw new Error((data && data.error) || ('Request failed (' + r.status + ')'));
  return data;
}
async function loadBoot() {
  S.boot = await api('GET', '/api/bootstrap');
  if (!S.month || !S.boot.periods.includes(S.month)) S.month = S.boot.today;
  render();
}
async function refresh() { try { await loadBoot(); } catch (e) { if (!(e instanceof AuthError)) toast(e.message, 'bad'); } }
function signOutLocal() {
  S.token = null; S.boot = null; localStorage.removeItem('crt_token'); S.shots = {};
  Object.values(S.shots).forEach(u => URL.revokeObjectURL && u && URL.revokeObjectURL(u));
  S.login = { phone: '' };
  render();
}
const isStaff = () => ['admin', 'collector'].includes(S.boot.me.role);
const isAdmin = () => S.boot.me.role === 'admin';
const meId = () => S.boot.me.id;
const curPeriod = () => S.boot.today;
function cell(uid, p) { return (S.boot.board[uid] || {})[p]; }
function amountOf(c, p) { return (c && c.amount != null) ? c.amount : (S.boot.amounts[p] ?? S.boot.settings.defaultShare); }
function outstanding(uid) {
  let n = 0, total = 0;
  for (const p of S.boot.periods) {
    const c = cell(uid, p);
    if (c && UNPAID.includes(c.s)) { n++; total += amountOf(c, p); }
  }
  return { n, total };
}
function tabsFor(role) {
  if (role === 'member') return [['home', 'Home', '🏠'], ['board', 'Board', '📋'], ['alerts', 'Alerts', '🔔']];
  return [['home', 'Home', '🏠'], ['collect', 'Collect', '💰'], ['requests', 'Requests', '📥'], ['members', 'Members', '👥'], ['board', 'Board', '📋'], ['setup', 'Setup', '⚙️'], ['alerts', 'Alerts', '🔔']];
}

/* ---------- rendering shell ---------- */
function render() {
  if (!S.boot) { app.innerHTML = S.mode ? loginHtml() : setupHtml(); return; }
  const tabs = tabsFor(S.boot.me.role);
  if (!tabs.some(t => t[0] === S.tab)) S.tab = 'home';
  const views = { home: vHome, collect: vCollect, requests: vRequests, members: vMembers, board: vBoard, setup: vSetup, alerts: vAlerts };
  const unread = S.boot.unread;
  app.innerHTML = `
    <header class="top">
      <span class="title">💸 Club Rent</span>
      <span class="bell" data-act="tab" data-tab="alerts" title="Alerts">🔔${unread ? `<span class="badge">${unread}</span>` : ''}</span>
      <button data-act="logout">Log out</button>
    </header>
    <main>${views[S.tab]()}</main>
    <nav class="tabs" aria-label="Main">${tabs.map(([id, label, ic]) =>
      `<button data-act="tab" data-tab="${id}" class="${S.tab === id ? 'on' : ''}"><span class="ic">${ic}</span>${label}${id === 'requests' && pendingCount() ? ` <span class="badge" style="position:static">${pendingCount()}</span>` : ''}</button>`).join('')}</nav>`;
}
function pendingCount() { return isStaff() ? S.boot.requests.filter(r => r.status === 'pending').length : 0; }

function loginHtml() {
  const L = S.login;
  const demo = S.demo.length ? `<div class="chips">${S.demo.map(a => `<button data-act="demo" data-phone="${esc(a.phone)}">${esc(a.label)} · ${esc(a.phone)}</button>`).join('')}</div>` : '';
  return `<div class="login">
    <div class="brand">💸 Club Rent Tracker</div>
    <p class="muted">Monthly share <b>৳200</b> · pay by cash or bKash · see who has paid.</p>
    <div class="card">
      <h3>Sign in</h3>
      <form data-form="login" class="stack">
        <label>Mobile number<input name="phone" type="tel" inputmode="tel" autocomplete="username" placeholder="01XXXXXXXXX" value="${esc(L.phone)}" required></label>
        <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
        <div class="actions"><button class="primary" type="submit">Sign in</button></div>
      </form>
      ${demo ? `<p class="hint">Demo accounts (password ${esc(S.demoPassword)}):</p>${demo}` : ''}
      <p class="hint">No password yet? Ask your admin or collector.</p>
    </div>
    <p class="hint">You stay signed in on this device until you log out.</p>
  </div>`;
}

/* ---------- small UI helpers ---------- */
function statusChip(s) { return `<span class="chip ${s}">${LBL[s] || s}</span>`; }
function detailLines(c) {
  const rows = [];
  if (c.method) rows.push(['Method', c.method]);
  if (c.date) rows.push(['Date', c.date]);
  if (c.trx && c.trx !== '—') rows.push(['TrxID', c.trx]);
  if (c.receiver) rows.push(['Receiver', c.receiver]);
  if (c.verifiedBy) rows.push(['Recorded/verified by', c.verifiedBy]);
  return rows.length ? rows.map(([k, v]) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('') : '';
}
function statusCard(uid, p, opts = {}) {
  const c = cell(uid, p); if (!c) return '';
  const isMe = uid === meId();
  const amt = amountOf(c, p);
  let body = `<div class="row between"><div><div class="muted small">${plLong(p)} rent</div><div class="big">${money(amt)}</div></div>${statusChip(c.s)}</div>`;
  if (c.s === 'paid') body += `<div style="margin-top:8px">${detailLines(c)}</div>`;
  if (c.s === 'note') body += `<div class="note"><b>Won't pay:</b> ${esc(c.reason || '')}${c.text ? ' — ' + esc(c.text) : ''}${c.promise ? `<br><span class="small">Promised by: ${esc(c.promise)}</span>` : ''}</div>`;
  if (c.s === 'review') body += `<div class="hint">Your screenshot is waiting for the collector to verify. Status changes after confirmation.</div>`;
  if (isMe && (c.s === 'due' || c.s === 'note')) {
    body += `<div class="actions">
      <button class="primary" data-act="paySheet" data-p="${p}">Pay via bKash</button>
      <button data-act="cashReq" data-p="${p}">I'll pay cash</button>
      <button data-act="noteSheet" data-p="${p}">Won't pay this month</button>
      <button data-act="updateSheet" data-p="${p}">Ask for update</button></div>`;
  }
  if (opts.title) return `<div class="card"><h3>${esc(opts.title)}</h3>${body}</div>`;
  return `<div class="card">${body}</div>`;
}

/* ---------- views ---------- */
function vHome() {
  const b = S.boot, me = b.me, cur = curPeriod();
  let h = `<div class="card hero"><div class="muted small">Signed in as</div><h2>${esc(me.name)}</h2>
    <span class="pill">${esc(me.role)}</span> <span class="muted small">${esc(me.phone || '')}</span>
    ${me.pays && me.payee ? `<div class="hint">Your payments go to <b>${esc(me.payee.name)}</b> · bKash ${esc(me.payee.no)}</div>` : ''}
    <div class="actions"><button data-act="changePassword">Change password</button></div></div>`;

  if (isAdmin()) {
    const payers = b.members.filter(m => m.pays);
    const cnt = { paid: 0, due: 0, note: 0, review: 0 };
    let collected = 0;
    payers.forEach(m => { const c = cell(m.id, cur); if (c) { cnt[c.s] = (cnt[c.s] || 0) + 1; if (c.s === 'paid') collected += c.amount; } });
    h += `<div class="sec-title">${pl(cur)} overview</div>
      <div class="kpis">
        <div class="kpi"><b>${cnt.paid}</b><span>Paid</span></div>
        <div class="kpi"><b>${cnt.due}</b><span>Due</span></div>
        <div class="kpi"><b>${cnt.note}</b><span>Won't pay</span></div>
        <div class="kpi"><b>${cnt.review}</b><span>Review</span></div>
      </div>
      <div class="card"><div class="kv"><span>Collected this month</span><b>${money(collected)}</b></div>
      <div class="kv"><span>Pending requests</span><b>${pendingCount()}</b></div></div>`;
  }
  if (isStaff() && !isAdmin()) {
    const grp = b.members.filter(m => m.pays && m.collectorId === me.id);
    const cnt = { paid: 0, due: 0, note: 0, review: 0 };
    grp.forEach(m => { const c = cell(m.id, cur); if (c) cnt[c.s] = (cnt[c.s] || 0) + 1; });
    h += `<div class="sec-title">My group · ${pl(cur)}</div>
      <div class="kpis">
        <div class="kpi"><b>${cnt.paid}</b><span>Paid</span></div>
        <div class="kpi"><b>${cnt.due}</b><span>Due</span></div>
        <div class="kpi"><b>${cnt.note}</b><span>Won't pay</span></div>
        <div class="kpi"><b>${cnt.review}</b><span>Review</span></div>
      </div>
      <div class="card"><div class="kv"><span>Pending requests</span><b>${pendingCount()}</b></div>
      <div class="actions"><button class="primary" data-act="tab" data-tab="collect">Open collection</button>
      <button data-act="tab" data-tab="requests">Verify requests</button></div></div>`;
  }
  if (me.pays) {
    h += statusCard(me.id, cur, { title: `This month · ${pl(cur)}` });
    const od = outstanding(me.id);
    h += `<div class="card"><div class="row between"><div><div class="muted small">Outstanding dues</div>
      <div class="big ${od.n ? 'bad' : ''}">${money(od.total)}</div></div><div class="right muted small">${od.n} month(s) unpaid</div></div></div>`;
    h += `<div class="sec-title">Payment history</div><div class="card list">${historyRows(me.id)}</div>`;
    const myReqs = b.requests.filter(r => r.userId === me.id);
    if (myReqs.length) h += `<div class="sec-title">My requests</div><div class="card list">${myReqs.slice(0, 10).map(reqRowMember).join('')}</div>`;
  }
  if (isAdmin()) {
    h += `<div class="sec-title">Collection tasks</div>${taskList()}`;
  }
  return h;
}
function historyRows(uid) {
  const rows = S.boot.periods.slice().reverse().map(p => {
    const c = cell(uid, p); if (!c) return '';
    const sub = c.s === 'paid' ? `${esc(c.method || '')}${c.trx && c.trx !== '—' ? ' · ' + esc(c.trx) : ''}${c.date ? ' · ' + esc(c.date) : ''}` : (c.s === 'note' ? esc(c.reason || "Won't pay") : (c.s === 'review' ? 'Screenshot under review' : 'Not paid yet'));
    return `<div class="item"><div class="grow"><b>${plLong(p)}</b><div class="small muted">${sub}</div></div>
      <div class="right"><div>${money(amountOf(c, p))}</div>${statusChip(c.s)}</div></div>`;
  }).join('');
  return rows || '<div class="empty">No history yet</div>';
}
function taskList() {
  const t = S.boot.tasks;
  if (!t.length) return '<div class="card empty">No collection tasks yet</div>';
  return `<div class="card list">${t.map(x => `<div class="item"><div class="grow"><b>${esc(x.title)}</b>
    <div class="small muted">${esc(x.collectorName)} · ${pl(x.period)} · due ${esc(x.dueText || '—')}</div></div>
    <div class="right"><b>${x.done}/${x.targets.length}</b><div class="small muted">paid</div></div></div>`).join('')}</div>`;
}

function monthStrip() {
  return `<div class="months">${S.boot.periods.map(p => `<button data-act="month" data-p="${p}" class="${S.month === p ? 'on' : ''}">${pl(p)}</button>`).join('')}</div>`;
}

function vCollect() {
  const b = S.boot, p = S.month, me = b.me;
  const rows = b.members.filter(m => m.pays && (isAdmin() || m.collectorId === me.id));
  const order = { due: 0, note: 1, review: 2, paid: 3, future: 4, na: 5 };
  const sorted = rows.map(m => ({ m, c: cell(m.id, p) || { s: 'na' } })).sort((a, b2) => (order[a.c.s] - order[b2.c.s]) || a.m.name.localeCompare(b2.m.name));
  const paid = sorted.filter(x => x.c.s === 'paid').length;
  const tasks = b.tasks.filter(t => t.period === p);
  let h = `<div class="sec-title">Collect · ${pl(p)}</div>${monthStrip()}`;
  h += `<div class="card"><div class="row between"><div><b>${paid}</b> of ${sorted.length} paid</div>
    <div class="right small muted">${isAdmin() ? 'All groups' : 'Your group'}</div></div>
    <div class="actions"><button data-act="notifyUnpaid" data-p="${p}" class="primary">Notify all unpaid</button>
    <button data-act="notifySelected" data-p="${p}">Notify selected</button></div></div>`;
  if (tasks.length) h += `<div class="sec-title">Tasks</div>${taskList()}`;
  h += `<div class="card list">`;
  if (!sorted.length) h += '<div class="empty">No members in your group yet</div>';
  for (const { m, c } of sorted) {
    const canAct = c.s !== 'paid' && c.s !== 'review' && c.s !== 'future' && c.s !== 'na';
    const grp = isAdmin() ? `<span class="small muted">· ${esc((b.members.find(x => x.id === m.collectorId) || {}).name || 'no collector')}</span>` : '';
    h += `<div class="item">
      <input type="checkbox" data-sel value="${m.id}" ${c.s === 'paid' ? 'disabled' : ''} aria-label="Select ${esc(m.name)}">
      <div class="grow"><button class="ghost" data-act="cell" data-uid="${m.id}" data-p="${p}" style="padding:0;font-weight:700">${esc(m.name)}</button> ${grp}
        <div class="small muted">${c.s === 'paid' ? esc(c.method || '') + (c.date ? ' · ' + esc(c.date) : '') : (c.s === 'note' ? esc(c.reason || "Won't pay") : (c.s === 'review' ? 'Screenshot to verify' : money(amountOf(c, p)) + ' due'))}</div>
        ${canAct ? `<div class="actions">
          <button data-act="recordCash" data-uid="${m.id}" data-p="${p}">Cash received</button>
          <button data-act="recordBkash" data-uid="${m.id}" data-p="${p}">bKash (TrxID)</button>
          <button data-act="remind" data-uid="${m.id}" data-p="${p}">Remind</button></div>` : ''}
      </div>
      <div class="right">${statusChip(c.s)}<div class="small">${money(amountOf(c, p))}</div></div></div>`;
  }
  h += '</div>';
  return h;
}

function reqRowMember(r) {
  const kind = r.kind === 'screenshot' ? 'bKash screenshot' : 'Status update';
  return `<div class="item"><div class="grow"><b>${pl(r.period)} · ${kind}</b>
    <div class="small muted">${r.kind === 'screenshot' ? money(r.amount) + ' · TrxID ' + esc(r.trx) : esc(r.message || '')} · ${when(r.createdAt)}</div>
    ${r.reason ? `<div class="small">${esc(r.reason)}</div>` : ''}</div>
    <div class="right"><span class="chip ${r.status}">${esc(r.status)}</span></div></div>`;
}
function reqCard(r) {
  const pending = r.status === 'pending';
  const isShot = r.kind === 'screenshot';
  const mismatch = isShot && r.amount !== r.expected;
  let h = `<div class="card req">
    <div class="row between"><div><b>${esc(r.userName)}</b> <span class="small muted">· ${pl(r.period)}</span></div>
    <span class="chip ${r.status}">${esc(r.status)}</span></div>
    <div class="small muted">${isShot ? 'bKash screenshot' : 'Status update'} · ${when(r.createdAt)}${r.ocr ? ' · read by app' : ''}</div>`;
  if (isShot) {
    h += `<div style="margin-top:8px">
      <div class="kv"><span>Amount</span><b class="${mismatch ? 'bad' : ''}">${money(r.amount)}${mismatch ? ' (due ' + money(r.expected) + ')' : ''}</b></div>
      <div class="kv"><span>TrxID</span><b>${esc(r.trx || '—')}</b></div>
      <div class="kv"><span>Receiver</span><b>${esc(r.receiver || '—')}</b></div>
      <div class="kv"><span>Date shown</span><b>${esc(r.paidText || '—')}</b></div></div>`;
  } else {
    h += `<div class="note">${esc(r.message || '')}</div>`;
  }
  if (r.dup) h += `<div class="warn">⚠ This TrxID is already used: ${esc(r.dup)}</div>`;
  if (mismatch && pending) h += `<div class="warn">Amount does not match the due. Reject and ask the member to upload again.</div>`;
  if (r.hasShot) h += `<div class="actions"><button data-act="viewShot" data-id="${r.id}">View screenshot</button></div>`;
  if (pending) {
    h += `<form data-form="confirm" data-id="${r.id}" data-kind="${r.kind}" class="stack" style="margin-top:10px">
      ${isShot ? '' : `<div class="grid2"><label>Method<select name="method"><option>Cash</option><option>bKash</option></select></label>
        <label>bKash TrxID (if bKash)<input name="trx" autocapitalize="characters" placeholder="e.g. 8N7A2K9X1B"></label></div>`}
      <label class="inline"><input type="checkbox" name="vok" required> I checked this payment in my bKash/cash record</label>
      <div class="actions"><button class="primary" type="submit" ${mismatch ? 'disabled' : ''}>${isShot ? 'Confirm payment' : 'Record payment'}</button></div>
    </form>
    <form data-form="reject" data-id="${r.id}" class="stack" style="margin-top:6px">
      <div class="grid2"><label>Reject reason<select name="reason">${REJECTS.map(x => `<option>${esc(x)}</option>`).join('')}</select></label>
      <label>Other (optional)<input name="other" placeholder="Short note"></label></div>
      <div class="actions"><button class="danger" type="submit">Reject request</button></div>
    </form>`;
  } else if (r.reason) {
    h += `<div class="small" style="margin-top:6px">${esc(r.reason)}${r.reviewedBy ? ' · by ' + esc(r.reviewedBy) : ''}</div>`;
  }
  return h + '</div>';
}
function vRequests() {
  const b = S.boot;
  if (!isStaff()) {
    const mine = b.requests.filter(r => r.userId === meId());
    return `<div class="sec-title">My requests</div>${mine.length ? `<div class="card list">${mine.map(reqRowMember).join('')}</div>` : '<div class="card empty">No requests yet. Pay via bKash from your Home tab.</div>'}`;
  }
  const pend = b.requests.filter(r => r.status === 'pending');
  const done = b.requests.filter(r => r.status !== 'pending').slice(0, 25);
  let h = `<div class="sec-title">To verify (${pend.length})</div>`;
  h += pend.length ? pend.map(reqCard).join('') : '<div class="card empty">Nothing to verify. Good job.</div>';
  h += `<div class="sec-title">Recent decisions</div>`;
  h += done.length ? `<div class="card list">${done.map(r => `<div class="item"><div class="grow"><b>${esc(r.userName)}</b> <span class="small muted">· ${pl(r.period)} · ${r.kind === 'screenshot' ? money(r.amount) : 'update'}</span>
    <div class="small muted">${esc(r.reason || (r.status === 'confirmed' ? 'Confirmed by ' + (r.reviewedBy || '') : ''))}</div></div><span class="chip ${r.status}">${esc(r.status)}</span></div>`).join('')}</div>` : '<div class="card empty">None yet</div>';
  return h;
}

function vBoard() {
  const b = S.boot, periods = b.periods, me = b.me;
  const rows = b.members.filter(m => m.pays);
  const cur = curPeriod();
  const legend = `<div class="legend"><span class="chip paid">Paid</span><span class="chip due">Due</span><span class="chip note">Won't pay</span><span class="chip review">Review</span></div>`;
  let h = `<div class="sec-title">Club board</div><div class="card">
    <div class="small muted">Everyone's status for ${pl(cur)}. Tap a month cell for details. Your own payment details are visible to you; others show status and amount only.</div>${legend}
    <div class="tablewrap"><table class="board"><thead><tr><th class="name">Member</th><th>Owed</th>${periods.map(p => `<th>${MON[+p.slice(5) - 1]}</th>`).join('')}</tr></thead><tbody>`;
  for (const m of rows) {
    const od = outstanding(m.id);
    h += `<tr><td class="name"><b>${esc(m.name.split(' ')[0])}</b>${m.id === me.id ? ' <span class="pill">you</span>' : ''}</td>
      <td class="${od.n ? 'bad' : ''}"><b>${od.n ? money(od.total) : '✓'}</b></td>
      ${periods.map(p => { const c = cell(m.id, p) || { s: 'na' }; const clickable = c.s !== 'na' && c.s !== 'future';
        return `<td><button class="cell ${c.s}" ${clickable ? `data-act="cell" data-uid="${m.id}" data-p="${p}"` : 'disabled'} aria-label="${esc(m.name)} ${pl(p)} ${LBL[c.s] || ''}">${c.s === 'paid' ? '✓' : c.s === 'due' ? '✕' : c.s === 'note' ? '…' : c.s === 'review' ? '⏳' : '·'}</button></td>`; }).join('')}</tr>`;
  }
  h += `</tbody></table></div></div>`;
  h += `<div class="sec-title">Totals</div><div class="card">${(() => {
    let paid = 0, owed = 0;
    rows.forEach(m => { const o = outstanding(m.id); owed += o.total; });
    const paidCount = rows.filter(m => cell(m.id, cur) && cell(m.id, cur).s === 'paid').length;
    return `<div class="kv"><span>Paid this month</span><b>${paidCount} of ${rows.length}</b></div><div class="kv"><span>Total outstanding (all members)</span><b class="bad">${money(owed)}</b></div>`;
  })()}</div>`;
  if (!isStaff()) h += `<div class="sec-title">My history</div>${statusCard(me.id, cur, { title: 'This month' })}<div class="card list">${historyRows(me.id)}</div>`;
  return h;
}

function vMembers() {
  const b = S.boot, me = b.me;
  const collectors = b.members.filter(m => m.role === 'collector');
  let list = b.members.filter(m => isAdmin() || (m.collectorId === me.id && m.role === 'member') || m.id === me.id);
  list = list.slice().sort((a, c) => (a.role === c.role ? a.name.localeCompare(c.name) : (a.role === 'admin' ? -1 : c.role === 'admin' ? 1 : a.role === 'collector' ? -1 : 1)));
  let h = `<div class="sec-title">Add member</div><div class="card"><form data-form="addMember" class="stack">
    <div class="grid2"><label>Name<input name="name" required maxlength="60"></label>
    <label>Mobile<input name="phone" type="tel" inputmode="tel" placeholder="01XXXXXXXXX" required></label></div>
    <label>Starting password (8 or more characters)<input name="password" type="text" minlength="8" maxlength="128" autocomplete="off" required></label>
    <div class="grid2">${isAdmin() ? `<label>Role<select name="role"><option value="member">Member</option><option value="collector">Collector</option></select></label>` : '<div></div>'}
    ${isAdmin() ? `<label>Collector (for members)<select name="collectorId">${collectors.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>` : '<div></div>'}</div>
    <div class="actions"><button class="primary" type="submit">Add</button></div>
    <p class="hint">New members sign in with this number and password. Give them the password and ask them to change it in Settings. They start paying from the current month.</p></form></div>`;
  h += `<div class="sec-title">${isAdmin() ? 'All members' : 'My group'} (${list.length})</div><div class="card list">`;
  for (const m of list) {
    const coll = b.members.find(x => x.id === m.collectorId);
    const isSelf = m.id === me.id;
    h += `<div class="item"><div class="grow"><b>${esc(m.name)}</b> ${isSelf ? '<span class="pill">you</span>' : ''}
      <div class="small muted">${esc(m.role)} · ${esc(m.phone || '')}${m.role === 'member' ? ' · ' + esc(coll ? coll.name : 'no collector') : ''}</div>
      ${isAdmin() && m.role === 'member' ? `<div class="actions"><select data-change="setCollector" data-id="${m.id}" aria-label="Collector for ${esc(m.name)}" style="width:auto;min-height:36px">${collectors.map(c => `<option value="${c.id}" ${c.id === m.collectorId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>` : ''}
      <div class="actions"><button data-act="editMember" data-id="${m.id}">Edit</button>
      ${!isSelf && m.role !== 'admin' ? `<button class="danger" data-act="removeMember" data-id="${m.id}">Remove</button>` : ''}</div></div></div>`;
  }
  h += '</div>';
  if (!isAdmin()) h += `<p class="hint">You can add, edit and remove members in your group. Removing deactivates them and keeps their payment history.</p>`;
  return h;
}

function vSetup() {
  return vSetupMain() + (isAdmin() ? backupHtml() : '');
}
function backupHtml() {
  return `<div class="sec-title">Backup on this phone</div>
  <div class="card stack">
    <p class="hint">The club data is kept on this phone only. Save a backup file to keep it safe, or to move the club to another phone.</p>
    <div class="actions"><button class="primary" data-act="exportBackup">Save backup file</button></div>
    <label>Restore from a backup file<input type="file" accept="application/json,.json" data-change="restoreBackup"></label>
    <p class="hint">Restoring replaces all data on this phone.</p>
    <div class="actions"><button class="danger" data-act="eraseDevice">Erase all data on this phone</button></div>
  </div>`;
}
function vSetupMain() {
  const b = S.boot, me = b.me, cur = curPeriod();
  const collectors = b.members.filter(m => m.role === 'collector');
  let h = '';
  if (isAdmin()) {
    h += `<div class="sec-title">Club settings</div>
    <div class="card"><form data-form="share" class="stack"><div class="grid2">
      <label>Monthly share (৳)<input name="defaultShare" type="number" min="1" value="${b.settings.defaultShare}" required></label>
      <label>Due day of month<input name="dueDay" type="number" min="1" max="28" value="${b.settings.dueDay}" required></label></div>
      <div class="actions"><button class="primary" type="submit">Save</button></div></form></div>
    <div class="card"><form data-form="clubBkash" class="stack"><div class="grid2">
      <label>Admin bKash name<input name="name" value="${esc(b.settings.clubBkash.name || '')}" required></label>
      <label>Admin bKash number<input name="no" type="tel" inputmode="tel" value="${esc(b.settings.clubBkash.no || '')}" required></label></div>
      <p class="hint">Collectors pay their rent to this account.</p>
      <div class="actions"><button class="primary" type="submit">Save</button></div></form></div>
    <div class="sec-title">Collection task</div>
    <div class="card"><form data-form="task" class="stack"><div class="grid2">
      <label>Collector<select name="collectorId">${collectors.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
      <label>Month<select name="period">${b.periods.slice().reverse().map(p => `<option value="${p}" ${p === cur ? 'selected' : ''}>${pl(p)}</option>`).join('')}</select></label></div>
      <label>Title<input name="title" value="Collect rent" required maxlength="100"></label>
      <label>Due text<input name="dueText" placeholder="e.g. 20 Oct"></label>
      <div class="actions"><button class="primary" type="submit">Create task</button></div>
      <p class="hint">Creates a task for the collector listing the unpaid members in their group.</p></form></div>
    <div class="sec-title">Tasks</div>${taskList()}`;
  }
  if (me.role === 'collector') {
    h += `<div class="sec-title">My bKash number</div><div class="card"><form data-form="myBkash" class="stack">
      <label>bKash number (shown to your members)<input name="bkash" type="tel" inputmode="tel" value="${esc(me.bkash || '')}" required></label>
      <div class="actions"><button class="primary" type="submit">Save</button></div></form></div>`;
  }
  h += `<div class="sec-title">Monthly amount</div><div class="card"><form data-form="amount" class="stack"><div class="grid2">
    <label>Month<select name="period">${b.periods.slice().reverse().map(p => `<option value="${p}" ${p === cur ? 'selected' : ''}>${pl(p)}</option>`).join('')}</select></label>
    <label>Amount (৳)<input name="amount" type="number" min="1" value="${b.settings.defaultShare}" required></label></div>
    <div class="actions"><button class="primary" type="submit">Set amount</button></div></form>
    <p class="hint">Default share is ৳${b.settings.defaultShare} per member. Change only for a specific month.</p></div>
    <div class="card list">${b.periods.slice().reverse().slice(0, 12).map(p => `<div class="item"><div class="grow">${pl(p)}</div><b>${money(b.amounts[p] ?? b.settings.defaultShare)}</b></div>`).join('')}</div>`;
  return h;
}

function vAlerts() {
  const n = S.boot.notifications;
  let h = `<div class="sec-title">Alerts</div><div class="actions" style="margin:0 0 10px">${S.boot.unread ? `<button class="primary" data-act="markRead">Mark all read</button>` : '<span class="muted small">All caught up</span>'}</div>`;
  if (!n.length) return h + '<div class="card empty">No alerts</div>';
  h += `<div class="card list">${n.map(x => {
    const isMember = !isStaff();
    let extra = '';
    if (x.kind === 'pay' && isMember) extra = `<div class="actions"><button class="primary" data-act="openBkash">Open bKash app</button><button data-act="paySheet" data-p="${x.period || S.boot.today}">Pay with screenshot</button></div>`;
    if (x.kind === 'review' && isStaff()) extra = `<div class="actions"><button data-act="tab" data-tab="requests">Open request</button></div>`;
    return `<div class="item" style="align-items:flex-start"><div class="grow">
      <div class="row between"><b>${esc(x.title)}</b><span class="small muted">${when(x.at)}</span></div>
      <div class="small">${esc(x.body)}</div>${extra}</div>
      ${x.read ? '' : '<span class="chip info">new</span>'}</div>`;
  }).join('')}</div>`;
  return h;
}

/* ---------- modal ---------- */
function openModal(title, body) {
  modalRoot.innerHTML = `<div class="sheet-bg" data-act="bgClose"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <header><h3>${esc(title)}</h3><button class="x" data-act="close" aria-label="Close">×</button></header>${body}</div></div>`;
}
function closeModal() { modalRoot.innerHTML = ''; S.pendingShot = null; }

/* ---------- actions (buttons) ---------- */
const ACTS = {
  tab: d => { S.tab = d.tab; render(); window.scrollTo(0, 0); },
  logout: async () => {
    try { await api('POST', '/api/auth/logout', {}); } catch (e) { /* ignore */ }
    signOutLocal(); toast('Signed out');
  },
  month: d => { S.month = d.p; render(); },
  demo: async d => { await signIn(d.phone, S.demoPassword); },
  startDemo: async () => { await window.clubStartDemo(); },
  exportBackup: async () => {
    const obj = await window.clubExport();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type: 'application/json' }));
    a.download = 'club-rent-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    toast('Backup saved', 'ok');
  },
  eraseDevice: async () => {
    if (!confirm('Erase all club data on this phone? This cannot be undone unless you have a backup file.')) return;
    S.token = null; localStorage.removeItem('crt_token'); // signed out as well
    await window.clubErase();
  },
  changePassword: () => openModal('Change password', `<form data-form="changePassword" class="stack">
      <label>Current password<input name="current" type="password" autocomplete="current-password" required></label>
      <label>New password (8 or more characters)<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>
      <div class="actions"><button class="primary" type="submit">Change password</button></div>
      <p class="hint">Your other devices will be signed out.</p></form>`),
  close: () => closeModal(),
  bgClose: (d, el, e) => { if (e.target === el) closeModal(); },
  markRead: async () => { await api('POST', '/api/notifications/read', {}); await refresh(); },
  cell: d => {
    const c = cell(d.uid, d.p); if (!c) return;
    const m = S.boot.members.find(x => x.id === d.uid);
    const staffOK = isStaff() && (isAdmin() || m.collectorId === meId());
    let body = `<div class="row between"><div><div class="muted small">${plLong(d.p)}</div><div class="big">${money(amountOf(c, d.p))}</div></div>${statusChip(c.s)}</div>`;
    if (c.s === 'paid') body += `<div style="margin-top:8px">${detailLines(c)}</div>`;
    if (c.s === 'note') body += `<div class="note">${esc(c.reason || '')}${c.text ? ' — ' + esc(c.text) : ''}</div>`;
    if (c.s === 'review') body += `<div class="hint">Screenshot waiting for verification.</div>`;
    if ((c.s === 'due' || c.s === 'note') && staffOK) body += `<div class="actions"><button data-act="recordCash" data-uid="${d.uid}" data-p="${d.p}">Cash received</button><button data-act="recordBkash" data-uid="${d.uid}" data-p="${d.p}">bKash (TrxID)</button></div>`;
    if (c.s === 'note' || c.s === 'due' || c.s === 'review') body += `<p class="hint">${esc(m.name)} · ${UNPAID.includes(c.s) ? 'unpaid' : ''}</p>`;
    openModal(`${m.name} · ${pl(d.p)}`, body);
  },
  paySheet: d => {
    const p = d.p || S.boot.today, payee = S.boot.me.payee;
    const amt = amountOf(cell(meId(), p) || {}, p);
    const payeeLine = payee ? `<div class="kv"><span>Pay to</span><b>${esc(payee.name)}</b></div><div class="kv"><span>bKash number</span><b>${esc(payee.no)}</b></div>` : '';
    openModal(`Pay ${money(amt)} for ${plLong(p)}`, `
      ${payeeLine}
      <div class="actions"><button data-act="copy" data-text="${esc(payee ? payee.no : '')}">Copy number</button>
      <button class="primary" data-act="openBkash">Open bKash app</button></div>
      <p class="hint">Opens the bKash app on Android. Send exactly ${money(amt)}, then upload the payment screenshot below. If the app does not open, open bKash yourself and send to the number above.</p>
      <hr style="border:0;border-top:1px solid var(--line);margin:12px 0">
      <form data-form="shot" class="stack">
        <input type="hidden" name="period" value="${p}">
        <label>Payment screenshot<input type="file" accept="image/png,image/jpeg,image/webp" name="file" data-change="pickShot"></label>
        <div id="ocrState" class="hint">Choose a screenshot. The app reads the amount and TrxID for you.</div>
        <img id="shotPreview" class="shot" alt="Screenshot preview" hidden>
        <div class="grid2"><label>Amount (৳)<input name="amount" type="number" inputmode="numeric" min="1" value="${amt}" required></label>
        <label>bKash TrxID<input name="trx" autocapitalize="characters" required placeholder="e.g. 8N7A2K9X1B"></label></div>
        <div class="grid2"><label>Receiver number<input name="receiver" inputmode="tel"></label>
        <label>Date shown<input name="paidText"></label></div>
        <div class="actions"><button class="primary" type="submit">Send to collector</button></div>
      </form>`);
  },
  openBkash: () => {
    if (window.CRTNative && window.CRTNative.openBkash) { window.CRTNative.openBkash(); return; }
    window.location.href = BKASH_INTENT;
  },
  copy: async (d) => {
    try { await navigator.clipboard.writeText(d.text); toast('Number copied', 'ok'); }
    catch (e) { toast('Copy not available. Number: ' + d.text); }
  },
  noteSheet: d => {
    openModal(`Won't pay in ${plLong(d.p)}?`, `
      <p class="hint">Your collector and the club board will see that you won't pay this month. It still counts as due until paid.</p>
      <form data-form="note" class="stack"><input type="hidden" name="period" value="${d.p}">
      <label>Reason<select name="reason">${REASONS.map(x => `<option>${esc(x)}</option>`).join('')}</select></label>
      <label>Note (optional)<textarea name="text" maxlength="300" placeholder="Short message for your collector"></textarea></label>
      <label>Promise to pay by (optional)<input name="promise" placeholder="e.g. 5 Nov"></label>
      <div class="actions"><button class="primary" type="submit">Post note</button></div></form>`);
  },
  cashReq: async d => {
    await api('POST', '/api/requests', { kind: 'update', period: d.p, method: 'Cash', message: 'I will pay cash to my collector' });
    toast('Collector notified', 'ok'); await refresh();
  },
  updateSheet: d => {
    openModal('Ask for a status update', `<form data-form="update" class="stack"><input type="hidden" name="period" value="${d.p}">
      <label>Method<select name="method"><option>bKash</option><option>Cash</option></select></label>
      <label>Message<textarea name="message" maxlength="300" required placeholder="e.g. I paid on bKash, please check"></textarea></label>
      <div class="actions"><button class="primary" type="submit">Send to collector</button></div></form>`);
  },
  viewShot: async d => {
    try {
      const url = await shotUrl(d.id);
      openModal('Payment screenshot', `<img class="shot" src="${url}" alt="Payment screenshot">`);
    } catch (e) { toast(e.message, 'bad'); }
  },
  recordCash: async d => {
    const m = S.boot.members.find(x => x.id === d.uid);
    if (!confirm(`Record ${money(amountOf(cell(d.uid, d.p), d.p))} cash from ${m.name} for ${pl(d.p)}?`)) return;
    await api('POST', '/api/payments', { userId: d.uid, period: d.p, method: 'Cash' });
    closeModal(); toast('Cash payment recorded', 'ok'); await refresh();
  },
  recordBkash: d => {
    const m = S.boot.members.find(x => x.id === d.uid);
    openModal(`bKash payment · ${m.name}`, `<form data-form="bkashPay" class="stack"><input type="hidden" name="userId" value="${d.uid}"><input type="hidden" name="period" value="${d.p}">
      <p class="hint">Enter the TrxID from the member's bKash record. Duplicate TrxIDs are blocked.</p>
      <label>bKash TrxID<input name="trx" autocapitalize="characters" required></label>
      <div class="actions"><button class="primary" type="submit">Record payment</button></div></form>`);
  },
  remind: d => { openNotify([d.uid], d.p); },
  notifyUnpaid: d => { openNotify(null, d.p); },
  notifySelected: d => {
    const ids = [...document.querySelectorAll('[data-sel]:checked')].map(x => x.value);
    if (!ids.length) return toast('Tick the members you want to notify', 'bad');
    openNotify(ids, d.p);
  },
  editMember: d => {
    const m = S.boot.members.find(x => x.id === d.id);
    openModal(`Edit ${m.name}`, `<form data-form="editMember" class="stack"><input type="hidden" name="id" value="${m.id}">
      <label>Name<input name="name" value="${esc(m.name)}" required maxlength="60"></label>
      ${m.phone !== undefined ? `<label>Mobile<input name="phone" type="tel" value="${esc(m.phone)}" required></label>` : ''}
      <label>New password (leave blank to keep the current one)<input name="password" type="text" minlength="8" maxlength="128" autocomplete="off"></label>
      ${isAdmin() ? `<label>Role<select name="role">${['member', 'collector', 'admin'].map(r => `<option ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}</select></label>` : ''}
      <div class="actions"><button class="primary" type="submit">Save changes</button></div></form>`);
  },
  removeMember: async d => {
    const m = S.boot.members.find(x => x.id === d.id);
    if (!confirm(`Remove ${m.name}? Their payment history is kept.`)) return;
    await api('PATCH', '/api/members/' + d.id, { active: false });
    toast('Member removed', 'ok'); await refresh();
  },
  requestAction: () => {}
};

function openNotify(ids, p) {
  const who = ids ? `${ids.length} selected member(s)` : 'all unpaid members in your group';
  openModal(`Notify · ${plLong(p)}`, `<form data-form="notify" class="stack">
    <input type="hidden" name="period" value="${p}">
    <input type="hidden" name="ids" value="${ids ? ids.join(',') : ''}">
    <input type="hidden" name="mode" value="${ids ? 'selected' : 'unpaid'}">
    <p class="hint">Sends to ${who}. Members see it in Alerts and can open bKash from there.</p>
    <label>Message<textarea name="message" required maxlength="500">Hi {name}, please pay your {month} rent of ৳200 via bKash or cash. Thank you.</textarea></label>
    <div class="actions"><button class="primary" type="submit">Send notification</button></div></form>`);
}

async function shotUrl(id) {
  if (S.shots[id]) return S.shots[id];
  const r = await window.clubApi('GET', `/api/requests/${id}/shot`, undefined, S.token);
  if (r.status !== 200) throw new Error('Cannot load this screenshot');
  const url = URL.createObjectURL(new Blob([r.data], { type: r.contentType || 'image/png' }));
  S.shots[id] = url; return url;
}

// First-time setup on this phone, and sample data for trying the app.
function setupHtml() {
  return `<div class="login">
    <div class="brand">💸 Club Rent Tracker</div>
    <p class="muted">Monthly share <b>৳200</b> · pay by cash or bKash · see who has paid.</p>
    <div class="card">
      <h3>Set up your club on this phone</h3>
      <form data-form="setup" class="stack">
        <label>Your name<input name="name" required maxlength="60" autocomplete="name"></label>
        <label>Mobile number<input name="phone" type="tel" inputmode="tel" autocomplete="username" placeholder="01XXXXXXXXX" required></label>
        <label>Password (8 or more characters)<input name="password" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>
        <label>Repeat password<input name="password2" type="password" autocomplete="new-password" minlength="8" maxlength="128" required></label>
        <div class="actions"><button class="primary" type="submit">Create club</button></div>
      </form>
      <p class="hint">You become the admin. Add members and collectors after you sign in.</p>
    </div>
    <div class="card">
      <h3>Moving from another phone?</h3>
      <p class="hint">Restore the backup file you saved on the old phone (Setup → Save backup file).</p>
      <label>Backup file<input type="file" accept="application/json,.json" data-change="restoreBackup"></label>
    </div>
    <div class="card">
      <h3>Just trying it out?</h3>
      <p class="hint">Load sample members and payments. You can erase them later in Setup.</p>
      <div class="actions"><button data-act="startDemo">Load sample data</button></div>
    </div>
    <p class="hint">Everything is stored on this phone. Nothing is sent to a server.</p>
  </div>`;
}

/* ---------- forms ---------- */
async function signIn(phone, password) {
  const r = await api('POST', '/api/auth/login', { phone, password });
  S.token = r.token; localStorage.setItem('crt_token', r.token);
  S.login = { phone: '' };
  await loadBoot(); toast('Signed in', 'ok');
}
const FORMS = {
  setup: async f => {
    const phone = f.elements.phone.value.trim(), password = f.elements.password.value;
    if (password !== f.elements.password2.value) throw new Error('The two passwords do not match');
    await window.clubSetup({ name: f.elements.name.value, phone, password });
    S.mode = 'club';
    await signIn(phone, password);
  },
  login: async f => {
    const phone = f.elements.phone.value.trim(), password = f.elements.password.value;
    S.login.phone = phone;
    await signIn(phone, password);
  },
  changePassword: async f => {
    await api('POST', '/api/auth/password', { current: f.elements.current.value, password: f.elements.password.value });
    closeModal(); toast('Password changed. Other devices were signed out.', 'ok');
  },
  shot: async f => {
    if (!S.pendingShot) throw new Error('Upload the screenshot first');
    const body = { kind: 'screenshot', period: f.elements.period.value, amount: +f.elements.amount.value, trx: f.elements.trx.value.trim(), receiver: f.elements.receiver.value, paidText: f.elements.paidText.value, ocr: !!S.pendingShot.ocr, imageDataUrl: S.pendingShot.dataUrl };
    if (!(body.amount > 0)) throw new Error('Enter the amount');
    if (!body.trx) throw new Error('Enter the TrxID');
    await api('POST', '/api/requests', body);
    closeModal(); toast('Screenshot sent. Your collector will verify it.', 'ok'); await refresh();
  },
  note: async f => {
    await api('POST', '/api/remarks', { period: f.elements.period.value, reason: f.elements.reason.value, text: f.elements.text.value, promise: f.elements.promise.value });
    closeModal(); toast('Note posted', 'ok'); await refresh();
  },
  update: async f => {
    await api('POST', '/api/requests', { kind: 'update', period: f.elements.period.value, method: f.elements.method.value, message: f.elements.message.value });
    closeModal(); toast('Collector notified', 'ok'); await refresh();
  },
  notify: async f => {
    const ids = f.elements.ids.value ? f.elements.ids.value.split(',') : undefined;
    const r = await api('POST', '/api/notify', { period: f.elements.period.value, mode: f.elements.mode.value, userIds: ids, message: f.elements.message.value });
    closeModal(); toast(`Sent to ${r.sent} member(s)`, 'ok'); await refresh();
  },
  bkashPay: async f => {
    await api('POST', '/api/payments', { userId: f.elements.userId.value, period: f.elements.period.value, method: 'bKash', trx: f.elements.trx.value.trim() });
    closeModal(); toast('bKash payment recorded', 'ok'); await refresh();
  },
  confirm: async f => {
    const kind = f.dataset.kind;
    const body = { vok: f.elements.vok.checked };
    if (kind !== 'screenshot') { body.method = f.elements.method.value; body.trx = f.elements.trx.value.trim(); }
    await api('POST', `/api/requests/${f.dataset.id}/confirm`, body);
    toast('Payment confirmed. Status updated.', 'ok'); await refresh();
  },
  reject: async f => {
    const other = f.elements.other.value.trim();
    const reason = f.elements.reason.value === 'Other' ? (other || 'Other') : (other ? f.elements.reason.value + ': ' + other : f.elements.reason.value);
    await api('POST', `/api/requests/${f.dataset.id}/reject`, { reason });
    toast('Request rejected', 'ok'); await refresh();
  },
  addMember: async f => {
    const body = { name: f.elements.name.value.trim(), phone: f.elements.phone.value.trim(), password: f.elements.password.value };
    if (isAdmin()) { body.role = f.elements.role.value; body.collectorId = f.elements.collectorId.value; }
    await api('POST', '/api/members', body);
    toast('Member added', 'ok'); await refresh();
  },
  editMember: async f => {
    const body = { name: f.elements.name.value.trim() };
    if (f.elements.phone) body.phone = f.elements.phone.value.trim();
    if (f.elements.role) body.role = f.elements.role.value;
    if (f.elements.password.value) body.password = f.elements.password.value;
    await api('PATCH', '/api/members/' + f.elements.id.value, body);
    closeModal(); toast('Saved', 'ok'); await refresh();
  },
  share: async f => {
    await api('PUT', '/api/settings', { defaultShare: +f.elements.defaultShare.value, dueDay: +f.elements.dueDay.value });
    toast('Saved', 'ok'); await refresh();
  },
  clubBkash: async f => {
    await api('PUT', '/api/settings/club-bkash', { name: f.elements.name.value.trim(), no: f.elements.no.value.trim() });
    toast('Saved', 'ok'); await refresh();
  },
  myBkash: async f => {
    await api('PUT', '/api/me/bkash', { bkash: f.elements.bkash.value.trim() });
    toast('bKash number saved', 'ok'); await refresh();
  },
  amount: async f => {
    await api('PUT', '/api/amounts/' + f.elements.period.value, { amount: +f.elements.amount.value });
    toast('Amount saved', 'ok'); await refresh();
  },
  task: async f => {
    await api('POST', '/api/tasks', { collectorId: f.elements.collectorId.value, period: f.elements.period.value, title: f.elements.title.value.trim(), dueText: f.elements.dueText.value.trim() });
    toast('Task created', 'ok'); await refresh();
  }
};

/* ---------- screenshot reading ---------- */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const max = 1600, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.88));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not open this image. Try a PNG or JPG.')); };
    img.src = url;
  });
}
async function pickShot(input) {
  const form = input.form;
  const file = input.files && input.files[0];
  if (!file) return;
  const state = $('#ocrState'), prev = $('#shotPreview');
  S.pendingShot = null;
  try {
    if (!/^image\//.test(file.type)) throw new Error('Choose an image file');
    state.textContent = 'Reading screenshot…';
    const dataUrl = await compressImage(file);
    prev.src = dataUrl; prev.hidden = false;
    S.pendingShot = { dataUrl, ocr: false };
    const r = await api('POST', '/api/ocr', { imageDataUrl: dataUrl });
    if (r.ok) {
      S.pendingShot.ocr = true;
      if (r.amount) form.elements.amount.value = r.amount;
      if (r.trx) form.elements.trx.value = r.trx;
      if (r.receiver) form.elements.receiver.value = r.receiver;
      if (r.paidText) form.elements.paidText.value = r.paidText;
      const missing = [!r.amount && 'amount', !r.trx && 'TrxID'].filter(Boolean);
      state.textContent = missing.length
        ? `Read the screenshot, but could not find ${missing.join(' and ')}. Please type it in.`
        : 'Read from the screenshot. Check the amount and TrxID, then send.';
    } else {
      state.textContent = r.error || 'Could not read this screenshot. Please type the details.';
    }
  } catch (e) {
    if (e instanceof AuthError) return;
    state.textContent = e.message + ' You can still type the details.';
    if (!S.pendingShot) S.pendingShot = null;
  }
}

async function restoreBackup(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  if (!confirm('Restore this backup? All data on this phone will be replaced.')) { input.value = ''; return; }
  try { await window.clubImport(JSON.parse(await file.text())); }
  catch (e) { toast(e instanceof SyntaxError ? 'That file is not a club backup' : e.message, 'bad'); input.value = ''; }
}

/* ---------- global event wiring ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.tagName === 'A') return;
  const fn = ACTS[el.dataset.act];
  if (!fn) return;
  if (el.dataset.act === 'bgClose') return fn(el.dataset, el, e);
  e.preventDefault();
  if (el.disabled) return;
  try { await fn(el.dataset, el, e); }
  catch (err) { if (!(err instanceof AuthError)) toast(err.message, 'bad'); }
});
document.addEventListener('submit', async e => {
  const f = e.target;
  const name = f.dataset.form;
  if (!name || !FORMS[name]) return;
  e.preventDefault();
  const btn = f.querySelector('[type=submit]');
  if (btn) btn.disabled = true;
  try { await FORMS[name](f); }
  catch (err) { if (!(err instanceof AuthError)) toast(err.message, 'bad'); }
  finally { if (btn) btn.disabled = false; }
});
document.addEventListener('change', async e => {
  const t = e.target;
  if (t.dataset && t.dataset.change === 'pickShot') return pickShot(t);
  if (t.dataset && t.dataset.change === 'restoreBackup') return restoreBackup(t);
  if (t.dataset && t.dataset.change === 'setCollector') {
    try {
      await api('PATCH', '/api/members/' + t.dataset.id, { collectorId: t.value });
      toast('Collector updated', 'ok'); await refresh();
    } catch (err) { if (!(err instanceof AuthError)) toast(err.message, 'bad'); }
  }
});

/* ---------- boot ---------- */
(async function init() {
  try {
    await window.clubBoot;                // device storage and the club database are ready
    S.mode = window.clubStatus().mode;   // null: first time on this phone
    if (S.mode === 'demo') {
      try { const d = await api('GET', '/api/demo-accounts'); S.demo = d.accounts || []; S.demoPassword = d.password || ''; } catch (e) { S.demo = []; }
    }
  } catch (e) {
    app.innerHTML = `<div class="login"><div class="card"><h3>Could not start on this phone</h3><p class="hint">${esc(e.message)}</p></div></div>`;
    return;
  }
  if (S.token && S.mode) {
    try { await loadBoot(); return; }
    catch (e) { S.token = null; localStorage.removeItem('crt_token'); }
  }
  render();
})();

// Expose for debugging in the console only
window.__crt = { S, ACTS, FORMS };
})();
