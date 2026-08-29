import assert from "node:assert/strict";
import test from "node:test";
import { assertAllMarketCoverage, crossSourceAvailability } from "./strict-maker-coverage.mjs";

const manifest = { markets: [{ slug: "a" }, { slug: "b" }] };
const report = (unavailableSlug = null) => ({
  range: { discovered: 2, represented: 2 },
  strictFillAudit: { enabled: true, unresolvedCandidateTransactions: 0 },
  diagnostics: {
    cell: {
      evaluatedWindows: unavailableSlug ? 1 : 2,
      unavailableWindows: unavailableSlug ? 1 : 0,
      windowsDetail: ["a", "b"].map((slug) => ({ slug, unavailable: slug === unavailableSlug })),
    },
  },
});

test("requires one unique explicit row for every market", () => {
  const coverage = assertAllMarketCoverage(report("b"), manifest);
  assert.equal(coverage.cells.cell.represented, 2);
  assert.deepEqual(coverage.cells.cell.unavailableSlugs, ["b"]);
  assert.throws(() => assertAllMarketCoverage({ ...report(), range: { discovered: 2, represented: 1 } }, manifest));
});

test("cross-source coverage identifies only markets unavailable everywhere", () => {
  assert.deepEqual(crossSourceAvailability({ v2: report("b"), v4: report("a") }, manifest), {
    expected: 2,
    evaluatedBySource: { v2: 1, v4: 1 },
    evaluatedByAnySource: 2,
    unavailableEverywhere: [],
  });
});
