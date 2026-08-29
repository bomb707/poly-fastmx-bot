#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const inputDir = path.resolve(process.argv[2] || 'data/wallet-3048-r5/feeds/v2-l2');
const outputDir = path.resolve(process.argv[3] || 'data/wallet-3048-r5/feeds/v2-l2-top3');
const levels = Math.max(1, Number(process.argv[4] || 3));
fs.mkdirSync(outputDir, { recursive: true });

const files = fs.readdirSync(inputDir).filter((name) => name.endsWith('.json.gz')).sort();
let ticks = 0;
for (let index = 0; index < files.length; index++) {
  const name = files[index];
  const source = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(inputDir, name))));
  const compactBook = (book) => ({
    asks: (book?.asks || []).slice(0, levels).map(({ price, size }) => ({ price: Number(price), size: Number(size) })),
    bids: (book?.bids || []).slice(0, levels).map(({ price, size }) => ({ price: Number(price), size: Number(size) })),
  });
  const compact = {
    schema: 1,
    source: source.source || 'polywin-v2-orderbooks',
    compactLevels: levels,
    frameIntervalMs: source.frameIntervalMs,
    slug: source.slug,
    openBinance: source.openBinance,
    openChainlink: source.openChainlink,
    winner: source.winner,
    upToken: source.upToken,
    downToken: source.downToken,
    ticks: source.ticks.map((tick) => ({
      ms: Number(tick.ms),
      bz: Number(tick.bz) || null,
      cl: Number(tick.cl) || null,
      up: compactBook(tick.up),
      down: compactBook(tick.down),
    })),
  };
  ticks += compact.ticks.length;
  fs.writeFileSync(path.join(outputDir, name), zlib.gzipSync(JSON.stringify(compact), { level: 9 }));
  if ((index + 1) % 25 === 0 || index + 1 === files.length) {
    console.log(JSON.stringify({ done: index + 1, total: files.length, ticks }));
  }
}

fs.writeFileSync(path.join(outputDir, 'manifest.json'), `${JSON.stringify({
  schema: 1,
  generatedAt: new Date().toISOString(),
  source: inputDir,
  markets: files.length,
  ticks,
  frameIntervalMs: 50,
  levels,
  note: 'No time downsampling: every native v2 50 ms frame is retained; only levels deeper than the configured execution/feature horizon are omitted.',
}, null, 2)}\n`);
