#!/usr/bin/env node
// Research collection only; never changes runtime settings or submits orders.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { config } from '../../src/config/config.js';
import { normalizeV2OrderbookFrame } from '../../src/sources/history.js';

const root = path.resolve(import.meta.dirname, '../..');
const out = path.resolve(process.argv[2] || 'data/reports/wallet3048-inventory-calibration-2026-09-03_10');
fs.mkdirSync(path.join(out, 'feeds'), { recursive: true });
fs.mkdirSync(path.join(out, 'metadata'), { recursive: true });
const planFile = path.join(out, 'study-plan.json');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const iso = ms => new Date(ms).toISOString();
const plan = fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile)) : {
  schema: 1, frozenAt: iso(Date.now()), timezone: 'Europe/Berlin',
  from: '2026-09-02T22:00:00.000Z', toExclusive: '2026-09-10T08:40:00.000Z',
  splits: { train: ['2026-09-03','2026-09-05'], validation: ['2026-09-06','2026-09-06'],
    retrospectiveTest: ['2026-09-07','2026-09-09'], latestTest: ['2026-09-10','2026-09-10'] },
  sampleMs: 120, retainedLevels: 3, featureGridSeconds: 10,
  coverage: { maximumFirstSeconds: 2, minimumLastSeconds: 298, maximumGapSeconds: 6 },
  probabilityCandidates: ['market-midpoint','market-logit-calibration','state-logistic'],
  regularizationC: [0.1,1,10], selectionMetric: 'validation round-weighted Brier score',
  priceHorizonsSeconds: [1,5,15,30], priceCandidates: ['persistence','three-second-velocity','ridge'],
  jointQuoteHorizonsSeconds: [5,15,30,60], makerTargetOffsets: [0.01,0.03,0.05],
  executionLatencyMs: 520, modeledFeeRate: 0.07,
  primaryModelFeaturesUse: 'first observed round reference and Binance prices; finalized opening metadata excluded',
  makerEvidence: 'quote touch/cross opportunities only; not queue fills',
  files: Object.fromEntries(['engine/strategies/wallet3048.js','engine/simrun.js','engine/fillsim.js',
    'engine/fees.js','src/sources/history.js','data/runtime-config.json'].map(f => [f,digest(fs.readFileSync(path.join(root,f)))])),
};
if (!fs.existsSync(planFile)) fs.writeFileSync(planFile, JSON.stringify(plan,null,2)+'\n');
const headers = { Accept: 'application/json', 'X-API-Key': config.bapiKey, Authorization: `Bearer ${config.bapiKey}` };
const sleep = ms => new Promise(r => setTimeout(r,ms));
const num = x => x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x);
async function get(base,route,slug,page=1,limit=1) {
  const url = new URL(route,base);
  Object.entries({slug,page,limit}).forEach(([k,v])=>url.searchParams.set(k,String(v)));
  for (let attempt=0;attempt<5;attempt++) {
    try {
      const r = await fetch(url,{headers,signal:AbortSignal.timeout(45000)});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body=await r.json();
      assert.equal(body.code,0); assert.equal(body.slug,slug);
      return body;
    } catch(e) { if(attempt===4)throw e;await sleep(500*2**attempt); }
  }
}
const old = new Map();
for(const date of ['2026-09-07','2026-09-08','2026-09-09']) {
  const dir=path.join(root,`data/reports/current-bot-first-entry-${date}`);
  if(!fs.existsSync(path.join(dir,'bapi.json')))continue;
  for(const m of JSON.parse(fs.readFileSync(path.join(dir,'bapi.json'))).markets) {
    const file=path.join(dir,'feeds',`${m.slug}.json.gz`);
    if(fs.existsSync(file))old.set(m.slug,{meta:m,file});
  }
}
function audit(data) {
  const ticks=data.ticks; let maxGap=0,missing=0,backwards=0,mirror=0,mirrorN=0;
  for(let i=0;i<ticks.length;i++) {
    const t=ticks[i]; if(i) {const gap=t.ms-ticks[i-1].ms;maxGap=Math.max(maxGap,gap);if(gap<0)backwards++;}
    if(t.binanceAtMs==null||t.chainlinkAtMs==null||t.up?.depthTs==null||t.down?.depthTs==null)missing++;
    for(const [left,right] of [[t.up?.asks,t.down?.bids],[t.up?.bids,t.down?.asks]]) {
      for(const [price,size] of left||[]) {
        mirrorN++;if((right||[]).some(([p,q])=>Math.abs(p+price-1)<1e-8&&Math.abs(q-size)<1e-6))mirror++;
      }
    }
  }
  const first=ticks[0]?.t??null,last=ticks.at(-1)?.t??null;
  return {...data.audit, retainedTicks:ticks.length,firstSeconds:first,lastSeconds:last,
    maxGapSeconds:maxGap/1000,missingClocks:missing,backwards,mirrorLevels:mirror,checkedMirrorLevels:mirrorN,
    eligible: ticks.length>0&&first<=2&&last>=298&&maxGap<=6000&&!missing&&!backwards&&['Up','Down'].includes(data.winSide)};
}
async function collect(ws) {
  const slug=`btc-updown-5m-${ws}`, file=path.join(out,'feeds',`${slug}.json.gz`);
  const metaFile=path.join(out,'metadata',`${slug}.json`);
  let data,source;
  if(fs.existsSync(file)) {data=JSON.parse(zlib.gunzipSync(fs.readFileSync(file)));source='study-cache';}
  else if(old.has(slug)) {
    const prior=old.get(slug); data=JSON.parse(zlib.gunzipSync(fs.readFileSync(prior.file)));
    data.reusedFrom=path.relative(root,prior.file);data.reusedSha256=digest(fs.readFileSync(prior.file));
    fs.writeFileSync(metaFile,JSON.stringify(prior.meta));source='prior-bapi-cache';
  } else {
    const meta=fs.existsSync(metaFile)?JSON.parse(fs.readFileSync(metaFile)):await get(config.backtestApi,'/snapshot-ticks',slug);
    fs.writeFileSync(metaFile,JSON.stringify(meta));
    const ticks=[],pages=[];let rawCount=0,total=null,lastMs=null,rawMaxGap=0,firstKeys=null;
    for(let page=1;;page++) {
      const body=await get(config.v2OrderbookApi,'/orderbooks',slug,page,2000);
      total??=Number(body.pagination.total);assert.equal(Number(body.pagination.total),total,'pagination changed');
      pages.push({page,count:body.frames.length,sha256:digest(JSON.stringify(body))});
      for(const f of body.frames||[]) {
        firstKeys??=Object.keys(f);rawCount++;
        const t=normalizeV2OrderbookFrame(f,ws);assert(t&&t.t>=0&&t.t<300,'out-of-window frame');
        if(lastMs!=null){assert(t.ms>=lastMs,'backward timestamp');rawMaxGap=Math.max(rawMaxGap,t.ms-lastMs);}lastMs=t.ms;
        t.binanceAtMs=num(f.binanceAggMinRecvTsMs??f.binanceMinRecvTsMs);
        t.chainlinkAtMs=num(f.spotMinRecvTsMs);
        for(const [side,book] of [['Up',t.up],['Down',t.down]]) {
          book.depthTs=num(f.clobMinRecvTsMs);
          book.depthEventId=`${side}:${book.depthTs}:${JSON.stringify([book.bids,book.asks])}`;
        }
        const bucket=Math.floor(t.ms/120);
        if(ticks.length&&Math.floor(ticks.at(-1).ms/120)===bucket)ticks[ticks.length-1]=t;else ticks.push(t);
      }
      if(page>=Number(body.pagination.totalPages))break;
    }
    assert.equal(rawCount,total,'incomplete pagination');
    data={schema:2,slug,windowStart:ws,source:config.v2OrderbookApi+'/orderbooks',retrievedAt:iso(Date.now()),
      winSide:meta.winSide,openPrice:num(meta.openPrice),openBinance:num(meta.openBinancePrice),ticks,
      audit:{rawCount,expected:total,rawMaxGapSeconds:rawMaxGap/1000,firstFrameFields:firstKeys,pages}};
    source='downloaded';
  }
  data.audit=audit(data);
  if(!fs.existsSync(file))fs.writeFileSync(file,zlib.gzipSync(JSON.stringify(data),{level:4}));
  const day=iso((ws+7200)*1000).slice(0,10);
  return {slug,windowStart:ws,day,source,winner:data.winSide,file:path.relative(root,file),sha256:digest(fs.readFileSync(file)),...data.audit};
}
const shardCount=Math.max(1,Number(process.env.W3048_CALIBRATION_SHARDS||1));
const shardIndex=Number(process.env.W3048_CALIBRATION_SHARD||0);
assert(Number.isInteger(shardCount)&&Number.isInteger(shardIndex)&&shardIndex>=0&&shardIndex<shardCount);
const allStarts=[];for(let ms=Date.parse(plan.from);ms<Date.parse(plan.toExclusive);ms+=300000)allStarts.push(ms/1000);
const starts=allStarts.filter((_,i)=>i%shardCount===shardIndex);
const results=new Array(starts.length);let cursor=0,done=0;
await Promise.all(Array.from({length:shardCount>1?2:4},async()=>{
  while(cursor<starts.length) {
    const i=cursor++;
    try {results[i]=await collect(starts[i]);}
    catch(e){results[i]={slug:`btc-updown-5m-${starts[i]}`,windowStart:starts[i],day:iso((starts[i]+7200)*1000).slice(0,10),error:e.message,eligible:false};}
    done++;
    if(done%24===0||done===starts.length) {
      fs.writeFileSync(path.join(out,`collection-progress-${shardIndex}.json`),JSON.stringify({done,total:starts.length,errors:results.filter(r=>r?.error).length}));
      console.log(JSON.stringify({phase:'collection',done,total:starts.length,errors:results.filter(r=>r?.error).length}));
    }
  }
}));
const manifest={schema:1,generatedAt:iso(Date.now()),planSha256:digest(fs.readFileSync(planFile)),rows:results};
fs.writeFileSync(path.join(out,shardCount===1?'manifest.json':`manifest-${shardIndex}.json`),JSON.stringify(manifest,null,2)+'\n');
if(shardCount>1&&Array.from({length:shardCount},(_,i)=>path.join(out,`manifest-${i}.json`)).every(f=>fs.existsSync(f))) {
  const shards=Array.from({length:shardCount},(_,i)=>JSON.parse(fs.readFileSync(path.join(out,`manifest-${i}.json`))));
  assert(shards.every(s=>s.planSha256===manifest.planSha256));
  const rows=shards.flatMap(s=>s.rows).sort((a,b)=>a.windowStart-b.windowStart);
  assert.equal(rows.length,allStarts.length);assert.equal(new Set(rows.map(r=>r.slug)).size,allStarts.length);
  fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify({...manifest,rows},null,2)+'\n');
}
console.log(JSON.stringify({phase:'complete',out,rounds:results.length,eligible:results.filter(r=>r.eligible).length,errors:results.filter(r=>r.error).length}));
