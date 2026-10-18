# Club Rent Tracker

A mobile-first web app for a friends' club with a ৳200 monthly share. Members pay by cash or bKash; a collector records payments; everyone sees who has paid and who owes.

## Run it

```bash
npm install
npm start            # http://localhost:3000  (binds 0.0.0.0; set PORT to change)
npm test             # API tests against a temporary database
```

Requires Node.js 18 or newer (developed on Node 20).

## Sign-in

Everyone signs in with **mobile number + password**. There is no SMS or WhatsApp code.

- The admin or a collector adds a member and sets that member's starting password (8 or more characters). They give it to the member.
- Members change their password under **Settings → Change password**. This signs out their other devices.
- Admins and collectors can reset a member's password from **Members → Edit**. The member is signed out everywhere.
- After 5 wrong passwords for one number, that number is blocked for 15 minutes.
- Sessions last until the user taps **Log out**.
- Passwords are stored as salted scrypt hashes, never in plain text.

## Deploy the backend on Render

The backend is one Node web service. The Blueprint file is `render.yaml`. It uses the **free plan**, which means:

> **Data loss warning:** the free plan has no persistent disk. The database (members, payments, requests) and uploaded screenshots are erased on every restart, redeploy, or sleep (after 15 idle minutes). Use it to try the app, not to keep real club records. For real data, switch to `starter` and uncomment the `disk` block in `render.yaml` (about $7.25/month). No code change is needed.

**Steps**
1. Push this folder to a GitHub repository (private is fine).
2. In Render, choose **New → Blueprint**, connect the repository, and apply `render.yaml`.
3. In the service's **Environment** tab, set these values (they are not stored in Git):
   - `ADMIN_PHONE`: the admin's mobile number, e.g. `01XXXXXXXXX`. This creates the first admin when the database is empty.
   - `ADMIN_PASSWORD`: the admin's first password, 8 or more characters. Change it after the first sign-in.
4. Wait for the deploy to finish. Check `https://YOUR-SERVICE.onrender.com/api/health`. It should show `"demo":false`.
5. Sign in with `ADMIN_PHONE` and `ADMIN_PASSWORD`, then add members with their starting passwords.
6. Enter the service URL as the **Server address** in the Android app.

**Environment variables**

| Variable | Set in | Purpose |
|---|---|---|
| `DEMO` | render.yaml (`0`) | `0` on public servers. Turns off demo accounts. |
| `DATA_DIR` | render.yaml (`/var/data`) | Location of the database and uploads (the disk mount path, once added) |
| `ADMIN_PHONE` | dashboard | Creates the first admin on an empty database |
| `ADMIN_PASSWORD` | dashboard (secret) | The first admin's password. Required when `ADMIN_PHONE` is set. |
| `ADMIN_NAME` | render.yaml | Name for that admin |
| `PORT` | Render sets it | Port to listen on |

**Backups:** on the starter plan with a disk, the database is `/var/data/club.db`. Download a copy from the Render shell before major changes.

## Android app (APK)

The Android app is the same web UI wrapped with Capacitor 6. The file is `apk/ClubRent-debug.apk`.

