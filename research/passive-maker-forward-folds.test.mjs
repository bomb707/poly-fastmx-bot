import assert from "node:assert/strict";
import test from "node:test";
import { expectedUtcDates, fixedUtcDateFoldPnls } from "./passive-maker-forward-folds.mjs";

const start = Date.parse("2026-08-24T06:40:00Z");

test("forward dates are fixed from the frozen cohort's first UTC date", () => {
  const dates = expectedUtcDates(start, 30);
  assert.equal(dates.length, 30);
  assert.equal(dates[0], "2026-08-24");
  assert.equal(dates.at(-1), "2026-09-22");
});

test("three forward folds use ten predeclared dates each", () => {
  const daily = Object.fromEntries(expectedUtcDates(start, 30).map((day) => [day, 1]));
  const folds = fixedUtcDateFoldPnls(daily, start);
  assert.deepEqual(folds.map(({ complete, pnl }) => ({ complete, pnl })), [
    { complete: true, pnl: 10 }, { complete: true, pnl: 10 }, { complete: true, pnl: 10 },
  ]);
});

test("a missing date makes its chronological fold incomplete", () => {
  const daily = Object.fromEntries(expectedUtcDates(start, 30).map((day) => [day, 1]));
  delete daily["2026-09-05"];
  const folds = fixedUtcDateFoldPnls(daily, start);
  assert.equal(folds[1].complete, false);
});
