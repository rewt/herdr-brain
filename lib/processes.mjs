// Only a fresh, successful start-time AND command match authorizes a signal.
import { loadTimeout } from './deadline.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readPlainFile } from './files.mjs';

const complete = (row) => row && Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.ppid) && row.ppid >= 0 && Number.isSafeInteger(row.pgid) && row.pgid >= 0 && typeof row.state === 'string' && !!row.state && typeof row.identity === 'string' && !!row.identity && typeof row.command === 'string' && !!row.command;

export function parseProcessLookup(result, pid) {
  if (result.error || result.signal) return { ok: false, error: `process source unavailable: ${result.error?.message ?? `terminated by ${result.signal}`}` };
  if (pid && result.status === 1 && !result.stdout && !result.stderr) return { ok: true, value: null };
  if (result.status !== 0 || result.stderr?.trim() || !result.stdout?.endsWith('\n')) return { ok: false, error: `failed or incomplete process source output (status ${result.status}): ${result.stderr?.trim() ?? ''}` };
  const rows = new Map();
  for (const line of result.stdout.trimEnd().split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { return { ok: false, error: 'malformed or truncated process source record' }; }
    if (!complete(row) || !/^\d+:\d+$/.test(row.identity) || rows.has(row.pid)) return { ok: false, error: 'incomplete or duplicate process source identity' };
    rows.set(row.pid, row);
  }
  if (pid) {
    if (rows.size !== 1 || !rows.has(pid)) return { ok: false, error: 'process source did not return the requested PID' };
    return { ok: true, value: rows.get(pid) };
  }
  // A complete system snapshot must contain its live caller as an anchor.
  if (!rows.has(process.pid)) return { ok: false, error: 'process source snapshot omitted its caller' };
  return { ok: true, value: rows };
}

const native = fileURLToPath(new URL('./native/', import.meta.url));
function darwinSource() {
  const target = `darwin-${process.arch}`, filename = `${native}process-source-${target}`;
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const manifest = JSON.parse(readPlainFile(`${native}manifest.json`));
  const bytes = readPlainFile(filename, null);
  if (manifest.version !== 1 || hash(bytes) !== manifest.targets?.[target]?.sha256 ||
      hash(readPlainFile(fileURLToPath(new URL('./process-source.c', import.meta.url)), null)) !== manifest.sourceSha256)
    throw Error('bundled process source checksum mismatch; rebuild native sources');
  const cpu = process.arch === 'arm64' ? 0x100000c : 0x1000007;
  if (!['arm64', 'x64'].includes(process.arch) || bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf ||
      bytes.readUInt32LE(4) !== cpu || bytes.readUInt32LE(12) !== 2) throw Error('process source Mach-O target mismatch');
  if (fs.statSync(filename).mode & 0o6000) throw Error('bundled process source must not be setuid or setgid');
  return filename;
}

function procRow(text, pid) {
  const match = String(text).match(/^(\d+) \((.*)\) (\S) (.*)\n?$/s);
  if (!match || Number(match[1]) !== pid) throw Error('malformed /proc stat identity');
  const fields = match[4].trim().split(/\s+/);
  const row = { pid, ppid: Number(fields[0]), pgid: Number(fields[1]), state: match[3], identity: fields[18], command: match[2] };
  if (!/^\d+$/.test(row.identity ?? '') || !complete(row)) throw Error('incomplete /proc stat identity');
  return row;
}
function linuxLookup(pid, readFile, listDirectory, identityOnly) {
  let boot;
  const bootIdentity = () => {
    if (boot) return boot;
    try {
      const value = String(readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw Error('invalid UUID');
      return boot = value.toLowerCase();
    } catch (error) { throw Error(`Linux boot identity unavailable: ${error.message}`); }
  };
  const one = pid => {
    let before;
    try { before = procRow(readFile(`/proc/${pid}/stat`, 'utf8'), pid); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
    let command, after;
    try {
      const argv = /^Z/.test(before.state) || identityOnly ? null : Buffer.from(readFile(`/proc/${pid}/cmdline`));
      if (argv?.length && argv.at(-1) !== 0) throw Error('truncated /proc command identity');
      command = identityOnly ? `[${before.command}]` : argv === null ? '<defunct>' : argv.toString('utf8').replace(/\0$/, '').replaceAll('\0', ' ');
      after = procRow(readFile(`/proc/${pid}/stat`, 'utf8'), pid);
    } catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return null; throw error; }
    if (before.identity !== after.identity) throw Error('process birth changed during /proc lookup');
    // Kernel threads have no argv; their comm still supplies a command identity.
    // Boot-relative ticks alone can repeat after a reboot. The UUID also keeps
    // identities textual through record set's numeric metadata coercion.
    return { ...after, identity: `${bootIdentity()}:${after.identity}`, command: command || `[${after.command}]` };
  };
  try {
    if (pid) return { ok: true, value: one(pid) };
    const rows = new Map();
    for (const name of listDirectory('/proc')) {
      if (!/^[1-9]\d*$/.test(name)) continue;
      const row = one(Number(name));
      if (row) rows.set(row.pid, row);
    }
    if (!rows.has(process.pid)) throw Error('/proc snapshot omitted its caller');
    return { ok: true, value: rows };
  } catch (error) { return { ok: false, error: `process source unavailable: ${error.message}` }; }
}

export function lookupProcess(pid, { platform = process.platform, identityOnly = false, readFile = fs.readFileSync, listDirectory = fs.readdirSync, execute = spawnSync, allowance = loadTimeout, pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  if (pid !== undefined && (!Number.isSafeInteger(pid) || pid < 1)) return { ok: false, error: 'invalid process PID' };
  if (platform === 'linux') return linuxLookup(pid, readFile, listDirectory, identityOnly);
  if (platform !== 'darwin') return { ok: false, error: `process source unavailable on ${platform}` };
  let executable;
  try { executable = darwinSource(); } catch (error) { return { ok: false, error: `process source unavailable: ${error.message}` }; }
  let result;
  for (let attempt = 0; attempt < 3; attempt++) {
    result = execute(executable, [...(identityOnly ? ['--identity'] : []), ...(pid ? [String(pid)] : [])], {
      encoding: 'utf8', timeout: allowance(2000 * 2 ** attempt), killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    });
    // Retry only an OS timeout on this read-only lookup. Partial, malformed or
    // refused output never becomes identity evidence; mutations are not retried.
    if (result.error?.code !== 'ETIMEDOUT' || attempt === 2) break;
    pause(allowance(50 * 2 ** attempt));
  }
  return parseProcessLookup(result, pid);
}
