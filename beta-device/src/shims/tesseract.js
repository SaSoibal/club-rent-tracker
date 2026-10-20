'use strict';
// OCR for the device build. Reads the bundled English model and worker files from the app's own folder (no internet).
// Tests may override the paths with globalThis.__TESSERACT_CONFIG__.
const tesseract = require('./tesseract-real.js');

const DEVICE_CONFIG = {
  langPath: 'tessdata',            // eng.traineddata.gz is copied here by build.mjs
  workerPath: 'tesseract/worker.min.js',
  corePath: 'tesseract/',          // folder with the tesseract-core wasm files
};

module.exports = {
  createWorker(lang, oem, opts = {}) {
    const cfg = globalThis.__TESSERACT_CONFIG__ || DEVICE_CONFIG;
    return tesseract.createWorker(lang, oem, { ...opts, ...cfg, cacheMethod: 'none' });
  },
};
