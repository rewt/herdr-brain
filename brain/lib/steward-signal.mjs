import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const SIGNAL_MIN_VERSION = '0.14.8';
const versions = new Map();

export function validateSignal(signal) {
  if (!signal || typeof signal !== 'object' || Array.isArray(signal) ||
      Object.keys(signal).some(key => !['cli', 'account', 'recipient'].includes(key))) throw Error('steward signal requires cli, account and recipient');
  if (typeof signal.cli !== 'string' || !signal.cli.trim() || /[\x00-\x1f\x7f]/.test(signal.cli)) throw Error('steward signal cli must be an executable path or name');
  // Canonical phone numbers prevent aliases and option injection. The bot must
  // be registered separately, never linked to the operator's account.
  for (const key of ['account', 'recipient']) if (typeof signal[key] !== 'string' || !/^\+[1-9]\d{1,14}$/.test(signal[key])) throw Error(`steward signal ${key} must be an international phone number`);
  if (signal.account === signal.recipient) throw Error('steward signal requires two accounts: account equals recipient');
}

async function version(cli) {
  if (!versions.has(cli)) versions.set(cli, (async () => {
    try {
      const { stdout } = await run(cli, ['--version'], { timeout: 10000, maxBuffer: 65536 });
      const match = stdout.trim().match(/^signal-cli (\d+\.\d+\.\d+(?:\.\d+)?)$/);
      if (!match) return { version: null, error: 'signal-cli version is unrecognized; a stable release is required' };
      const value = match[1], parts = value.split('.').map(Number), minimum = SIGNAL_MIN_VERSION.split('.').map(Number);
      const difference = parts.map((part, i) => part - (minimum[i] ?? 0)).find(part => part !== 0) ?? 0;
      return { version: value, ...(difference < 0 ? { error: `signal-cli ${value} is unsupported; minimum ${SIGNAL_MIN_VERSION}` } : {}) };
    } catch (error) {
      return { version: null, error: error.code === 'ENOENT' ? 'signal-cli executable is missing' : 'signal-cli version check failed', code: error.code ?? null };
    }
  })());
  return versions.get(cli);
}

// One version probe per executable per process, including failed probes. A
// restart rechecks upgrades. No receive, daemon, shell, or automatic trust.
export async function signalAlert(text, signal) {
  validateSignal(signal);
  const started = Date.now(), checked = await version(signal.cli);
  const receipt = { channel: 'signal', ok: false, ...checked };
  if (checked.error) return receipt;
  const timeout = 10000 - (Date.now() - started);
  if (timeout <= 0) return { ...receipt, error: 'signal-cli channel deadline exceeded' };
  try {
    await run(signal.cli, ['--trust-new-identities', 'never', '-a', signal.account, 'send', '-m', text, signal.recipient], { timeout, maxBuffer: 65536 });
    return { ...receipt, ok: true };
  } catch (error) {
    // Do not copy command arguments, account addresses or transport stderr
    // into the receipt. Exit 4 is signal-cli's untrusted-key failure.
    return { ...receipt, code: error.code ?? null, error: error.code === 4
      ? 'signal-cli recipient identity is untrusted or changed; operator must re-verify the safety number and use trust -v'
      : error.killed ? 'signal-cli channel deadline exceeded' : 'signal-cli send failed' };
  }
}
