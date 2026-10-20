// Builds the device app. `node build.mjs` -> www/device.js (browser). `node build.mjs --node` -> test/.build/core.cjs (for tests).
import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const shims = path.join(here, 'src', 'shims');
const SHIMMED = { express: 'express.js', 'better-sqlite3': 'better-sqlite3.js', fs: 'fs.js', crypto: 'crypto.js', path: 'path.js', 'tesseract.js': 'tesseract.js' };

// Server code imports Node modules. Point them at the device shims instead.
const deviceShims = {
  name: 'device-shims',
  setup(build) {
    build.onResolve({ filter: /^(express|better-sqlite3|fs|crypto|path|tesseract\.js)$/ }, args => {
      if (args.importer.endsWith('tesseract-real.js')) return undefined; // the real Tesseract library
      // Tesseract's own Node file helpers (test builds only) use the real Node fs, not the device shim.
      if (args.importer.includes(`${path.sep}node_modules${path.sep}tesseract.js${path.sep}`)) return undefined;
      if (args.importer.includes(`${path.sep}@noble${path.sep}`)) return { path: path.join(shims, 'empty.js') };
      return { path: path.join(shims, SHIMMED[args.path]) };
    });
  },
};

const common = {
  bundle: true,
  plugins: [deviceShims],
  logLevel: 'warning',
  target: 'es2019',
};

if (process.argv.includes('--node')) {
  fs.mkdirSync(path.join(here, 'test', '.build'), { recursive: true });
  await esbuild.build({ ...common, entryPoints: [path.join(here, 'src', 'core.js')], platform: 'node', format: 'cjs', outfile: path.join(here, 'test', '.build', 'core.cjs'), external: ['tesseract.js'] });
  console.log('built test/.build/core.cjs');
} else {
  await esbuild.build({
    ...common,
    entryPoints: [path.join(here, 'src', 'browser.js')],
    inject: [path.join(shims, 'buffer-inject.js')], // browser has no Buffer: use the npm package
    platform: 'browser',
    format: 'iife',
    outfile: path.join(here, 'www', 'device.js'),
    minify: true,
    define: { 'process.env': '{}', 'require.main': 'undefined', '__dirname': '"/"' },
  });
  // Static files the app needs offline: SQLite engine, OCR worker and model.
  const copies = [
    ['node_modules/sql.js/dist/sql-wasm-browser.wasm', 'www/sql-wasm-browser.wasm'],
    ['node_modules/tesseract.js/dist/worker.min.js', 'www/tesseract/worker.min.js'],
    ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js', 'www/tesseract/tesseract-core-lstm.wasm.js'],
    ['node_modules/tesseract.js-core/tesseract-core-lstm.wasm', 'www/tesseract/tesseract-core-lstm.wasm'],
    ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js', 'www/tesseract/tesseract-core-simd-lstm.wasm.js'],
    ['node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm', 'www/tesseract/tesseract-core-simd-lstm.wasm'],
    ['node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz', 'www/tessdata/eng.traineddata.gz'],
  ];
  for (const [from, to] of copies) {
    fs.mkdirSync(path.dirname(path.join(here, to)), { recursive: true });
    fs.copyFileSync(path.join(here, from), path.join(here, to));
  }
  console.log('built www/device.js and copied static files');
}
