#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

try { process.loadEnvFile?.(path.resolve(import.meta.dirname, "../../.env")); } catch {}
const root = path.resolve(import.meta.dirname, "../..");
const input = path.resolve(process.argv[2] || path.join(root, "data/wallet-3048/trades-2026-08-14_2026-08-22.json"));
const outDir = path.resolve(process.argv[3] || path.join(root, "data/wallet-3048/feeds/v2"));
const base = String(process.env.BACKTEST_API || "https://bapi-v2.polywinbot.com").replace(/\/+$/, "");
const key = String(process.env.BAPI_KEY || process.env.BACKTEST_API_KEY || process.env.BAPI_V4_KEY || process.env.BAPI_V3_KEY || "").trim();
const headers = key ? { Accept: "application/json", "X-API-Key": key, Authorization: `Bearer ${key}` } : { Accept: "application/json" };
const data = JSON.parse(fs.readFileSync(input, "utf8"));
fs.mkdirSync(outDir, { recursive: true });
const pending = data.markets.filter((market) => !fs.existsSync(path.join(outDir, `${market.slug}.json.gz`)));
console.log(`v2 control collection: ${data.markets.length} total markets, ${pending.length} missing`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function getJson(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 120)}`);
      return await response.json();
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(200 * 2 ** attempt);
    }
  }
}
let cursor = 0, done = 0;
await Promise.all(Array.from({ length: 10 }, async () => {
  while (cursor < pending.length) {
    const market = pending[cursor++];
    const ticks = [];
    let page = 1, head = null;
    do {
      const raw = await getJson(`${base}/snapshot-ticks?slug=${encodeURIComponent(market.slug)}&page=${page}&limit=5000`);
      if (!head) head = raw;
      for (const tick of raw.ticks || []) ticks.push({
        ms: Number(tick.capturedAtMs),
        bz: tick.binancePrice == null ? null : Number(tick.binancePrice),
        cl: tick.chainlinkPrice == null ? null : Number(tick.chainlinkPrice),
        upAsk: tick.upBestAsk == null ? null : Number(tick.upBestAsk),
        dnAsk: tick.downBestAsk == null ? null : Number(tick.downBestAsk),
      });
      if (page >= Number(raw.pagination?.totalPages || 1)) break;
      page++;
    } while (page < 12);
    const compact = {
      slug: market.slug,
      openBinance: Number(head?.openBinancePrice ?? market.openBinance),
      openChainlink: Number(head?.openPrice ?? market.openChainlink),
      winner: head?.winSide ?? market.winner,
      ticks,
    };
    fs.writeFileSync(path.join(outDir, `${market.slug}.json.gz`), zlib.gzipSync(JSON.stringify(compact), { level: 6 }));
    done++;
    if (done % 50 === 0 || done === pending.length) console.log(`v2 controls: ${done}/${pending.length}`);
  }
}));
