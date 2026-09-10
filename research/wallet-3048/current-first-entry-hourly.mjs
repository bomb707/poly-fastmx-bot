#!/usr/bin/env node
// Research-only replay. No production configuration, orders, or database writes.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { config } from '../../src/config/config.js';
import { normalizeV2OrderbookFrame } from '../../src/sources/history.js';
import { simulateFills, positionFromFills } from '../../engine/simrun.js';
import { STRAT } from '../../engine/strategies/wallet3048.js';

const root = path.resolve(import.meta.dirname, '../..');
const analysisDate = process.argv[2] || '2026-09-09';
assert(/^2026-09-\d{2}$/.test(analysisDate), 'This report uses Berlin UTC+02:00 for September 2026');
const dayMs = Date.parse(`${analysisDate}T00:00:00Z`);
assert(Number.isFinite(dayMs) && new Date(dayMs).toISOString().slice(0, 10) === analysisDate);
const dir = path.join(root, `data/reports/current-bot-first-entry-${analysisDate}`);
fs.mkdirSync(path.join(dir, 'feeds'), { recursive: true });
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'data/runtime-config.json')));
const params = { ...STRAT, ...runtime.shadowParams };
assert.equal(params.STRATEGY, 'wallet3048');
assert.equal(params.W3048_SPEC_VERSION, 5);
assert.equal(params.W3048_MAKER_EXECUTION_POLICY, 'strict-no-maker');
const hashes = Object.fromEntries(['engine/strategies/wallet3048.js', 'engine/simrun.js',
  'engine/fillsim.js', 'engine/fees.js', 'src/sources/history.js', 'data/runtime-config.json']
  .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
fs.writeFileSync(path.join(dir, 'replay-config.json'), JSON.stringify({ params, hashes }, null, 2));
const headers = { 'X-API-Key': config.bapiKey, Authorization: `Bearer ${config.bapiKey}` };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = ms => new Date(ms).toISOString();
const num = v => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
async function get(url) {
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(45000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) { if (i === 4) throw e; await sleep(500 * 2 ** i); }
  }
}
async function collectMetadata() {
  const file = path.join(dir, 'bapi.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file));
  const markets = new Array(312);
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < markets.length) {
      const i = cursor++, ws = dayMs/1000 - 7200 + i*300;
      const slug = `btc-updown-5m-${ws}`;
      const url = new URL('/snapshot-ticks', config.backtestApi);
      for (const [k,v] of Object.entries({ slug, page: 1, limit: 1 })) url.searchParams.set(k,String(v));
      const body = await get(url);
      assert.equal(body.slug, slug); assert.equal(body.code, 0);
      markets[i] = body;
    }
  }));
  const result = { source: config.backtestApi + '/snapshot-ticks', retrievedAt: iso(Date.now()), markets };
  fs.writeFileSync(file, JSON.stringify(result));
  console.log(JSON.stringify({ phase: 'metadata', date: analysisDate, markets: markets.length }));
  return result;
}
const metadata = await collectMetadata();
async function feed(meta) {
  const file = path.join(dir, 'feeds', `${meta.slug}.json.gz`);
  if (fs.existsSync(file)) return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));
  const ws = Number(meta.windowStartUnix), ticks = [];
  let rawCount = 0, expected = null, firstMs = null, lastMs = null, missingClocks = 0;
  for (let page = 1; ; page++) {
    const u = new URL('/orderbooks', config.v2OrderbookApi);
    for (const [k, v] of Object.entries({ slug: meta.slug, page, limit: 2000 })) u.searchParams.set(k, String(v));
    const b = await get(u);
    assert.equal(b.slug, meta.slug); assert.equal(b.code, 0);
    expected ??= Number(b.pagination.total);
    assert.equal(Number(b.pagination.total), expected, 'pagination changed during collection');
    for (const f of b.frames || []) {
      rawCount++;
      const tk = normalizeV2OrderbookFrame(f, ws);
      assert(tk && tk.ms >= ws*1000 && tk.ms < (ws+300)*1000);
      assert(lastMs == null || tk.ms >= lastMs, 'frames out of time order');
      firstMs ??= tk.ms; lastMs = tk.ms;
      // These are explicit historical recorder receive clocks, not original
      // exchange payload clocks. This mapping is a labeled replay assumption.
      tk.binanceAtMs = num(f.binanceAggMinRecvTsMs ?? f.binanceMinRecvTsMs);
      tk.chainlinkAtMs = num(f.spotMinRecvTsMs);
      const depthTs = num(f.clobMinRecvTsMs);
      for (const [side, book] of [['Up', tk.up], ['Down', tk.down]]) {
        book.depthTs = depthTs;
        book.depthEventId = `${side}:${depthTs}:${JSON.stringify([book.bids, book.asks])}`;
      }
      if (tk.binanceAtMs == null || tk.chainlinkAtMs == null || depthTs == null) missingClocks++;
      const bucket = Math.floor((tk.ms - ws*1000) / 120);
      if (ticks.length && Math.floor((ticks.at(-1).ms - ws*1000)/120) === bucket) ticks[ticks.length-1] = tk;
      else ticks.push(tk);
    }
    if (page >= Number(b.pagination.totalPages)) break;
  }
  assert.equal(rawCount, expected, 'incomplete pagination');
  const result = { schema: 1, source: config.v2OrderbookApi + '/orderbooks', retrievedAt: iso(Date.now()),
    windowStart: ws, slug: meta.slug, winSide: meta.winSide,
    openBinance: num(meta.openBinancePrice), openPrice: num(meta.openPrice), ticks,
    audit: { rawCount, expected, firstSeconds: (firstMs-ws*1000)/1000,
      lastSeconds: (lastMs-ws*1000)/1000, missingClocks,
      coverageComplete: rawCount > 0 && firstMs-ws*1000 <= 2000 && (ws+300)*1000-lastMs <= 2000 } };
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(result)));
  return result;
}
const markets = metadata.markets;
assert.equal(markets.length, 312);
assert.equal(new Set(markets.map(m => m.slug)).size, 312);
const results = new Array(markets.length);
let cursor = 0, done = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < markets.length) {
    const i = cursor++, meta = markets[i];
    try {
      const d = await feed(meta), diagnostics = {};
      const fills = simulateFills(d, params, diagnostics);
      const buys = fills.filter(f => f.leg !== 'merge' && f.shares > 0);
      const firstT = buys[0]?.tInto ?? null;
      const first = buys.filter(f => Math.abs(f.tInto-firstT) < 1e-9);
      const sides = [...new Set(first.map(f => f.side))];
      const firstSide = sides.length === 1 ? sides[0] : null;
      const position = positionFromFills(fills, d.winSide, d.ticks);
      // Verify the unmodified dashboard adapter's missing-clock behavior too.
      const existingAdapterTicks = d.ticks.map(t => {
        const { binanceAtMs, chainlinkAtMs, ...rest } = t;
        const { depthTs: uTs, depthEventId: uId, ...up } = t.up;
        const { depthTs: dTs, depthEventId: dId, ...down } = t.down;
        return { ...rest, up, down };
      });
      const adapterDiagnostics = {};
      const adapterFills = simulateFills({ ...d, ticks: existingAdapterTicks }, params, adapterDiagnostics);
      const status = !d.audit.coverageComplete ? 'incomplete-feed' : !['Up','Down'].includes(d.winSide) ? 'missing-outcome'
        : !buys.length ? 'no-fill' : sides.length !== 1 ? 'ambiguous' : 'scored';
      results[i] = { slug: d.slug, windowStart: d.windowStart, startUtc: iso(d.windowStart*1000),
        startBerlin: iso((d.windowStart+7200)*1000).replace('Z', '+02:00'),
        status, firstSide, firstFillSeconds: firstT, firstFillPrice: first.length && firstSide
          ? first.reduce((s,f)=>s+f.usdc,0)/first.reduce((s,f)=>s+f.shares,0) : null,
        winner: d.winSide, correct: status === 'scored' ? firstSide === d.winSide : null,
        firstDecisionSide: diagnostics.decisions[0]?.side ?? null,
        firstDecisionSeconds: diagnostics.decisions[0]?.tInto ?? null,
        decisionCount: diagnostics.decisions.length, fillCount: buys.length,
        firstReason: first[0]?.reason ?? null, pnl: position.realizedPnl,
        cost: position.totalCost, fees: position.fee, upShares: position.upShares, downShares: position.downShares,
        ifUp: position.ifUpWins, ifDown: position.ifDownWins,
        originalAdapterFills: adapterFills.length, originalAdapterFinalGate: adapterDiagnostics.finalState?.gateReason,
        ...d.audit };
      fs.writeFileSync(path.join(dir, 'feeds', `${d.slug}.fills.json.gz`), zlib.gzipSync(JSON.stringify({ fills, decisions: diagnostics.decisions })));
    } catch (e) {
      results[i] = { slug: meta.slug, windowStart: Number(meta.windowStartUnix),
        startUtc: iso(Number(meta.windowStartUnix)*1000), status: 'error', error: e.message };
    }
    done++;
    if (done % 12 === 0 || done === markets.length) console.log(JSON.stringify({ done, total: markets.length,
      fills: results.filter(Boolean).reduce((s,r)=>s+(r.fillCount||0),0), errors: results.filter(r=>r?.status==='error').length }));
  }
}));
function aggregate(rows) {
  const scored = rows.filter(r=>r.status==='scored');
  const correct = scored.filter(r=>r.correct).length;
  const active = rows.filter(r=>r.fillCount>0 && ['scored','ambiguous'].includes(r.status));
  const wins = active.filter(r=>r.pnl>1e-8), losses = active.filter(r=>r.pnl < -1e-8);
  const sum = rs=>rs.reduce((s,r)=>s+r.pnl,0);
  return { rounds: rows.length, scored: scored.length, correct, incorrect: scored.length-correct,
    accuracyPct: scored.length ? correct/scored.length*100 : null,
    noFill: rows.filter(r=>r.status==='no-fill').length,
    ambiguous: rows.filter(r=>r.status==='ambiguous').length,
    incomplete: rows.filter(r=>!['scored','ambiguous','no-fill'].includes(r.status)).length,
    profitableRounds: wins.length, losingRounds: losses.length, netPnl: sum(active),
    avgWinningRound: wins.length ? sum(wins)/wins.length : null,
    avgLosingRound: losses.length ? sum(losses)/losses.length : null,
    originalAdapterFills: rows.reduce((s,r)=>s+(r.originalAdapterFills||0),0) };
}
function day(offset) {
  const from = dayMs/1000-offset*3600;
  const rows = results.filter(r=>r.windowStart>=from && r.windowStart<from+86400);
  const hourly = Array.from({length:24},(_,hour)=>({hour:String(hour).padStart(2,'0')+':00',
    ...aggregate(rows.filter(r=>r.windowStart>=from+hour*3600 && r.windowStart<from+(hour+1)*3600))}));
  assert.equal(rows.length,288); assert(hourly.every(h=>h.rounds===12));
  return { summary: aggregate(rows), hourly };
}
const result = { generatedAt: iso(Date.now()), analysisDate, strategy: 'wallet3048 v5 current runtime parameters',
  mode: `Historical simulation, not recorded ${analysisDate} bot trades`,
  clockAssumption: 'Bapi binanceAggMinRecvTsMs/binanceMinRecvTsMs, spotMinRecvTsMs and clobMinRecvTsMs used as freshness clocks; original live exchange payload clocks unavailable.',
  execution: '520 ms decision-to-arrival latency, three levels per book side, 120 ms last-observation sampling, strict-no-maker; no resting fills credited; independent round replays without session balance constraint.',
  definition: 'Earliest positive-share simulated fill per round, compared with Bapi final winner. Hour assigned by market start. No fills and incomplete coverage excluded; opposite sides at the earliest fill time are ambiguous.',
  sourceMetadata: { source: metadata.source, retrievedAt: metadata.retrievedAt },
  params, hashes, berlin: day(2), utc: day(0), rows: results };
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(result,null,2)+'\n');
function csv(file,rows) {
  const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))];
  const esc=v=>v==null?'':/[",\n]/.test(String(v))?'"'+String(v).replaceAll('"','""')+'"':String(v);
  fs.writeFileSync(path.join(dir,file),[keys.join(','),...rows.map(r=>keys.map(k=>esc(r[k])).join(','))].join('\n')+'\n');
}
csv('rounds.csv',results);csv('hourly-berlin.csv',result.berlin.hourly);csv('hourly-utc.csv',result.utc.hourly);
const fmt=n=>n==null?'N/A':n.toFixed(2);
const table=h=>`| Hour | Correct | Incorrect | Scored | Accuracy | No fill | Incomplete | Net simulated P&L |\n|---|---:|---:|---:|---:|---:|---:|---:|\n`+h.map(r=>`| ${r.hour} | ${r.correct} | ${r.incorrect} | ${r.scored} | ${fmt(r.accuracyPct)}% | ${r.noFill} | ${r.incomplete} | $${fmt(r.netPnl)} |`).join('\n');
const s=result.berlin.summary;
fs.writeFileSync(path.join(dir,'report.md'),`# Current wallet3048 initial-entry accuracy — ${analysisDate}\n\n**${fmt(s.accuracyPct)}%: ${s.correct}/${s.scored} scored rounds**, Berlin day (UTC+02:00).\n\n${result.mode}. ${result.definition}\n\n## Replay assumptions\n\n${result.clockAssumption}\n\n${result.execution}\n\nThe production historical adapter currently drops Binance/Chainlink timestamps. Its unmodified replay produced ${s.originalAdapterFills} fills across this day; its initial-entry accuracy is therefore undefined. The nonzero analysis uses an explicitly timestamp-mapped research adapter and does not change production code. It is not proof of historical live performance.\n\nThe current root runtime config uses v5; the stopped PM2 instance's separate saved config is v3. This analysis uses v5. Parameters and source hashes are in replay-config.json.\n\n## Hourly — Europe/Berlin\n\n${table(result.berlin.hourly)}\n\n## Hourly — UTC\n\n${table(result.utc.hourly)}\n\n## Round economics — Berlin day\n\n- Profitable rounds: ${s.profitableRounds}\n- Losing rounds: ${s.losingRounds}\n- Average winning round: $${fmt(s.avgWinningRound)}\n- Average losing round: $${fmt(s.avgLosingRound)}\n- Total net simulated P&L: $${fmt(s.netPnl)}\n\nRound economics include the complete simulated position and modeled execution fees, rather than just the initial buy. They exclude incomplete-feed rounds and carry the same fill/timestamp limitations.\n\nReproduce with \`node research/wallet-3048/current-first-entry-hourly.mjs ${analysisDate}\`. Metadata is frozen in bapi.json and normalized historical books in feeds/.\n`);
console.log(JSON.stringify({phase:'done',dir,berlin:result.berlin,utc:result.utc.summary},null,2));
