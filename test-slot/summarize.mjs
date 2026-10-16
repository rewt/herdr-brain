#!/usr/bin/env node
// Read execution receipts only. No admission or result acceptance authority.
import fs from 'node:fs';
import { isMain } from '../lib/cli-help.mjs';

export function summarize(receipts, { marginBytes } = {}) {
  if (marginBytes !== undefined && (!Number.isSafeInteger(marginBytes) || marginBytes < 0)) throw Error('margin must be a nonnegative byte count');
  const groups = new Map();
  for (const receipt of receipts) {
    const profile = receipt.resource?.profile;
    if (!profile) continue;
    // One execution receipt counts as one run, including both permitted attempts.
    const measurements = receipt.measurement_attempts?.length ? receipt.measurement_attempts : [receipt.measurement];
    const usable = measurements.filter(m => m?.rss_samples > 0 && Number.isFinite(m.sampled_sum_owned_rss_peak_bytes));
    const key = `${profile.id}@${profile.revision}`;
    const row = groups.get(key) ?? { profile: key, runs: 0, measured_runs: 0, incomplete_runs: 0, bindings: new Set(),
      observed_sampled_sum_owned_rss_max_bytes: null, individual_peak_rss_bytes: null, host_available_min_bytes: null, host_available_drawdown_max_bytes: null };
    row.runs++; row.bindings.add(profile.binding_sha256);
    if (usable.length) row.measured_runs++;
    if (!usable.length || measurements.some(m => m?.failure_count || m?.incomplete_rss_samples || m?.status !== 'observed')) row.incomplete_runs++;
    for (const m of usable) {
      row.observed_sampled_sum_owned_rss_max_bytes = Math.max(row.observed_sampled_sum_owned_rss_max_bytes ?? 0, m.sampled_sum_owned_rss_peak_bytes);
      row.individual_peak_rss_bytes = Math.max(row.individual_peak_rss_bytes ?? 0, m.individual_peak_rss_bytes ?? 0);
    }
    for (const m of measurements.filter(Boolean)) {
      if (Number.isFinite(m.host_available_min_bytes)) row.host_available_min_bytes = Math.min(row.host_available_min_bytes ?? Infinity, m.host_available_min_bytes);
      if (Number.isFinite(m.host_available_drawdown_bytes)) row.host_available_drawdown_max_bytes = Math.max(row.host_available_drawdown_max_bytes ?? 0, m.host_available_drawdown_bytes);
    }
    groups.set(key, row);
  }
  return [...groups.values()].map(({ bindings, ...row }) => ({ ...row, binding_count: bindings.size,
    provisional_envelope: marginBytes === undefined || row.measured_runs === 0 ? null : {
      bytes: row.observed_sampled_sum_owned_rss_max_bytes + marginBytes, chosen_margin_bytes: marginBytes,
      description: `observed max plus chosen margin, from ${row.measured_runs} runs; provisional, not a guarantee`,
    }, note: 'Sampled owned RSS, individual peak and host drawdown are distinct metrics. Inspect bindings, incomplete runs and cold/warm notes before choosing an envelope.' }));
}
if (isMain(import.meta.url)) {
  const args = process.argv.slice(2), margin = args.find(arg => arg.startsWith('--margin-bytes='));
  const files = [...new Set(args.filter(arg => !arg.startsWith('--')))];
  if (!files.length || args.some(arg => arg.startsWith('--') && arg !== margin)) throw Error('usage: node test-slot/summarize.mjs [--margin-bytes=N] RECEIPTS...');
  console.log(JSON.stringify(summarize(files.map(file => JSON.parse(fs.readFileSync(file, 'utf8'))), { marginBytes: margin ? Number(margin.split('=')[1]) : undefined }), null, 2));
}
