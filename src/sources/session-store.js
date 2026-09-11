import fs from "node:fs";
import path from "node:path";

// Prefer the fuller ledger after a restart; a late pending write must not
// replace the settled version of the same position.
export function mergeSessionRows(...groups) {
  const rows = new Map();
  for (const row of groups.flat()) {
    if (!row || !Number.isFinite(row.windowStart)) continue;
    const prev = rows.get(row.windowStart);
    const fills = (r) => (Number(r.sim?.nFills) || 0) + (Number(r.real?.nFills) || 0);
    const resolved = (r) => r.status === "resolved" || r.winSide === "Up" || r.winSide === "Down";
    if (!prev || fills(row) > fills(prev)
      || (fills(row) === fills(prev) && (Number(resolved(row)) > Number(resolved(prev))
        || (resolved(row) === resolved(prev) && (Number(row.ts) || 0) >= (Number(prev.ts) || 0))))) {
      rows.set(row.windowStart, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.windowStart - b.windowStart);
}

export function createSessionStore(directory) {
  const filename = (ws) => path.join(directory, `${ws}.json`);
  function readOne(ws) {
    try { return JSON.parse(fs.readFileSync(filename(ws), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  return {
    write(doc) {
      if (!Number.isSafeInteger(doc?.windowStart) || doc.windowStart < 0) {
        throw new Error("Session windowStart must be a nonnegative integer");
      }
      fs.mkdirSync(directory, { recursive: true });
      const previous = readOne(doc.windowStart);
      const chosen = mergeSessionRows(previous ? [previous] : [], [doc])[0];
      const { _id, ...row } = chosen;
      const file = filename(row.windowStart), temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(row) + "\n");
      fs.renameSync(temporary, file);
      return row;
    },
    read(since = 0) {
      let names;
      try { names = fs.readdirSync(directory); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
      return names.filter((name) => /^\d+\.json$/.test(name) && Number(name.slice(0, -5)) >= since)
        .map((name) => readOne(Number(name.slice(0, -5)))).filter(Boolean);
    },
  };
}