**Install on a phone**
1. Copy `apk/ClubRent-debug.apk` to the phone and open it. Allow "Install unknown apps" for your file manager.
2. Start the server on a computer (`npm start`). The phone must be on the same Wi-Fi.
3. Open **Club Rent** and enter the **Server address** on the first screen, for example `http://192.168.1.10:3000` (your computer's local IP). A public server must use `https://`.
4. Sign in with your mobile number and password. In demo mode, use a demo account (see below).

The server address is saved on the phone. The app works only while the server is running.

**Rebuild the APK** (needs JDK 17 and the Android SDK with platform 34 and build-tools 34.0.0)
```bash
cd mobile
npm install
npm run build:apk     # output: mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

**Limits of this APK**
- It is a debug build, signed with the debug key. It installs by sideloading. It is not for Google Play; a release build needs your own signing key.
- The bKash button uses a native bridge (`CRTNative.openBkash()`) that opens the bKash app, or its Play Store page if not installed. Not tested on a real phone.
- The launcher icon is the default Capacitor icon.
- Camera and gallery uploads rely on the WebView file picker. Not tested on a device.
- Not tested on an emulator or real phone in this environment. The build and package checks passed.
- Before friends use this with real money, set `DEMO=0` on the server and set the admin password.

## Demo accounts (dev mode)

Dev mode is on unless `DEMO=0`. All demo accounts use the password **`demo1234`**.

| Role | Number | Name |
|---|---|---|
| Admin | 01711000001 | Mahbub Alam |
| Collector | 01711000003 | Shakil Mia (group B) |
| Member | 01711000006 | Sabbir Ahmed (group A, collector Tanvir) |

Other seeded people: collector Tanvir Hasan `01711000002` (group A: Rahim, Karim, Sabbir, Imran, Fahim); members Nabil, Rafi, Arif in group B.

Role comes from the phone number.

## What each role can do

**Member**
- Home: this month's status, outstanding dues, full payment history.
- Pay via bKash: opens the bKash app (Android intent), shows the collector's number, and takes a screenshot upload. The app reads amount and TrxID; the member checks and sends.
- "I'll pay cash" and "Ask for update" send a request to the collector.
- "Won't pay this month" posts a note with a reason. It still counts as due until paid.
- Board: everyone's paid / due / note / review status, amounts and outstanding dues. Other members' payment details (TrxID, receiver, method) are hidden.
- Settings: change own password.

**Collector** (own group only)
- Collect: each member's status for the month. Record cash, record bKash with TrxID, remind one member, notify selected or all unpaid.
- Requests: verify member screenshots or status updates. Confirm updates the status. Reject requires a reason.
- Members: add (with a starting password), edit (including password reset), remove (deactivates; history is kept) members in own group.
- Setup: own bKash number and monthly amount.
- Sees every member's full history and details.

**Admin** (everything collectors do, for all groups, plus):
- Assign members to collectors, change role, monthly share and due day, admin bKash account.
- Create collection tasks for a collector (lists unpaid members and progress).
- Admin does not pay rent. Collectors pay the admin bKash account; members pay their collector.

## Screenshot flow

1. Member uploads a bKash payment screenshot (resized in the browser to ≤1600 px JPEG).
2. Server reads it offline with **tesseract.js** (English model bundled in `node_modules`). It extracts amount, TrxID, receiver number and date. The member can correct any field.
3. The request goes to the collector with the screenshot attached.
4. The collector ticks "I checked this payment", then confirms or rejects.
   - Confirm is blocked if the amount does not match the due, the TrxID is missing, or the TrxID was already used.
   - A TrxID that was already used shows a warning on the request.
5. Confirming records the payment and updates the board for everyone.

## What is real and what is stubbed

**Real (working in this build)**
- SQLite database (`data/club.db`, WAL mode), schema and seed data.
- Mobile + password sign-in with scrypt hashes, a 15-minute lock after 5 wrong passwords, and password change and reset.
- Server-side permissions for every role; members cannot see other members' payment details.
- Bearer sessions in the browser (`localStorage`) that persist until logout.
- Offline screenshot reading with tesseract.js. Tested on a generated receipt image: amount 200, TrxID 8N7A2K9X1B, receiver 01711000002, date read correctly.
- Confirm / reject flow, duplicate-TrxID checks, amount-mismatch blocking, notifications, collection tasks.

**Stubbed or not verified**
- **No phone verification.** Anyone who knows a registered number can try to sign in, so the password must be strong and unique. There is no "forgot password" link; an admin or collector resets it.
- **bKash deep link** (`intent://…package=com.bKash.customerapp`) is not tested on a real phone. If it does not open, the pay sheet shows the number to send to manually.
- **bKash payments are not verified automatically.** There is no bKash merchant API. The collector checks the screenshot and TrxID by hand; the app does not confirm money arrived.
- **Screenshot reading is OCR, not AI.** Accuracy depends on image quality. Anything it cannot read can be typed in. Test coverage is for one generated receipt layout, not many real bKash screens.
- **Browser image resizing** (canvas) is not covered by automated tests. The server-side OCR path is.
- Push notifications and due-date reminders are not built. Notifications appear in the Alerts tab.
- Partial payments are not supported; a month is either paid or not.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Port to listen on (host is always 0.0.0.0) |
| `DEMO` | on | `0` turns off demo accounts and the demo password |
| `ADMIN_PHONE` / `ADMIN_PASSWORD` | unset | First admin, created only when the database is empty |
| `CLUB_TODAY` | real date (Asia/Dhaka) | Override the current month, e.g. `2026-10`, for testing |

## Project layout

```
server/index.js   Express API: auth, members, payments, requests, notify, tasks
server/auth.js    Password hashing (scrypt) and the login lock
server/db.js      SQLite schema and seed data
server/ocr.js     Screenshot reader (tesseract.js) and bKash text parser
public/           Single-page app (index.html, app.js, style.css)
test/api.test.js  API test suite (npm test)
test/fixtures/    Sample receipt image used by the OCR test
data/             Database and uploaded screenshots (created at runtime)
```

## Open questions (from design; defaults used)

- Only ৳200 per month, no extra fees (default: yes).
- Members see each other's status and amount only (default; implemented).
- Reminders by push on due dates (not built).
- Language: English UI (default; Bangla not built).
- Android only or iOS too: responsive web app, works on both.
- Single admin (default).
