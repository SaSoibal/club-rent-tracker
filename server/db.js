'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','collector','member')),
  pays INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  collector_id TEXT,
  bkash TEXT,
  join_period TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS otps (
  phone TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS period_amounts (period TEXT PRIMARY KEY, amount INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  period TEXT NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  trx TEXT,
  receiver TEXT,
  paid_text TEXT,
  shot_path TEXT,
  source TEXT NOT NULL,
  recorded_by TEXT,
  verified_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, period)
);
CREATE TABLE IF NOT EXISTS remarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  period TEXT NOT NULL,
  reason TEXT,
  text TEXT,
  promise TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, period)
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  period TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('screenshot','update')),
  amount INTEGER NOT NULL,
  expected INTEGER NOT NULL,
  trx TEXT,
  receiver TEXT,
  paid_text TEXT,
  shot_path TEXT,
  message TEXT,
  method TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  ocr INTEGER NOT NULL DEFAULT 0,
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  period TEXT,
  request_id INTEGER,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  collector_id TEXT NOT NULL REFERENCES users(id),
  period TEXT NOT NULL,
  due_text TEXT,
  targets TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Demo data matching the design discussion (10 payers + admin).
function seed(db, uploadsDir) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO users (id,name,phone,role,pays,active,collector_id,bkash,join_period,created_at)
                          VALUES (?,?,?,?,?,1,?,?,?,?)`);
  const people = [
    ['u1','Mahbub Alam','01711000001','admin',0,null,null],
    ['u2','Tanvir Hasan','01711000002','collector',1,null,'01711000002'],
    ['u3','Shakil Mia','01711000003','collector',1,null,'01711000003'],
    ['u4','Rahim Uddin','01711000004','member',1,'u2',null],
    ['u5','Karim Hossain','01711000005','member',1,'u2',null],
    ['u6','Sabbir Ahmed','01711000006','member',1,'u2',null],
    ['u7','Imran Khan','01711000007','member',1,'u2',null],
    ['u8','Fahim Chowdhury','01711000008','member',1,'u2',null],
    ['u9','Nabil Sarker','01711000009','member',1,'u3',null],
    ['u10','Rafi Islam','01711000010','member',1,'u3',null],
    ['u11','Arif Rahman','01711000011','member',1,'u3',null],
  ];
  people.forEach(p => ins.run(p[0], p[1], p[2], p[3], p[4], p[5], p[6], '2026-01', now));

  const setS = db.prepare('INSERT INTO settings (key,value) VALUES (?,?)');
  setS.run('default_share', '200');
  setS.run('due_day', '10');
  setS.run('club_bkash_name', 'Mahbub Alam');
  setS.run('club_bkash_no', '01711000001');

  // Payment history strings: index 0 = Jan 2026 ... 9 = Oct 2026. P = paid, D = not paid.
  const H = {
    u2:'PPPPPPPPPP', u3:'PPPPPPPPPP', u4:'PPPPPPPPPP', u5:'PPPPDPPPPP', u6:'PPPPPPPPPD',
    u7:'PPPPPPPPPD', u8:'PDPDPPDDDD', u9:'PPPPPPPPPP', u10:'PPPPPPPPPP', u11:'PPPPPPPPPP'
  };
  const phoneOf = Object.fromEntries(people.map(p => [p[0], p]));
  const collectorOf = id => (phoneOf[id] && phoneOf[id][5]) || 'u1';
  const insPay = db.prepare(`INSERT INTO payments (user_id,period,amount,method,trx,receiver,paid_text,shot_path,source,recorded_by,verified_by,created_at)
                             VALUES (?,?,?,?,?,?,?,NULL,'collector',?,?,?)`);
  for (const [uid, h] of Object.entries(H)) {
    const coll = collectorOf(uid);
    const collName = coll === 'u1' ? 'Mahbub Alam' : phoneOf[coll][1];
    const recv = coll === 'u1' ? '01711000001' : phoneOf[coll][2];
    [...h].forEach((c, i) => {
      if (c !== 'P') return;
      const period = `2026-${String(i + 1).padStart(2, '0')}`;
      const method = i % 3 === 0 ? 'Cash' : 'bKash';
      const trx = method === 'bKash' ? 'BK' + ((parseInt(uid.slice(1)) * 104729 + i * 7919) * 2654435761 % 4294967296).toString(36).toUpperCase().padStart(8, '0').slice(0, 8) : '—';
      insPay.run(uid, period, 200, method, trx, method === 'bKash' ? recv : null,
        `${(i * 3) % 27 + 1} ${MON[i]} 2026`, coll, collName, `2026-${String(i + 1).padStart(2, '0')}-10T10:00:00.000Z`);
    });
  }
  // Tanvir and Shakil (collectors) pay the club account
  // (their own rows were inserted above with collector = admin)

  const insRem = db.prepare('INSERT INTO remarks (user_id,period,reason,text,promise,created_at) VALUES (?,?,?,?,?,?)');
  insRem.run('u7', '2026-10', 'Traveling', 'Going to Sylhet for family work. Will pay after 10 days.', '28 Oct', '2026-10-16T10:20:00.000Z');
  insRem.run('u8', '2026-02', 'Job issue', 'Salary delayed this month.', '', '2026-02-04T08:00:00.000Z');

  const shot = (name, svg) => { fs.writeFileSync(path.join(uploadsDir, name), svg); return name; };
  const r1 = shot('seed-r1.svg', receiptSvg(200, '01711000002', 'BK7Q2M9X1A', '18 Oct 2026, 9:01 PM'));
  const r3 = shot('seed-r3.svg', receiptSvg(150, '01711000002', 'BK9K4LP2TD', '18 Oct 2026, 7:40 PM'));
  const insReq = db.prepare(`INSERT INTO requests (user_id,period,kind,amount,expected,trx,receiver,paid_text,shot_path,message,method,status,ocr,created_at)
                             VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`);
  insReq.run('u6', '2026-10', 'screenshot', 200, 200, 'BK7Q2M9X1A', '01711000002', '18 Oct 2026, 9:01 PM', r1, null, 'bKash', 1, '2026-10-18T15:02:00.000Z');
  insReq.run('u5', '2026-05', 'update', 200, 200, null, null, null, null, '[Cash] I paid cash to Tanvir on 5 May. Please update my status.', 'Cash', 0, '2026-10-16T16:20:00.000Z');
  insReq.run('u8', '2026-10', 'screenshot', 150, 200, 'BK9K4LP2TD', '01711000002', '18 Oct 2026, 7:40 PM', r3, null, 'bKash', 1, '2026-10-18T13:41:00.000Z');

  const insN = db.prepare('INSERT INTO notifications (user_id,title,body,kind,period,request_id,read,created_at) VALUES (?,?,?,?,?,?,?,?)');
  insN.run('u6', 'Oct rent reminder', '৳200 is due for October. Pay via bKash and upload the screenshot.', 'pay', '2026-10', null, 0, '2026-10-18T14:00:00.000Z');
  insN.run('u2', 'New screenshot', 'Sabbir Ahmed uploaded a bKash screenshot. Amount ৳200, TrxID BK7Q2M9X1A.', 'review', '2026-10', 1, 0, '2026-10-18T15:02:00.000Z');
  insN.run('u2', 'Status update request', 'Karim Hossain says he paid cash for May.', 'review', '2026-05', 2, 0, '2026-10-16T16:20:00.000Z');
  insN.run('u2', 'New screenshot', 'Fahim Chowdhury uploaded a screenshot. Amount read as ৳150, due ৳200.', 'review', '2026-10', 3, 0, '2026-10-18T13:41:00.000Z');
  insN.run('u1', 'October summary', '7 of 10 paid · ৳1,400 of ৳2,000 collected.', 'info', '2026-10', null, 0, '2026-10-18T08:00:00.000Z');
  insN.run('u7', 'Your note was saved', "'Won't pay' noted for October. Your collector has been notified.", 'info', '2026-10', null, 1, '2026-10-16T10:20:00.000Z');

  db.prepare('INSERT INTO tasks (title,collector_id,period,due_text,targets,created_at) VALUES (?,?,?,?,?,?)')
    .run('Collect October rent – Group A', 'u2', '2026-10', '12 Oct', JSON.stringify(['u4','u5','u6','u7','u8']), now);
}

function receiptSvg(amt, to, trx, when) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="520"><rect width="300" height="520" fill="#e2136e"/><rect x="18" y="70" width="264" height="420" rx="18" fill="#fff"/><text x="150" y="112" text-anchor="middle" font-family="Arial" font-size="18" font-weight="bold" fill="#e2136e">bKash</text><circle cx="150" cy="165" r="28" fill="#dcfce7"/><text x="150" y="174" text-anchor="middle" font-size="28" fill="#16a34a">✓</text><text x="150" y="220" text-anchor="middle" font-family="Arial" font-size="16" fill="#111">Send Money Successful</text><text x="150" y="262" text-anchor="middle" font-family="Arial" font-size="30" font-weight="bold" fill="#111">Tk ${amt}.00</text><text x="40" y="318" font-family="Arial" font-size="13" fill="#666">To</text><text x="260" y="318" text-anchor="end" font-family="Arial" font-size="13" fill="#111">${to}</text><text x="40" y="348" font-family="Arial" font-size="13" fill="#666">TrxID</text><text x="260" y="348" text-anchor="end" font-family="Arial" font-size="13" fill="#111">${trx}</text><text x="40" y="378" font-family="Arial" font-size="13" fill="#666">Date</text><text x="260" y="378" text-anchor="end" font-family="Arial" font-size="13" fill="#111">${when}</text><line x1="40" y1="410" x2="260" y2="410" stroke="#eee"/><text x="150" y="445" text-anchor="middle" font-family="Arial" font-size="12" fill="#999">Sample screenshot (seed data)</text></svg>`;
}

// Production: create only the first admin (from ADMIN_PHONE). No demo members or payments.
function bootstrapAdmin(db, phone, name) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return false;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO users (id,name,phone,role,pays,active,collector_id,bkash,join_period,created_at)
              VALUES ('u1',?,?,'admin',0,1,NULL,NULL,'2026-01',?)`).run(name, phone, now);
  const setS = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
  setS.run('default_share', '200');
  setS.run('due_day', '10');
  setS.run('club_bkash_name', name);
  setS.run('club_bkash_no', phone);
  return true;
}

module.exports = { openDb, seed, bootstrapAdmin };
