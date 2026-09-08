#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { simulateFills, positionFromFills } from "../../engine/simrun.js";
import { STRAT } from "../../engine/strategies/wallet3048.js";

const EPS = 1e-8;
const finite = (value) => Number.isFinite(Number(value));
const round = (value) => finite(value) ? +Number(value).toFixed(8) : null;
const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round(sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]);
};

function freshness(ticks, sourceKey, receiveKey, maximumMs) {
  const ages = [];
  let missingSource = 0, missingReceive = 0, invalidClockOrder = 0;
  for (const tick of ticks) {
    const source = tick[sourceKey], receive = tick[receiveKey] ?? tick.receivedAtMs ?? tick.ms;
    if (!finite(source)) { missingSource++; continue; }
    if (!finite(receive)) { missingReceive++; continue; }
    const age = Number(receive) - Number(source);
    if (age < -1) invalidClockOrder++;
    else ages.push(Math.max(0, age));
  }
  return { observed: ages.length, missingSource, missingReceive, invalidClockOrder,
    thresholdMs: Number(maximumMs), fresh: ages.filter((age) => age <= Number(maximumMs)).length,
    p50AgeMs: percentile(ages, 0.5), p95AgeMs: percentile(ages, 0.95),
    maxAgeMs: ages.length ? round(Math.max(...ages)) : null };
}

const comparableDecision = (record) => ({
  oid: record?.oid ?? null, side: record?.side ?? null, leg: record?.leg ?? null,
  reason: record?.reason ?? null, tInto: round(record?.tInto), ts: round(record?.ts),
  shares: round(record?.shares), limitPx: round(record?.limitPx),
  pairReservation: (record?.pairReservation || []).map((slice) => ({
    lotId: String(slice?.lotId), shares: round(slice?.shares),
    effectivePrice: round(slice?.effectivePrice),
  })),
});

const comparableFill = (record) => ({
  ...comparableDecision(record), fillId: record?.fillId ?? null,
  decidedT: round(record?.decidedT), placedT: round(record?.placedT),
  effPx: round(record?.effPx), usdc: round(record?.usdc), fee: round(record?.fee),
  maker: record?.maker === true, fillEvidence: record?.fillEvidence ?? null,
  queueAssumption: record?.queueAssumption ?? null,
  levels: (record?.levels || []).map((level) => ({ price: round(level?.price),
    shares: round(level?.shares), usdc: round(level?.usdc), fee: round(level?.fee) })),
});

function compareRecords(expected, actual, project) {
  const left = expected.map(project), right = actual.map(project);
  if (left.length !== right.length) return { exact: false, expected: left.length,
    actual: right.length, firstMismatch: { index: Math.min(left.length, right.length),
      recorded: left[Math.min(left.length, right.length)] ?? null,
      replay: right[Math.min(left.length, right.length)] ?? null } };
  for (let index = 0; index < left.length; index++) {
    if (JSON.stringify(left[index]) !== JSON.stringify(right[index])) {
      return { exact: false, expected: left.length, actual: right.length,
        firstMismatch: { index, recorded: left[index], replay: right[index] } };
    }
  }
  return { exact: true, expected: left.length, actual: right.length, firstMismatch: null };
}

function ledger(fills, outcome) {
  const position = positionFromFills(fills, outcome);
  const buys = fills.filter((fill) => fill?.leg !== "merge");
  const merges = fills.filter((fill) => fill?.leg === "merge");
  const executionCost = buys.reduce((sum, fill) => sum + Number(fill.usdc || 0), 0);
  const executionFees = buys.reduce((sum, fill) => sum + Number(fill.fee || 0), 0);
  const removedCost = merges.reduce((sum, fill) => sum
    + Number(fill.mainUpCost || 0) + Number(fill.mainDnCost || 0), 0);
  const removedFees = merges.reduce((sum, fill) => sum + Number(fill.mainFee || 0), 0);
  return { inventory: { up: round(position.upShares), down: round(position.downShares) },
    executionCost: round(executionCost), executionFees: round(executionFees),
    mergeRemovedCost: round(removedCost), mergeRemovedFees: round(removedFees),
    settlementCost: round(position.totalCost), settlementFees: round(position.fee),
    settlementPnl: round(position.realizedPnl),
    exact: Math.abs(executionCost - removedCost - position.totalCost) <= EPS
      && Math.abs(executionFees - removedFees - position.fee) <= EPS };
}

