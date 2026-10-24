// Read-only averages from completed observations; no gate or model execution.
import fs from 'node:fs';
import { isMain } from '../lib/cli-help.mjs';
import { readTimings } from './timings.mjs';

export function timingAverages(receipts) {
  const seen = new Set(), groups = new Map();
  for (const receipt of receipts) for (const row of receipt.timings ?? []) {
    if (row.event !== 'finish' || (row.depth ?? 0) !== 0 || !['file', 'suite', 'tier'].includes(row.kind) || !Number.isFinite(row.duration_s) || row.duration_s < 0 || seen.has(row.id)) continue;
    seen.add(row.id);
    const key = JSON.stringify([row.kind, row.name, row.tier ?? null]);
    const group = groups.get(key) ?? { kind: row.kind, name: row.name, ...(row.tier ? { tier: row.tier } : {}), samples: 0, total_s: 0, results: {} };
    group.samples++; group.total_s += row.duration_s;
    const result = String(row.exit_code);
    group.results[result] = (group.results[result] ?? 0) + 1;
    groups.set(key, group);
  }
  return [...groups.values()].map(row => ({ ...row, average_s: row.total_s / row.samples }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || (a.tier ?? '').localeCompare(b.tier ?? ''));
}
if (isMain(import.meta.url)) console.log(JSON.stringify(timingAverages(process.argv.slice(2).map(file =>
  file.endsWith('.jsonl') ? { timings: readTimings(file) } : JSON.parse(fs.readFileSync(file, 'utf8')))), null, 2));
