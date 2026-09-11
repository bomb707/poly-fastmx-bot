import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSessionStore, mergeSessionRows } from "./session-store.js";
import { sessionFromRecording } from "../../scripts/recover-session-ledger.mjs";

const row = (ws, extra = {}) => ({ windowStart: ws, status: "pending", ts: 1,
  sim: { pnl: null, nFills: 2 }, ...extra });

test("session ledger survives reload and filters the session reset boundary", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wallet3048-sessions-"));
  try {
    const store = createSessionStore(directory);
    store.write(row(100));
    store.write(row(400, { status: "resolved", winSide: "Up", sim: { nFills: 2, pnl: -3.25 } }));
    const reloaded = createSessionStore(directory);
    assert.equal(reloaded.read().length, 2);
    assert.deepEqual(reloaded.read(400).map((r) => r.sim.pnl), [-3.25]);
    assert.deepEqual(reloaded.read(401), []);
    store.write(row(400, { ts: 99 }));
    assert.equal(reloaded.read(400)[0].sim.pnl, -3.25, "late pending cannot undo resolution");
    store.write(row(400, { status: "resolved", ts: 100, sim: { nFills: 0, pnl: 0 } }));
    assert.equal(reloaded.read(400)[0].sim.pnl, -3.25, "empty restart cannot erase traded P&L");
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("MongoDB and local copies count a round only once", () => {
  const pending = row(100);
  const resolved = row(100, { status: "resolved", winSide: "Down", ts: 2, sim: { nFills: 2, pnl: 8 } });
  assert.deepEqual(mergeSessionRows([resolved], [pending, resolved]), [resolved]);
});

test("unreadable session data raises an error instead of returning a zero balance", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wallet3048-sessions-"));
  try {
    fs.writeFileSync(path.join(directory, "100.json"), "broken");
    assert.throws(() => createSessionStore(directory).read(), SyntaxError);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("recording recovery uses booked fills and fees without rerunning the strategy", () => {
  const recording = { recorder: "shadow-execution-evidence-v2", windowStart: 100,
    slug: "btc-updown-5m-100", winSide: "Down", settlement: { outcome: "Down", recordedAtMs: 420000 },
    fills: [{ side: "Up", shares: 50, usdc: 20, fee: 0.5 },
      { side: "Down", shares: 50, usdc: 15, fee: 0.7 }] };
  const recovered = sessionFromRecording(recording);
  assert.equal(recovered.sim.pnl, 13.8);
  assert.equal(recovered.sim.fee, 1.2);
  assert.equal(recovered.sim.nFills, 2);
  assert.equal(recovered.bot, null);
  assert.throws(() => sessionFromRecording({ ...recording, settlement: null }), /settlement evidence/);
  assert.throws(() => sessionFromRecording({ ...recording, fills: [{ ...recording.fills[0], fee: undefined }] }), /Incomplete/);
});
