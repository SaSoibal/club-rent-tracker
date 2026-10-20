# Club Rent Tracker — Beta (device only)

This beta runs entirely on the phone or browser. There is no server to get or store data.

- The same club logic as the server app (`../server`) runs inside the page: the same screens, roles, rules, and payment screenshot reading (OCR).
- Data is stored on the device: a SQLite database (sql.js) and uploaded screenshots, both kept in IndexedDB.
- Each phone has its own data. To move the club to another phone, save a **backup file** (Setup → Save backup file) and restore it on the other phone.
- The app works without internet once its files are on the phone (service worker cache).

## Build and test

```bash
npm install
npm test          # builds the core for Node and runs test/device.test.js (61 checks)
npm run build     # builds www/device.js and copies the SQLite, OCR and language files into www/
```

Serve the `www/` folder with any static file server to open the app, then add it to the home screen:

```bash
npx http.server www   # or: python3 -m http.server 8080 --directory www
```

Browser test (needs the `playwright` package and Chromium, and the app served on port 8080):

```bash
node test/browser-smoke.js
```

It covers first-time setup, backup export and restore, offline reload, sample data, a member's screenshot read, and a check that no request leaves the page.

## Layout

| Path | What it is |
| --- | --- |
| `src/core.js` | Starts the club server code in-process. Device storage, backup and restore, setup. |
| `src/browser.js` | Browser entry: opens IndexedDB and exposes the core to the page. |
| `src/shims/` | Small stand-ins for `express`, `better-sqlite3`, `fs`, `crypto`, `path`, and `tesseract.js` so the server code runs in the browser. |
| `build.mjs` | esbuild: `node build.mjs` (browser) and `node build.mjs --node` (tests). |
| `www/app.js` | The page (forked from `public/app.js`). Calls the core instead of `fetch`. |
| `www/index.html`, `www/sw.js`, `www/style.css` | Shell, offline cache, styles. |
| `test/device.test.js` | Device API tests (same scenarios as `test/api.test.js`, plus setup, restart, backup). |
| `test/browser-smoke.js` | End-to-end browser test. |

## Limits of the device-only design

- **No sharing between phones.** Payments entered on one phone are not seen on another until a backup file is moved over. The collector, admin, and members each need their own copy of the data.
- **Browser storage can be cleared.** Clearing site data for the page erases the club. Save backups regularly.
- **First open needs the files.** The files must be served once (any static host or a local server). After that, the app runs offline.
- **Passwords** are checked on the phone. There is no central lockout across devices.