export function validateRecorderWindow(data, filename = null) {
  const ticks = Array.isArray(data?.ticks) ? data.ticks : [];
  const cfg = { ...STRAT, ...(data?.cfg?.params || data?.cfg || {}) };
  const requiredCanonical = ticks.filter((tick) => finite(tick?.ms) && finite(tick?.t)
    && finite(tick?.upAsk) && finite(tick?.dnAsk)).length;
  const monotonic = ticks.every((tick, index) => index === 0
    || Number(tick.ms) >= Number(ticks[index - 1].ms));
  const sequenceComplete = ticks.every((tick, index) => Number(tick.sequence) === index + 1);
  const depthIdentity = ticks.filter((tick) => tick?.upDepthEventId != null
    && tick?.downDepthEventId != null).length;
  const timestampComplete = ticks.filter((tick) => finite(tick?.receivedAtMs ?? tick?.ms)
    && finite(tick?.binanceAtMs) && finite(tick?.binanceReceivedAtMs)
    && finite(tick?.chainlinkAtMs) && finite(tick?.chainlinkReceivedAtMs)
    && finite(tick?.upQuoteAtMs) && finite(tick?.upQuoteReceivedAtMs)
    && finite(tick?.downQuoteAtMs) && finite(tick?.downQuoteReceivedAtMs)
    && finite(tick?.upDepthAtMs) && finite(tick?.upDepthReceivedAtMs)
    && finite(tick?.downDepthAtMs) && finite(tick?.downDepthReceivedAtMs)).length;
  const fullDepth = ticks.filter((tick) => Array.isArray(tick?.up?.asks)
    && Array.isArray(tick?.up?.bids) && Array.isArray(tick?.down?.asks)
    && Array.isArray(tick?.down?.bids)).length;
  const makerEvidence = ticks.flatMap((tick) => [tick?.up, tick?.down])
    .flatMap((book) => Array.isArray(book?.makerEvidence) ? book.makerEvidence : []);
  const eligibleMakerEvidence = makerEvidence.filter((event) => event?.id != null
    && finite(event?.ts) && finite(event?.price) && finite(event?.shares)
    && String(event?.aggressorSide ?? event?.takerSide ?? "").toLowerCase() === "sell").length;
  const completeness = { schema: data?.schema ?? null, ticks: ticks.length,
    canonicalTicks: requiredCanonical, monotonicReceiveClock: monotonic,
    sequenceComplete, timestampCompleteTicks: timestampComplete,
    depthIdentityTicks: depthIdentity, fullDepthTicks: fullDepth,
    makerEvidenceEvents: makerEvidence.length,
    eligibleMakerEvidenceEvents: eligibleMakerEvidence,
    observedFlowScenarioReady: eligibleMakerEvidence > 0,
    openingBinance: finite(data?.openBinance ?? data?.openBz),
    openingChainlink: finite(data?.openPrice ?? data?.openCl),
    settlementOutcome: ["Up", "Down"].includes(data?.winSide ?? data?.settlement?.outcome),
    recordedDecisions: Array.isArray(data?.decisions), recordedFills: Array.isArray(data?.fills) };
  completeness.readyForExactParity = Number(data?.schema) >= 2 && ticks.length > 1
    && requiredCanonical === ticks.length && monotonic && sequenceComplete
    && timestampComplete === ticks.length && depthIdentity === ticks.length
    && fullDepth === ticks.length
    && completeness.openingBinance && completeness.openingChainlink
    && completeness.settlementOutcome && completeness.recordedDecisions && completeness.recordedFills;

  const freshnessReport = {
    binance: freshness(ticks, "binanceAtMs", "binanceReceivedAtMs", cfg.W3048_BINANCE_STALE_MS),
    chainlink: freshness(ticks, "chainlinkAtMs", "chainlinkReceivedAtMs", cfg.W3048_CHAINLINK_STALE_MS),
    upQuote: freshness(ticks, "upQuoteAtMs", "upQuoteReceivedAtMs", cfg.W3048_DEPTH_STALE_MS),
    downQuote: freshness(ticks, "downQuoteAtMs", "downQuoteReceivedAtMs", cfg.W3048_DEPTH_STALE_MS),
    upDepth: freshness(ticks, "upDepthAtMs", "upDepthReceivedAtMs", cfg.W3048_DEPTH_STALE_MS),
    downDepth: freshness(ticks, "downDepthAtMs", "downDepthReceivedAtMs", cfg.W3048_DEPTH_STALE_MS),
  };
  let parity = { available: false, reason: "recorder schema is incomplete for exact parity" };
  let reconciliation = { available: false, reason: "authoritative recorded fills are unavailable" };
  if (completeness.recordedFills) {
    reconciliation = { available: true,
      recorded: ledger(data.fills, data.winSide ?? data.settlement?.outcome) };
  }
  if (completeness.readyForExactParity) {
    const diagnostics = {};
    const replayFills = simulateFills({ ...data,
      windowStart: data.windowStart ?? data.ws,
      openBinance: data.openBinance ?? data.openBz,
      openPrice: data.openPrice ?? data.openCl,
    }, cfg, diagnostics);
    const decisionParity = compareRecords(data.decisions, diagnostics.decisions || [], comparableDecision);
    const fillParity = compareRecords(data.fills, replayFills, comparableFill);
    const replayLedger = ledger(replayFills, data.winSide ?? data.settlement?.outcome);
    reconciliation.replay = replayLedger;
    parity = { available: true, exact: decisionParity.exact && fillParity.exact
      && reconciliation.recorded.exact && replayLedger.exact,
    decisions: decisionParity, fills: fillParity,
    settlementPnlDelta: round(replayLedger.settlementPnl - reconciliation.recorded.settlementPnl) };
  }
  return { file: filename, slug: data?.slug ?? null, windowStart: data?.windowStart ?? data?.ws ?? null,
    completeness, freshness: freshnessReport, reconciliation, parity };
}

