// Denial-only terminal fallback. Screen text is never proof for an approval.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseScreen } from './capture.mjs';
import { DENIAL_NUDGE } from './permission-policy.mjs';
const run = promisify(execFile);
export function fallbackRequest(row) {
  if (row.agent !== 'claude' || !row.terminal_id || !row.agent_session || row.dialog?.question !== 'Allow this read outside the working directories?' || !/^\s*Read\([^\n]+\)\s*$/m.test(row.screen ?? '')) return null;
  const expected = [
    'Yes, and keep allowing any reads outside the working directories',
    'No, and block reads outside the working directories from now on',
    'No, and ask again next time',
    'Yes, but ask again next time',
  ];
  if (row.dialog.options?.length !== 4 || !expected.every((label, i) => row.dialog.options[i].key === String(i + 1) && row.dialog.options[i].label === label)) return null;
  return { key: '3', behavior: 'deny', message: DENIAL_NUDGE };
}
export async function declineObserved(row, observed, { herdr = 'herdr', command = run, beforeKey = () => {} } = {}) {
  if (!fallbackRequest(row)) return { ok: false, reason: 'unsupported request' };
  const get = async () => {
    const { stdout } = await command(herdr, ['agent', 'get', row.session], { timeout: 2000, maxBuffer: 65536 });
    return JSON.parse(stdout).result?.agent;
  };
  const matches = current => current && current.agent === 'claude' && current.agent_status === 'blocked' && current.pane_id === row.pane && current.terminal_id === row.terminal_id && current.agent_session === row.agent_session && current.cwd === observed.cwd;
  if (!matches(await get())) return { ok: false, reason: 'occupant changed' };
  const { stdout } = await command(herdr, ['agent', 'read', row.session, '--source', 'recent-unwrapped', '--lines', '250', '--format', 'ansi'], { timeout: 2000, maxBuffer: 1024 * 1024 });
  const fresh = parseScreen(stdout, { agent: 'claude' });
  if (fresh.screen !== row.screen || JSON.stringify(fresh.dialog) !== JSON.stringify(row.dialog) || fresh.unsent || !matches(await get())) return { ok: false, reason: 'request changed' };
  await beforeKey(); // Durable recording nudge before consuming the request.
  const finalRead = await command(herdr, ['agent', 'read', row.session, '--source', 'recent-unwrapped', '--lines', '250', '--format', 'ansi'], { timeout: 2000, maxBuffer: 1024 * 1024 });
  const final = parseScreen(finalRead.stdout, { agent: 'claude' });
  if (final.screen !== row.screen || JSON.stringify(final.dialog) !== JSON.stringify(row.dialog) || final.unsent) return { ok: false, reason: 'request changed before key' };
  if (!matches(await get())) return { ok: false, reason: 'occupant changed before key' };
  // No retry after intent: a lost acknowledgement could already have acted.
  await command(herdr, ['agent', 'send-keys', row.session, '3'], { timeout: 2000, maxBuffer: 65536 });
  return { ok: true, behavior: 'deny', message: DENIAL_NUDGE };
}
