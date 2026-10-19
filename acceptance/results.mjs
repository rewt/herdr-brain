import fs from 'node:fs';
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