export function validateRecorderCohort(directory) {
  const files = fs.existsSync(directory) ? fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json")).sort() : [];
  const windows = [];
  const unavailable = [];
  for (const name of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
      windows.push(validateRecorderWindow(data, name));
    } catch (error) {
      unavailable.push({ file: name, reason: error.message });
    }
  }
  return { schema: 1, generatedAt: new Date().toISOString(), directory,
    diagnosticOnly: true,
    finalTestStatus: "sealed; this command does not label or summarize final-test performance",
    summary: { files: files.length, parsedWindows: windows.length,
      parityReady: windows.filter((row) => row.completeness.readyForExactParity).length,
      exactParity: windows.filter((row) => row.parity.exact === true).length,
      reconciled: windows.filter((row) => row.reconciliation.recorded?.exact === true).length,
      parityUnavailable: windows.filter((row) => row.parity.available !== true).length,
      reconciliationUnavailable: windows.filter((row) => row.reconciliation.available !== true).length,
      observedFlowUnavailable: windows.filter((row) =>
        row.completeness.observedFlowScenarioReady !== true).length,
      unavailable: unavailable.length },
    windows, unavailable: files.length ? unavailable
      : [{ file: null, reason: "no recorder JSON files are available in the requested directory" }] };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = path.resolve(import.meta.dirname, "../..");
  const directory = path.resolve(process.argv[2] || path.join(root, "data/fastmx-live/live-ticks"));
  const output = process.argv[3] ? path.resolve(process.argv[3]) : null;
  const report = validateRecorderCohort(directory);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (output) { fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, json); }
  process.stdout.write(json);
  if (!report.summary.files) process.exitCode = 2;
}
