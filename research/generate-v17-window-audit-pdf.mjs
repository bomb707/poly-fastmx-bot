#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, '..');
const DATA_DIR = path.join(PROJECT_DIR, 'data', 'research');
const OUTPUT_DIR = path.join(DATA_DIR, 'reports');
let PDFDocument;
try {
  PDFDocument = createRequire(import.meta.url)('pdfkit');
} catch (localError) {
  const rendererPackage = process.env.LOCKSTEP_PDFKIT_PACKAGE
    || '/tmp/lockstep-pdf-renderer/package.json';
  try {
    PDFDocument = createRequire(rendererPackage)('pdfkit');
  } catch {
    throw new Error(`pdfkit is required (run npm install); local lookup failed: ${localError.message}`);
  }
}

const SOURCES = ['v2', 'v4'].map((source) => {
  const inputPath = path.join(DATA_DIR, `passive-maker-v17-selected-${source}.json`);
  const raw = fs.readFileSync(inputPath);
  const payload = JSON.parse(raw);
  const diagnosticEntries = Object.entries(payload.diagnostics || {});
  if (diagnosticEntries.length !== 1) {
    throw new Error(`${inputPath}: expected exactly one diagnostic policy`);
  }
  const [diagnosticName, diagnostic] = diagnosticEntries[0];
  if (!Array.isArray(diagnostic.windowsDetail)) {
    throw new Error(`${inputPath}: diagnostics.windowsDetail is missing`);
  }
  return {
    source,
    inputPath,
    inputRelative: path.relative(PROJECT_DIR, inputPath),
    inputSha256: crypto.createHash('sha256').update(raw).digest('hex'),
    payload,
    diagnosticName,
    diagnostic,
  };
});

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const generatedAt = new Date().toISOString();
const allRows = SOURCES.flatMap(({ source, diagnostic }) => diagnostic.windowsDetail.map((window, i) => ({
  source,
  sourceIndex: i + 1,
  sourceWindowCount: diagnostic.windowsDetail.length,
  startUtc: new Date(window.startMs).toISOString(),
  active: Number(window.makerShares || 0) + Number(window.takerShares || 0) > 1e-9,
  ...window,
})));

const fieldSet = new Set();
for (const row of allRows) Object.keys(row).forEach((key) => fieldSet.add(key));
const preferredFields = ['source', 'sourceIndex', 'sourceWindowCount', 'startUtc', 'slug', 'active', 'winner', 'pnl'];
const csvFields = [
  ...preferredFields,
  ...[...fieldSet].filter((key) => !preferredFields.includes(key)).sort(),
];

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[\",\r\n]/.test(text) ? `\"${text.replaceAll('\"', '\"\"')}\"` : text;
}

const csvPath = path.join(OUTPUT_DIR, 'passive-maker-v17-all-windows.csv');
const csvStream = fs.createWriteStream(csvPath);
const csvDone = new Promise((resolve, reject) => {
  csvStream.on('finish', resolve);
  csvStream.on('error', reject);
});
csvStream.write(`${csvFields.map(csvCell).join(',')}\n`);
for (const row of allRows) {
  csvStream.write(`${csvFields.map((field) => csvCell(row[field])).join(',')}\n`);
}
csvStream.end();

function fmt(value, digits = 6) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function money(value) {
  const number = Number(value || 0);
  return `${number < 0 ? '-' : number > 0 ? '+' : ''}$${Math.abs(number).toFixed(4)}`;
}

