#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { simulateFills, positionFromFills } from '../../engine/simrun.js';
import { STRAT } from '../../engine/strategies/wallet3048.js';
const root=path.resolve(import.meta.dirname,'../..');
const out=path.resolve(process.argv[2]||'data/reports/wallet3048-inventory-calibration-2026-09-03_10');
const plan=JSON.parse(fs.readFileSync(path.join(out,'study-plan.json')));
const params={...STRAT,...JSON.parse(fs.readFileSync(path.join(root,'data/runtime-config.json'))).shadowParams};
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
for(const [f,h] of Object.entries(plan.files))assert.equal(hash(path.join(root,f)),h,`source changed: ${f}`);
fs.mkdirSync(path.join(out,'baseline'),{recursive:true});
fs.writeFileSync(path.join(out,'baseline-config.json'),JSON.stringify({params,hashes:plan.files},null,2));
const old=new Map();
for(const day of ['2026-09-07','2026-09-08','2026-09-09']) {
 const dir=path.join(root,`data/reports/current-bot-first-entry-${day}`);
 const cfg=JSON.parse(fs.readFileSync(path.join(dir,'replay-config.json')));
 if(Object.entries(plan.files).every(([k,h])=>cfg.hashes[k]===h))
  for(const r of JSON.parse(fs.readFileSync(path.join(dir,'summary.json'))).rows)old.set(r.slug,r);
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let done=0,reused=0;
const results=[];
for(let ms=Date.parse(plan.from);ms<Date.parse(plan.toExclusive);ms+=300000) {
 const slug=`btc-updown-5m-${ms/1000}`,input=path.join(out,'feeds',`${slug}.json.gz`),file=path.join(out,'baseline',`${slug}.json`);
 if(fs.existsSync(file)){results.push(JSON.parse(fs.readFileSync(file)));done++;continue;}
 while(!fs.existsSync(input)&&!fs.existsSync(path.join(out,'manifest.json')))await sleep(500);
 if(!fs.existsSync(input)){results.push({slug,status:'data-error'});continue;}
 let data;for(let a=0;a<5;a++){try{data=JSON.parse(zlib.gunzipSync(fs.readFileSync(input)));break;}catch(e){if(a===4)throw e;await sleep(500);}}
 let r;
 if(old.has(slug)) {r={...old.get(slug),baselineSource:'prior-identical-code-replay'};reused++;}
 else {
  const diagnostics={},fills=simulateFills(data,params,diagnostics);
  const buys=fills.filter(f=>f.leg!=='merge'&&f.shares>0),t=buys[0]?.tInto??null;
  const sides=[...new Set(buys.filter(f=>Math.abs(f.tInto-t)<1e-9).map(f=>f.side))];
  const p=positionFromFills(fills,data.winSide,data.ticks);
  r={slug,firstSide:sides.length===1?sides[0]:null,firstFillSeconds:t,winner:data.winSide,
    correct:sides.length===1?sides[0]===data.winSide:null,fillCount:buys.length,
    decisionCount:diagnostics.decisions?.length||0,pnl:p.realizedPnl,cost:p.totalCost,fees:p.fee,
    upShares:p.upShares,downShares:p.downShares,ifUp:p.ifUpWins,ifDown:p.ifDownWins,baselineSource:'new-v5-replay'};
 }
 r={...r,day:new Date(ms+7200000).toISOString().slice(0,10),eligible:data.audit.eligible,status:data.audit.eligible?'scored':'excluded',windowStart:ms/1000};
 fs.writeFileSync(file,JSON.stringify(r));results.push(r);done++;
 if(done%48===0)console.log(JSON.stringify({phase:'baseline',done,reused}));
}
fs.writeFileSync(path.join(out,'baseline.json'),JSON.stringify({rows:results},null,2));
console.log(JSON.stringify({phase:'baseline-complete',done,reused}));
