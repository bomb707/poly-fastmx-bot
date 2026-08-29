#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { WALLET_3048 } from "./core.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const from = process.argv[2] || "2026-08-14";
const to = process.argv[3] || new Date().toISOString().slice(0, 10);
const output = path.resolve(process.argv[4] || path.join(ROOT, "data/wallet-3048/maker-rebates.json"));
const rows = [];
for (let ms = Date.parse(`${from}T00:00:00Z`); ms <= Date.parse(`${to}T00:00:00Z`); ms += 86_400_000) {
  const date = new Date(ms).toISOString().slice(0, 10);
  const url = new URL("https://clob.polymarket.com/rebates/current");
  url.searchParams.set("date", date);
  url.searchParams.set("maker_address", WALLET_3048);
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${response.status} ${date}: ${(await response.text()).slice(0, 120)}`);
  const entries = await response.json();
  const rebate = (Array.isArray(entries) ? entries : []).reduce((sum, entry) => sum + Number(entry.rebated_fees_usdc || 0), 0);
  rows.push({ date, markets: Array.isArray(entries) ? entries.length : 0, rebate });
  console.log(JSON.stringify(rows.at(-1)));
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify({ schema: 1, wallet: WALLET_3048, collectedAt: new Date().toISOString(), rows }, null, 2) + "\n");
console.log(JSON.stringify({ output, total: rows.reduce((sum, row) => sum + row.rebate, 0) }));