function wrappedKeyValueLines(object, maxChars = 168, excluded = new Set()) {
  const tokens = Object.entries(object)
    .filter(([key]) => !excluded.has(key))
    .map(([key, value]) => `${key}=${fmt(value, 9)}`);
  const lines = [];
  let line = '';
  for (const token of tokens) {
    if (!line) {
      line = token;
    } else if (line.length + token.length + 3 <= maxChars) {
      line += ` | ${token}`;
    } else {
      lines.push(line);
      line = token;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function dailyRows(windows) {
  const grouped = new Map();
  for (const window of windows) {
    const day = new Date(window.startMs).toISOString().slice(0, 10);
    const row = grouped.get(day) || { windows: 0, active: 0, spend: 0, payout: 0, pnl: 0, peakSpend: 0 };
    row.windows += 1;
    if (Number(window.makerShares || 0) + Number(window.takerShares || 0) > 1e-9) row.active += 1;
    row.spend += Number(window.grossBuySpend || 0);
    row.payout += Number(window.payout || 0);
    row.pnl += Number(window.pnl || 0);
    row.peakSpend = Math.max(row.peakSpend, Number(window.grossBuySpend || 0));
    grouped.set(day, row);
  }
  return [...grouped.entries()].map(([day, row]) => ({ day, ...row }));
}

function makePdf({ outputPath, title, includeWindow }) {
  const doc = new PDFDocument({
    autoFirstPage: false,
    bufferPages: false,
    compress: true,
    info: {
      Title: title,
      Author: 'Lockstep research audit generator',
      Subject: 'Frozen v17 passive-maker window-level backtest audit',
      Keywords: 'Polymarket, backtest, V2, V4, PnL, audit',
      CreationDate: new Date(generatedAt),
    },
  });
  const output = fs.createWriteStream(outputPath);
  doc.pipe(output);

  let pageNumber = 0;
  let section = 'Report';
  const page = { size: 'A4', layout: 'landscape', margins: { top: 31, bottom: 28, left: 28, right: 28 } };

  function pageHeader() {
    const y = 13;
    doc.save();
    doc.font('Helvetica').fontSize(6.5).fillColor('#606770');
    doc.text(`LOCKSTEP V17 AUDIT  |  ${section}`, page.margins.left, y, { width: 650, lineBreak: false });
    doc.text(`UTC  |  page ${pageNumber}`, 680, y, { width: 105, align: 'right', lineBreak: false });
    doc.moveTo(page.margins.left, 24).lineTo(813, 24).strokeColor('#c8ccd0').lineWidth(0.5).stroke();
    doc.restore();
  }

  function addPage(nextSection = section) {
    section = nextSection;
    doc.addPage(page);
  }

  doc.on('pageAdded', () => {
    pageNumber += 1;
    pageHeader();
    doc.y = page.margins.top;
  });

  function ensure(lines = 1, lineHeight = 8) {
    if (doc.y + lines * lineHeight > doc.page.height - page.margins.bottom) addPage();
  }

  function heading(text, level = 1) {
    const sizes = { 1: 17, 2: 12, 3: 9 };
    ensure(level === 1 ? 4 : 3, 10);
    doc.moveDown(level === 1 ? 0.6 : 0.35);
    doc.font('Helvetica-Bold').fontSize(sizes[level]).fillColor(level === 1 ? '#14213d' : '#26364a');
    doc.text(text, { lineGap: 1 });
    doc.moveDown(0.25);
  }

  function paragraph(text, options = {}) {
    ensure(2, 8);
    doc.font(options.mono ? 'Courier' : 'Helvetica').fontSize(options.size || 7.5).fillColor(options.color || '#20242a');
    doc.text(String(text), { lineGap: options.lineGap ?? 1.5, paragraphGap: options.paragraphGap ?? 3 });
  }

  function kvBlock(label, object) {
    heading(label, 3);
    const lines = wrappedKeyValueLines(object, 172);
    doc.font('Courier').fontSize(6.4).fillColor('#20242a');
    for (const line of lines) {
      ensure(1, 7.4);
      doc.text(line, { lineGap: 0.7 });
    }
    doc.moveDown(0.3);
  }

  addPage('Overview');
  doc.font('Helvetica-Bold').fontSize(20).fillColor('#14213d').text(title);
  doc.moveDown(0.25);
  paragraph(`Generated: ${generatedAt} | Frozen inputs: ${SOURCES.map((x) => `${x.source.toUpperCase()} ${x.inputSha256.slice(0, 12)}`).join(' / ')}`);
  paragraph('Scope: every loaded five-minute window is included. V2 and V4 are alternative order-book reconstructions; their PnLs must not be added. Inactive windows are retained with zero fills and zero PnL. This is simulated historical performance, not live realized profit or a guarantee of future returns.', { size: 8 });
  paragraph('Capital terminology: grossBuySpend is buy turnover in that window/day. It is not a portfolio-level minimum bankroll calculation. makerRebate is fixed at zero in this frozen selection.', { size: 8 });

  heading('Source totals', 2);
  for (const source of SOURCES) {
    const d = source.diagnostic;
    paragraph(`${source.source.toUpperCase()}  windows=${d.windows}  active=${d.activeWindows}  grossBuySpend=$${Number(d.grossBuySpend).toFixed(4)}  payout=$${Number(d.payout).toFixed(4)}  PnL=${money(d.pnl)}  ROI=${Number(d.roiPct).toFixed(2)}%  maxDrawdown=$${Number(d.maxDrawdown).toFixed(4)}  profitFactor=${Number(d.profitFactor).toFixed(4)}`, { mono: true, size: 7 });
  }

  heading('Daily ledger', 2);
  paragraph('source day windows active grossBuySpend peakWindowSpend payout pnl roiPct', { mono: true, size: 7, color: '#4b5563' });
  for (const source of SOURCES) {
    for (const row of dailyRows(source.diagnostic.windowsDetail)) {
      const roi = row.spend ? (100 * row.pnl / row.spend) : 0;
      paragraph(`${source.source.toUpperCase().padEnd(6)} ${row.day} ${String(row.windows).padStart(7)} ${String(row.active).padStart(6)} ${row.spend.toFixed(4).padStart(13)} ${row.peakSpend.toFixed(4).padStart(15)} ${row.payout.toFixed(4).padStart(10)} ${row.pnl.toFixed(4).padStart(10)} ${roi.toFixed(2).padStart(7)}`, { mono: true, size: 7, paragraphGap: 0.5, lineGap: 0 });
    }
  }

  for (const source of SOURCES) {
    addPage(`${source.source.toUpperCase()} configuration`);
    heading(`${source.source.toUpperCase()} frozen input and configuration`, 1);
    paragraph(`Input: ${source.inputRelative}`);
    paragraph(`SHA-256: ${source.inputSha256}`, { mono: true, size: 6.8 });
    paragraph(`Diagnostic key: ${source.diagnosticName}`);
    kvBlock('Range', source.payload.range);
    paragraph(`Methodology: ${source.payload.methodology}`, { size: 7.2 });
    kvBlock('Base configuration', source.payload.base);
    source.payload.policies.forEach((policy, index) => kvBlock(`Selected policy ${index + 1}`, policy));
    kvBlock('Effective diagnostic parameters', source.diagnostic.params);
    const aggregates = Object.fromEntries(Object.entries(source.diagnostic).filter(([key]) => !['params', 'daily', 'windowsDetail'].includes(key)));
    kvBlock('Aggregate diagnostics', aggregates);
  }

  const selectedSources = SOURCES.map((source) => ({
    ...source,
    selectedWindows: source.diagnostic.windowsDetail.filter((window) => includeWindow(window)),
  }));

  for (const source of selectedSources) {
    addPage(`${source.source.toUpperCase()} windows`);
    heading(`${source.source.toUpperCase()} window-by-window ledger`, 1);
    paragraph(`Included ${source.selectedWindows.length} of ${source.diagnostic.windowsDetail.length} loaded ${source.source.toUpperCase()} windows in this edition. Every entry contains all raw window fields from the frozen JSON plus computed UTC timestamp and active status.`, { size: 8 });

    const rawKeys = source.diagnostic.windowsDetail.length ? Object.keys(source.diagnostic.windowsDetail[0]) : [];
    source.selectedWindows.forEach((window, selectedIndex) => {
      const sourceIndex = source.diagnostic.windowsDetail.indexOf(window) + 1;
      const active = Number(window.makerShares || 0) + Number(window.takerShares || 0) > 1e-9;
      const raw = Object.fromEntries(rawKeys.map((key) => [key, window[key]]));
      const rawLines = wrappedKeyValueLines(raw, 176);
      ensure(rawLines.length + 4, 7.2);
      doc.moveDown(0.35);
      doc.save();
      doc.rect(page.margins.left, doc.y, 785, 14).fill(active ? '#e9f7ef' : '#f2f4f6');
      doc.restore();
      doc.font('Helvetica-Bold').fontSize(7.4).fillColor(active ? '#12613c' : '#40464d');
      doc.text(`${source.source.toUpperCase()} ${String(sourceIndex).padStart(4, '0')}/${source.diagnostic.windowsDetail.length}  |  ${new Date(window.startMs).toISOString()}  |  ${window.slug}  |  ${active ? 'ACTIVE' : 'INACTIVE'}  |  winner=${window.winner}  |  PnL=${money(window.pnl)}`, page.margins.left + 4, doc.y + 3, { width: 775, lineBreak: false });
      doc.y += 6;
      doc.font('Courier').fontSize(6.15).fillColor('#20242a');
      for (const line of rawLines) {
        ensure(1, 7.1);
        doc.text(line, { lineGap: 0.45 });
      }
      if ((selectedIndex + 1) % 100 === 0) {
        doc.font('Helvetica').fontSize(6.5).fillColor('#6b7280').text(`Checkpoint: ${selectedIndex + 1}/${source.selectedWindows.length} entries in ${source.source.toUpperCase()} section`);
      }
    });
  }

  doc.end();
  return new Promise((resolve, reject) => {
    output.on('finish', () => resolve({ outputPath, pages: pageNumber }));
    output.on('error', reject);
  });
}

const completePdfPath = path.join(OUTPUT_DIR, 'passive-maker-v17-complete-window-audit.pdf');
const tradedPdfPath = path.join(OUTPUT_DIR, 'passive-maker-v17-traded-window-audit.pdf');

const [completePdf, tradedPdf] = await Promise.all([
  makePdf({
    outputPath: completePdfPath,
    title: 'Lockstep v17 Complete Window Audit — V2 and V4',
    includeWindow: () => true,
  }),
  makePdf({
    outputPath: tradedPdfPath,
    title: 'Lockstep v17 Traded Window Audit — V2 and V4',
    includeWindow: (window) => Number(window.makerShares || 0) + Number(window.takerShares || 0) > 1e-9,
  }),
]);

await csvDone;

const artifacts = [completePdf, tradedPdf, { outputPath: csvPath }].map((artifact) => {
  const bytes = fs.readFileSync(artifact.outputPath);
  return {
    path: path.relative(PROJECT_DIR, artifact.outputPath),
    bytes: bytes.length,
    pages: artifact.pages ?? null,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
});

const manifest = {
  schema: 1,
  generatedAt,
  report: 'passive-maker-v17-window-audit',
  interpretation: {
    sourceRelationship: 'V2 and V4 are alternative order-book reconstructions; do not add their PnL.',
    grossBuySpend: 'Buy turnover, not portfolio-level minimum bankroll.',
    performance: 'Simulated historical result; not live realized profit or a guarantee.',
  },
  inputs: SOURCES.map((source) => ({
    source: source.source,
    path: source.inputRelative,
    sha256: source.inputSha256,
    windows: source.diagnostic.windowsDetail.length,
    activeWindows: source.diagnostic.activeWindows,
    pnl: source.diagnostic.pnl,
  })),
  rows: allRows.length,
  csvFields,
  artifacts,
};
const manifestPath = path.join(OUTPUT_DIR, 'passive-maker-v17-window-audit-manifest.json');
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({ ...manifest, manifest: path.relative(PROJECT_DIR, manifestPath) }, null, 2));
