#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { simulateFills, positionFromFills } from "../../engine/simrun.js";
import { STRAT } from "../../engine/strategies/wallet3048.js";
import { normalizeMakerExecutionPolicy } from "../../engine/fillsim.js";
import { assertOutcomeFreeInstrumentation, buildRecorderInstrumentation,
  finiteNumber, validPositive, validProbabilityPrice, validTimestamp } from "../../engine/recorder-quality.js";

const EPS = 1e-8;
const reportNumber = (value) => finiteNumber(value) ? +Number(value).toFixed(8) : null;
const canonicalNumber = (value) => finiteNumber(value) ? Number(value) : null;
const digest = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const comparableDecision = (record) => ({
  oid: record?.oid ?? null, side: record?.side ?? null, leg: record?.leg ?? null,
  reason: record?.reason ?? null, tInto: canonicalNumber(record?.tInto),
  ts: canonicalNumber(record?.ts), shares: canonicalNumber(record?.shares),
  limitPx: canonicalNumber(record?.limitPx),
  pairReservation: (record?.pairReservation || []).map((slice) => ({
    lotId: String(slice?.lotId), shares: canonicalNumber(slice?.shares),
    effectivePrice: canonicalNumber(slice?.effectivePrice),
  })),
});

const comparableFill = (record) => ({
  ...comparableDecision(record), fillId: record?.fillId ?? null,
  decidedT: canonicalNumber(record?.decidedT), placedT: canonicalNumber(record?.placedT),
  effPx: canonicalNumber(record?.effPx), usdc: canonicalNumber(record?.usdc),
  fee: canonicalNumber(record?.fee), maker: record?.maker === true,
  fillEvidence: record?.fillEvidence ?? null,
  fillEvidenceVerified: record?.fillEvidenceVerified === true,
  makerExecutionPolicy: record?.makerExecutionPolicy ?? null,
  queueAssumption: record?.queueAssumption ?? null,
  levels: (record?.levels || []).map((level) => ({ price: canonicalNumber(level?.price),
    shares: canonicalNumber(level?.shares), usdc: canonicalNumber(level?.usdc),
    fee: canonicalNumber(level?.fee) })),
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
  const buys = fills.filter((fill) => fill?.leg !== "merge");
  const merges = fills.filter((fill) => fill?.leg === "merge");
  let invalidExecutionFields = 0, levelDiscrepancies = 0;
  for (const fill of buys) {
    if (!validPositive(fill?.shares) || !finiteNumber(fill?.usdc) || Number(fill.usdc) < 0
      || !finiteNumber(fill?.fee) || Number(fill.fee) < 0
      || !validProbabilityPrice(fill?.effPx) || !validTimestamp(fill?.ts)) invalidExecutionFields++;
    if (Array.isArray(fill?.levels) && fill.levels.length) {
      const validLevels = fill.levels.every((level) => validProbabilityPrice(level?.price)
        && validPositive(level?.shares) && finiteNumber(level?.usdc) && Number(level.usdc) >= 0
        && finiteNumber(level?.fee) && Number(level.fee) >= 0);
      const levelShares = fill.levels.reduce((sum, level) => sum + Number(level?.shares), 0);
      const levelCost = fill.levels.reduce((sum, level) => sum + Number(level?.usdc), 0);
      const levelFees = fill.levels.reduce((sum, level) => sum + Number(level?.fee), 0);
      if (!validLevels || Math.abs(levelShares - Number(fill.shares)) > EPS
        || Math.abs(levelCost - Number(fill.usdc)) > EPS
        || Math.abs(levelFees - Number(fill.fee)) > EPS) levelDiscrepancies++;
    } else levelDiscrepancies++;
  }
  const executionCost = buys.reduce((sum, fill) => sum + Number(fill.usdc), 0);
  const executionFees = buys.reduce((sum, fill) => sum + Number(fill.fee), 0);
  const removedCost = merges.reduce((sum, fill) => sum
    + Number(fill.mainUpCost || 0) + Number(fill.mainDnCost || 0), 0);
  const removedFees = merges.reduce((sum, fill) => sum + Number(fill.mainFee || 0), 0);
  const validOutcome = ["Up", "Down"].includes(outcome);
  const position = positionFromFills(fills, validOutcome ? outcome : null);
  return { inventory: { up: reportNumber(position.upShares), down: reportNumber(position.downShares) },
    executionCost: reportNumber(executionCost), executionFees: reportNumber(executionFees),
    mergeRemovedCost: reportNumber(removedCost), mergeRemovedFees: reportNumber(removedFees),
    settlementCost: reportNumber(position.totalCost), settlementFees: reportNumber(position.fee),
    settlementPnl: validOutcome ? reportNumber(position.realizedPnl) : null,
    invalidExecutionFields, levelDiscrepancies,
    exact: invalidExecutionFields === 0 && levelDiscrepancies === 0
      && Math.abs(executionCost - removedCost - position.totalCost) <= EPS
      && Math.abs(executionFees - removedFees - position.fee) <= EPS };
}

export function validateRecorderWindow(data, filename = null, { allowPerformance = true } = {}) {
  const ticks = Array.isArray(data?.ticks) ? data.ticks : [];
  const recordedCfg = data?.cfg?.params || data?.cfg || {};
  const cfg = { ...STRAT, ...recordedCfg };
  if (!Object.hasOwn(recordedCfg, "W3048_MAKER_EXECUTION_POLICY")
    && Object.hasOwn(recordedCfg, "W3048_MAKER_FILL_ASSUMPTION")) {
    cfg.W3048_MAKER_EXECUTION_POLICY = normalizeMakerExecutionPolicy(
      null, recordedCfg.W3048_MAKER_FILL_ASSUMPTION);
  }
  const instrumentation = buildRecorderInstrumentation(data, cfg);
  const makerEvidence = ticks.flatMap((tick) => [tick?.up, tick?.down])
    .flatMap((book) => Array.isArray(book?.makerEvidence) ? book.makerEvidence : []);
  const eligibleMakerEvidence = makerEvidence.filter((event) => event?.id !== null
    && event?.id !== undefined && String(event.id).trim() !== ""
    && validTimestamp(event?.ts) && validProbabilityPrice(event?.price)
    && validPositive(event?.shares)
    && String(event?.aggressorSide ?? event?.takerSide ?? "").toLowerCase() === "sell").length;
  const outcome = allowPerformance ? data?.winSide ?? data?.settlement?.outcome : null;
  const recordedDecisions = allowPerformance && Array.isArray(data?.decisions);
  const recordedFills = allowPerformance && Array.isArray(data?.fills);
  const completeness = { schema: data?.schema ?? null, ticks: ticks.length,
    canonicalTicks: instrumentation.canonicalTicks,
    monotonicReceiveClock: instrumentation.monotonicEvaluationClock,
    sequenceComplete: instrumentation.sequenceGaps === 0,
    sequenceGaps: instrumentation.sequenceGaps,
    timestampCompleteTicks: instrumentation.timestampCompleteTicks,
    depthIdentityTicks: instrumentation.depthIdentityTicks,
    depthArraysPresentTicks: Math.min(instrumentation.depth.up.arraysPresent,
      instrumentation.depth.down.arraysPresent),
    usableDepthTicks: Math.min(instrumentation.depth.up.usable, instrumentation.depth.down.usable),
    invalidDepthTicks: instrumentation.depth.up.invalid + instrumentation.depth.down.invalid,
    makerEvidenceEvents: makerEvidence.length, eligibleMakerEvidenceEvents: eligibleMakerEvidence,
    observedFlowScenarioReady: eligibleMakerEvidence > 0,
    openingBinance: instrumentation.openingReferences.binance,
    openingChainlink: instrumentation.openingReferences.chainlink,
    settlementOutcome: allowPerformance && ["Up", "Down"].includes(outcome),
    recordedDecisions, recordedFills };
  completeness.readyForExactParity = allowPerformance && Number(data?.schema) >= 2 && ticks.length > 1
    && instrumentation.canonicalTicks === ticks.length
    && instrumentation.monotonicEvaluationClock && instrumentation.sequenceGaps === 0
    && instrumentation.timestampCompleteTicks === ticks.length
    && instrumentation.depthIdentityTicks === ticks.length
    && completeness.usableDepthTicks === ticks.length
    && completeness.openingBinance && completeness.openingChainlink
    && completeness.settlementOutcome && recordedDecisions && recordedFills;

  let parity = { available: false, reason: allowPerformance
    ? "recorder schema is incomplete for exact parity" : "performance fields are sealed" };
  let reconciliation = { available: false, reason: allowPerformance
    ? "authoritative recorded fills are unavailable" : "performance fields are sealed" };
  if (recordedFills) reconciliation = { available: true, recorded: ledger(data.fills, outcome) };
  if (completeness.readyForExactParity) {
    const diagnostics = {};
    const replayFills = simulateFills({ ...data,
      windowStart: data.windowStart ?? data.ws,
      openBinance: data.openBinance ?? data.openBz,
      openPrice: data.openPrice ?? data.openCl,
    }, cfg, diagnostics);
    const decisionParity = compareRecords(data.decisions, diagnostics.decisions || [], comparableDecision);
    const fillParity = compareRecords(data.fills, replayFills, comparableFill);
    const replayLedger = ledger(replayFills, outcome);
    reconciliation.replay = replayLedger;
    parity = { available: true, exact: decisionParity.exact && fillParity.exact
      && reconciliation.recorded.exact && replayLedger.exact,
    decisions: decisionParity, fills: fillParity,
    settlementPnlDelta: reportNumber(replayLedger.settlementPnl
      - reconciliation.recorded.settlementPnl) };
  }
  return { file: filename, slug: data?.slug ?? null,
    windowStart: data?.windowStart ?? data?.ws ?? null,
    completeness, freshness: instrumentation.freshness,
    instrumentation, reconciliation, parity };
}

export function readRecorderManifest(input) {
  const manifest = typeof input === "string"
    ? JSON.parse(fs.readFileSync(path.resolve(input), "utf8")) : input;
  if (!manifest || !Array.isArray(manifest.members)) {
    throw new Error("an explicit recorder cohort manifest with a members array is required");
  }
  const allowed = new Set(["burn-in", "development", "validation", "final-test"]);
  for (const member of manifest.members) {
    if (!allowed.has(member?.split) || !(member?.payload || member?.name)) {
      throw new Error("every cohort member requires payload/name and an explicit split");
    }
  }
  const declaredSealed = new Set((manifest.finalTest?.memberWindowStarts || []).map(String));
  const sealedRoot = String(manifest.finalTest?.payloadRoot || "").replace(/^\/+|\/+$/g, "");
  for (const member of manifest.members) {
    const payload = String(member.payload || member.name).replace(/\\/g, "/");
    const structurallySealed = declaredSealed.has(String(member.windowStart))
      || (sealedRoot && (payload === sealedRoot || payload.startsWith(`${sealedRoot}/`)));
    if ((member.split === "final-test") !== Boolean(structurallySealed)) {
      throw new Error("final-test split, protected membership, and sealed payload root must agree");
    }
  }
  return manifest;
}

export function isSealedFinalMember(manifest, member) {
  const declaredSealed = new Set((manifest.finalTest?.memberWindowStarts || []).map(String));
  const sealedRoot = String(manifest.finalTest?.payloadRoot || "").replace(/^\/+|\/+$/g, "");
  const payload = String(member.payload || member.name).replace(/\\/g, "/");
  return declaredSealed.has(String(member.windowStart))
    || Boolean(sealedRoot && (payload === sealedRoot || payload.startsWith(`${sealedRoot}/`)));
}

export function readVerifiedRecorderJson(file, expectedHash = null) {
  const bytes = fs.readFileSync(file);
  if (expectedHash && digest(bytes) !== expectedHash) throw new Error("manifest checksum mismatch");
  return JSON.parse(bytes.toString("utf8"));
}

export function validateRecorderCohort({ recorderRoot, manifest: manifestInput, splits = null }) {
  const manifest = readRecorderManifest(manifestInput);
  const root = path.resolve(recorderRoot);
  const selectedSplits = splits == null ? null : new Set(Array.isArray(splits) ? splits : [splits]);
  const members = selectedSplits
    ? manifest.members.filter((member) => selectedSplits.has(member.split)) : manifest.members;
  const windows = [], unavailable = [];
  const sealedFinalTest = { expectedWindows: 0, payloadsPresent: 0,
    instrumentationFiles: 0, validInstrumentationFiles: 0,
    sourceClockIssues: 0, staleAtEvaluation: 0, sequenceGaps: 0,
    unusableDepthSides: 0 };
  let payloadsPresent = 0, diskUsageBytes = 0;
  for (const member of members) {
    const payloadRelative = member.payload || member.name;
    const payloadFile = path.resolve(root, payloadRelative);
    if (!payloadFile.startsWith(`${root}${path.sep}`)) throw new Error("manifest payload escapes recorder root");
    let payloadPresent = false;
    try { const stat = fs.statSync(payloadFile); payloadPresent = stat.isFile();
      if (payloadPresent) { payloadsPresent++; diskUsageBytes += stat.size; } } catch {}
    if (isSealedFinalMember(manifest, member)) {
      sealedFinalTest.expectedWindows++;
      if (payloadPresent) sealedFinalTest.payloadsPresent++;
      const metadataRelative = member.instrumentation;
      if (!metadataRelative) continue;
      const metadataFile = path.resolve(root, metadataRelative);
      if (!metadataFile.startsWith(`${root}${path.sep}`)) throw new Error("manifest instrumentation escapes recorder root");
      try {
        const stat = fs.statSync(metadataFile); diskUsageBytes += stat.size;
        const metadata = readVerifiedRecorderJson(metadataFile, member.instrumentationSha256);
        sealedFinalTest.instrumentationFiles++;
        assertOutcomeFreeInstrumentation(metadata);
        sealedFinalTest.validInstrumentationFiles++;
        sealedFinalTest.sourceClockIssues += Number(metadata.sourceClockIssues || 0);
        sealedFinalTest.staleAtEvaluation += Number(metadata.staleAtEvaluation || 0);
        sealedFinalTest.sequenceGaps += Number(metadata.sequenceGaps || 0);
        sealedFinalTest.unusableDepthSides += [metadata.depth?.up, metadata.depth?.down]
          .filter((side) => Number(side?.usable) < Number(metadata.ticks)).length;
      } catch (error) {
        unavailable.push({ split: "final-test", file: null,
          reason: `sealed instrumentation unavailable: ${error.message}` });
      }
      continue;
    }
    if (!payloadPresent) {
      unavailable.push({ split: member.split, file: payloadRelative, reason: "payload is unavailable" });
      continue;
    }
    try {
      const data = readVerifiedRecorderJson(payloadFile, member.sha256);
      windows.push({ split: member.split,
        ...validateRecorderWindow(data, payloadRelative, { allowPerformance: true }) });
    } catch (error) {
      unavailable.push({ split: member.split, file: payloadRelative, reason: error.message });
    }
  }
  const summary = { expectedWindows: members.length, payloadsPresent,
    analyzedWindows: windows.length, sealedFinalTestWindows: sealedFinalTest.expectedWindows,
    parityReady: windows.filter((row) => row.completeness.readyForExactParity).length,
    exactParity: windows.filter((row) => row.parity.exact === true).length,
    reconciled: windows.filter((row) => row.reconciliation.recorded?.exact === true).length,
    parityUnavailable: windows.filter((row) => row.parity.available !== true).length,
    ledgerDiscrepancies: windows.filter((row) => row.reconciliation.recorded?.exact === false
      || row.reconciliation.replay?.exact === false).length,
    shadowReplayMismatches: windows.filter((row) => row.parity.available && !row.parity.exact).length,
    sequenceGaps: windows.reduce((sum, row) => sum + row.completeness.sequenceGaps, 0),
    missingOrInvalidSourceFields: windows.reduce((sum, row) => sum
      + row.instrumentation.sourceClockIssues, 0),
    staleAtEvaluation: windows.reduce((sum, row) => sum
      + row.instrumentation.staleAtEvaluation, 0),
    observedFlowUnavailable: windows.filter((row) =>
      row.completeness.observedFlowScenarioReady !== true).length,
    unavailable: unavailable.length, diskUsageBytes };
  return { schema: 2, generatedAt: new Date().toISOString(), recorderRoot: root,
    cohortId: manifest.cohortId ?? null, diagnosticOnly: true,
    finalTestStatus: "sealed payloads were not opened; only outcome-free instrumentation metadata was aggregated",
    summary, burnInChecklist: {
      expectedAndRecordedWindows: { expected: summary.expectedWindows, recorded: payloadsPresent },
      missingOrInvalidSourceFields: summary.missingOrInvalidSourceFields,
      decisionTimeStaleness: summary.staleAtEvaluation,
      sequenceGaps: summary.sequenceGaps,
      shadowReplayMismatches: summary.shadowReplayMismatches,
      ledgerDiscrepancies: summary.ledgerDiscrepancies,
      diskUsageBytes,
      retentionCoverage: { configuredWindows: manifest.retentionWindows ?? null,
        expectedWindows: summary.expectedWindows, payloadsPresent },
    }, sealedFinalTest, windows, unavailable };
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unexpected positional argument: ${key}`);
    options[key.slice(2)] = argv[++index];
  }
  if (!options.manifest || !options["recorder-root"]) {
    throw new Error("usage: validate-recorder-cohort.mjs --manifest FILE --recorder-root DIR [--output FILE]");
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = cliOptions(process.argv.slice(2));
    const report = validateRecorderCohort({ recorderRoot: options["recorder-root"],
      manifest: options.manifest,
      splits: options.splits ? options.splits.split(",").map((value) => value.trim()) : null });
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) { fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
      fs.writeFileSync(path.resolve(options.output), json); }
    process.stdout.write(json);
    if (!report.summary.expectedWindows) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
