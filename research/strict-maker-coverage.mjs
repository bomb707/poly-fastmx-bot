import assert from "node:assert/strict";

/**
 * Prove that an audit report contains one explicit row for every manifest
 * market in every diagnostic cell. A row may be marked unavailable, but it
 * may never disappear from aggregates or per-window output.
 */
export function assertAllMarketCoverage(report, manifest, { requireConverged = true } = {}) {
  const expected = (manifest?.markets || []).map((market) => String(market.slug));
  assert.ok(expected.length > 0, "manifest contains no markets");
  assert.equal(new Set(expected).size, expected.length, "manifest contains duplicate slugs");
  assert.equal(report?.range?.discovered, expected.length, "discovered market count differs from manifest");
  assert.equal(report?.range?.represented, expected.length, "report does not represent every manifest market");
  if (requireConverged) {
    assert.equal(report?.strictFillAudit?.enabled, true, "strict maker-flow audit is disabled");
    assert.equal(report?.strictFillAudit?.unresolvedCandidateTransactions, 0,
      "strict maker-flow transaction discovery has not converged");
  }

  const expectedSet = new Set(expected);
  const cells = Object.entries(report?.diagnostics || {});
  assert.ok(cells.length > 0, "report contains no diagnostic cells");
  const cellCoverage = {};
  for (const [name, cell] of cells) {
    assert.ok(Array.isArray(cell.windowsDetail), `${name} has no windowsDetail`);
    const actual = cell.windowsDetail.map((window) => String(window.slug));
    const actualSet = new Set(actual);
    assert.equal(actual.length, expected.length, `${name} window count differs from manifest`);
    assert.equal(actualSet.size, actual.length, `${name} contains duplicate window rows`);
    const missing = expected.filter((slug) => !actualSet.has(slug));
    const unexpected = actual.filter((slug) => !expectedSet.has(slug));
    assert.deepEqual(missing, [], `${name} is missing manifest windows`);
    assert.deepEqual(unexpected, [], `${name} contains windows outside the manifest`);
    const unavailable = cell.windowsDetail.filter((window) => window.unavailable === true);
    assert.equal(Number(cell.evaluatedWindows) + Number(cell.unavailableWindows), expected.length,
      `${name} evaluated/unavailable accounting is incomplete`);
    assert.equal(Number(cell.unavailableWindows), unavailable.length,
      `${name} unavailable aggregate differs from window rows`);
    cellCoverage[name] = {
      represented: actual.length,
      evaluated: Number(cell.evaluatedWindows),
      unavailable: unavailable.length,
      unavailableSlugs: unavailable.map((window) => String(window.slug)),
    };
  }
  return { expected: expected.length, cells: cellCoverage };
}

export function crossSourceAvailability(reports, manifest) {
  const expected = (manifest?.markets || []).map((market) => String(market.slug));
  const evaluatedBySource = new Map();
  for (const [source, report] of Object.entries(reports || {})) {
    const firstCell = Object.values(report?.diagnostics || {})[0];
    evaluatedBySource.set(source, new Set((firstCell?.windowsDetail || [])
      .filter((window) => window.unavailable !== true).map((window) => String(window.slug))));
  }
  const unavailableEverywhere = expected.filter((slug) =>
    [...evaluatedBySource.values()].every((evaluated) => !evaluated.has(slug)));
  return {
    expected: expected.length,
    evaluatedBySource: Object.fromEntries([...evaluatedBySource].map(([source, slugs]) => [source, slugs.size])),
    evaluatedByAnySource: expected.length - unavailableEverywhere.length,
    unavailableEverywhere,
  };
}
