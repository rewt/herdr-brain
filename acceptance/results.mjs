import fs from 'node:fs';
import path from 'node:path';
export function writeSummary(summary, summaryFile) {
  const bytes = JSON.stringify(summary, null, 2) + '\n';
  fs.writeFileSync(path.join(summary.evidence, 'summary.json'), bytes);
  if (summaryFile) fs.writeFileSync(path.resolve(summaryFile), bytes);
}
export const retainedRoots = (roots) => roots.filter((directory) => fs.existsSync(directory));
export function gateOutcome(results) {
  const counts = Object.fromEntries(['PASS', 'FAIL', 'PENDING', 'SKIP'].map((status) => [status, results.filter((v) => v.status === status).length]));
  return { counts, ready: !counts.FAIL && !counts.PENDING };
}
export function resultLine(result, residue = []) {
  const harness = result.origin === 'harness';
  const boundary = result.status === 'FAIL' && /acceptance_product_boundary|acceptance_boundary/.test(result.detail);
  const warnings = result.detail.split('\n').filter(line => line.startsWith('WARNING:'));
  return `${result.status.padEnd(7)} ${result.id} ${harness ? '[HARNESS] ' : boundary ? '[SAFETY] ' : ''}${result.name}`
    + (harness || boundary || result.status === 'SKIP' ? ' — ' + result.detail.split('\n')[0].slice(0, 200) : '')
    + (warnings.length ? ` — ${warnings.join('; ')}` : '')
    + (result.name === 'Cleanup and scope audit' && residue.length ? ` — retained: ${residue.join(', ')}` : '');
}
