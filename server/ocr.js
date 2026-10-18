'use strict';
// Screenshot reader. Runs fully offline using tesseract.js with the bundled English model.
const path = require('path');

const LANG_DIR = path.join(__dirname, '..', 'node_modules', '@tesseract.js-data', 'eng', '4.0.0');
let workerPromise = null;
let queue = Promise.resolve();

function getWorker() {
  if (!workerPromise) {
    const { createWorker } = require('tesseract.js');
    workerPromise = createWorker('eng', 1, { langPath: LANG_DIR, gzip: true, cacheMethod: 'none', logger: () => {} })
      .catch(err => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

// Parse the text of a bKash "Send Money" / payment confirmation screenshot.
function parseBkash(raw) {
  const text = String(raw || '').replace(/\r/g, '');
  const amtM = text.match(/(?:sent|paid|payment|send money|received)[^\n]{0,40}?(?:Tk|BDT|৳)\.?\s*([\d,]+(?:\.\d{1,2})?)/i)
            || text.match(/(?:Tk|BDT|৳)\.?\s*([\d,]+\.\d{2})/i);
  const amount = amtM ? Math.round(parseFloat(amtM[1].replace(/,/g, ''))) : null;

  const trxM = text.match(/T\s*r\s*x\s*[I1l|]?\s*D\s*[:\-.]?\s*([A-Z0-9]{8,12})/i);
  const trx = trxM ? trxM[1].toUpperCase() : null;

  const rcvM = text.match(/\b(01[3-9][\d•*xX][\d\s•*xX-]{6,12}\d)\b/);
  const receiver = rcvM ? rcvM[1].replace(/\s+/g, ' ').trim() : null;

  const dateM = text.match(/(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}(?:[ ,]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)?)/)
             || text.match(/(\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}(?:[ ,]+\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?)?)/);
  const paidText = dateM ? dateM[1].trim() : null;

  return { amount, trx, receiver, paidText, rawText: text.slice(0, 800) };
}

// Serialised so only one image is processed at a time.
function readReceipt(buffer) {
  const job = queue.then(async () => {
    const worker = await getWorker();
    const res = await worker.recognize(buffer);
    return parseBkash(res.data.text);
  });
  queue = job.catch(() => {});
  return job;
}

module.exports = { readReceipt, parseBkash };
