#!/usr/bin/env node
// Machine installation boundary, independent of the selected release's flags.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseArgs } from '../lib/cli-help.mjs';
import { fileURLToPath } from 'node:url';
import { quote } from '../discovery/runtime.mjs';
import { state, same, bytes, writable, recover, transact } from './entry-transaction.mjs';
import { snapshot } from './entry-runtime.mjs';
import { withInstallationLock } from './entry-lock.mjs';
import { planNativeHooks } from './native-hooks.mjs';

const { values } = parseArgs({ options: { product: { type: 'string' }, 'hook-runtime': { type: 'string' }, remove: { type: 'boolean' }, check: { type: 'boolean' }, snapshot: { type: 'boolean' }, recover: { type: 'boolean' } } });
const product = path.resolve(values.product ?? fileURLToPath(new URL('../', import.meta.url)));
const monitorHome = process.env.HERDR_MONITOR_HOME ?? path.join(process.env.HOME, '.local/share/herdr-monitor');
const bin = path.resolve(process.env.HERDR_MONITOR_ENTRY_BIN ?? path.join(monitorHome, 'entry/bin'));
const marker = path.join(bin, '.monitor-shell.json');
const journal = path.join(bin, '.monitor-recovery.json');
const lock = path.join(path.dirname(bin), '.monitor-install.lock');
const runtimeRoot = path.resolve(monitorHome, 'entry/runtimes');
const entryFile = path.join(bin, '.monitor-entry.json');
const names = ['codex', 'monitor-codex', 'claude', 'monitor-claude', 'monitor', 'herdr-read'];
const tag = '# >>> Herdr Monitor entry >>>';
const block = `\n${tag}\nexport PATH=${quote(bin)}:"$PATH"\n# <<< Herdr Monitor entry <<<\n`;
const blockBytes = Buffer.from(block), tagBytes = Buffer.from(tag);
const exists = (file) => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
function plain(file) {
  if (exists(file) && !fs.lstatSync(file).isFile()) throw new Error(`refusing non-plain machine file: ${file}`);
}
function read(file) { plain(file); return exists(file) ? fs.readFileSync(file, 'utf8') : ''; }
function stageInstaller(runtime, args, discovered) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-entry-plan-'));
  try {
    // v0.1.4 has no --check. Run its actual installer against a disposable bin,
    // then validate and commit its output ourselves with a recovery receipt.
    const r = spawnSync(process.execPath, [path.join(product, 'discovery/install.mjs'), '--bin', temporary, ...args], { encoding: 'utf8', timeout: 15000,
      env: { ...process.env, MONITOR_INSTALL_DISCOVERED_NATIVES: JSON.stringify(discovered) } });
    if (r.error || r.status !== 0) throw new Error(r.error?.message ?? r.stderr.trim());
    const receipt = JSON.parse(read(path.join(temporary, '.monitor-entry.json')));
    if (receipt.product !== product || !receipt.files || Object.keys(receipt.files).some((name) => !names.includes(name))) throw new Error('invalid staged entry receipt');
    for (const [name, content] of Object.entries(receipt.files)) {
      if (typeof content !== 'string' || read(path.join(temporary, name)) !== content) throw new Error('invalid staged wrapper');
      receipt.files[name] = content.split(quote(product).slice(1, -1)).join(quote(runtime).slice(1, -1));
    }
    receipt.product = runtime;
    return receipt;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
function native(kind, prior) {
  const supplied = process.env[`HERDR_MONITOR_${kind.toUpperCase()}`];
  if (supplied === '-') {
    if (prior?.[kind === 'codex' ? 'native' : 'claudeNative']) throw new Error(`retain ${kind} when upgrading its managed installation`);
    return undefined;
  }
  const field = kind === 'codex' ? 'native' : 'claudeNative';
  const explicitField = kind === 'codex' ? 'nativeExplicit' : 'claudeNativeExplicit';
  const candidates = supplied ? [supplied] : [
    ...(prior?.[explicitField] ? [prior[field]] : []),
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, kind)),
    prior?.[kind === 'codex' ? 'native' : 'claudeNative']];
  for (const candidate of candidates.filter(Boolean)) {
    if (!path.isAbsolute(candidate)) throw new Error(`native ${kind} path must be absolute`);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) continue;
    } catch (e) { if (supplied) throw new Error(`install native ${kind} or correct HERDR_MONITOR_${kind.toUpperCase()}: ${e.message}`); continue; }
    const target = fs.realpathSync(candidate);
    const receipt = [...new Set([path.dirname(candidate), path.dirname(target)])]
      .map(directory => path.join(directory, '.monitor-entry.json')).find(exists);
    if (receipt) {
      if (!supplied) continue; // Prefer the current native PATH launcher over old receipts.
      const original = JSON.parse(read(receipt))[kind === 'codex' ? 'native' : 'claudeNative'];
      if (!original) continue; // The other harness may be the only managed one.
      if (!path.isAbsolute(original) || path.dirname(original) === bin) throw new Error(`invalid native ${kind} receipt`);
      fs.accessSync(original, fs.constants.X_OK);
      return { binary: original, explicit: true };
    }
    return { binary: candidate, explicit: !!supplied || (prior?.[explicitField] === true && candidate === prior[field]) };
  }
  if (supplied) throw new Error(`install native ${kind} or correct HERDR_MONITOR_${kind.toUpperCase()}`);
}
function hooks() {
  const home = path.resolve(process.env.HOME);
  const zhome = path.resolve(process.env.ZDOTDIR || home);
  const login = ['.bash_profile', '.bash_login', '.profile'].find((name) => exists(path.join(home, name))) ?? '.bash_profile';
  return [...new Set([path.join(zhome, '.zshenv'), path.join(zhome, '.zshrc'), path.join(home, '.bashrc'), path.join(home, login)])];
}
try {
  withInstallationLock(lock, (owner) => {
    if (values.check && exists(journal)) throw new Error('pending entry recovery; run entry-install.mjs --recover first');
    if (!values.check) recover(journal, bin, runtimeRoot);
    if (values.recover) { console.log(`entry: recovered machine entry at ${bin}`); return; }
    // The installation lock excludes other installers, not operator editors.
    // Retain the first bytes and mode for each destination throughout planning.
    const inspected = new Map();
    const inspect = (file) => {
      if (!inspected.has(file)) inspected.set(file, state(file));
      return inspected.get(file);
    };
    const inspectBytes = (file) => inspect(file)?.content ?? Buffer.alloc(0);
    const shellState = inspect(marker);
    const priorShell = shellState ? JSON.parse(shellState.content.toString('utf8')) : null;
    if (priorShell && (priorShell.bin !== bin || !Array.isArray(priorShell.hooks) || (priorShell.version !== undefined && priorShell.version !== 2))) throw new Error('invalid shell installation receipt');
    const allowedNames = ['.zshenv', '.zshrc', '.bashrc', '.bash_profile', '.bash_login', '.profile'];
    if (priorShell?.hooks.some((r) => typeof r.file !== 'string' || !path.isAbsolute(r.file) || !allowedNames.includes(path.basename(r.file)) ||
      typeof r.before !== 'string' || typeof r.block !== 'string' || typeof r.missing !== 'boolean' || !Number.isInteger(r.mode) || r.mode < 0 || r.mode > 0o777) ||
      (priorShell && new Set(priorShell.hooks.map((r) => r.file)).size !== priorShell.hooks.length)) throw new Error('invalid shell file receipt');
    if (priorShell) {
      // Legacy receipts are owned JSON text; actual shell files are always read
      // as bytes. Removal splices the current bytes, preserving later user edits.
      for (const receipt of priorShell.hooks) {
        receipt.before = priorShell.version === 2 ? bytes(receipt.before) : Buffer.from(receipt.before);
        receipt.block = priorShell.version === 2 ? bytes(receipt.block) : Buffer.from(receipt.block);
        if (!receipt.block.equals(blockBytes)) throw new Error('invalid shell snippet receipt');
      }
    }
    const entryState = inspect(entryFile);
    const priorEntry = entryState ? JSON.parse(entryState.content.toString('utf8')) : null;
    if (priorEntry && (!priorEntry.files || Object.keys(priorEntry.files).some((name) => !names.includes(name)))) throw new Error('invalid managed entry receipt');
    for (const name of names) {
      const current = inspect(path.join(bin, name)), expected = priorEntry?.files[name];
      if (expected !== undefined && (typeof expected !== 'string' || !current?.content.equals(Buffer.from(expected)) || current.mode !== 0o755)) throw new Error(`managed file changed: ${path.join(bin, name)}`);
      if (expected === undefined && current) throw new Error(`refusing to replace unmanaged file ${path.join(bin, name)}`);
    }
    // Preflight all files before any writes. In-place replacement or removal of a
    // user-edited adapter/snippet requires resolving that edit, never overwriting it.
    const receipts = priorShell?.hooks ?? (values.remove ? [] : hooks()).map((file) => {
      const current = inspect(file), before = current?.content ?? Buffer.alloc(0);
      if (before.includes(tagBytes)) throw new Error(`unmanaged shell snippet at ${file}`);
      return { file, before, missing: current === null, mode: current?.mode ?? 0o644, block: blockBytes };
    });
    for (const receipt of receipts) {
      const current = inspectBytes(receipt.file), index = current.indexOf(receipt.block);
      if (priorShell && (index < 0 || current.indexOf(receipt.block, index + receipt.block.length) >= 0)) throw new Error(`managed shell snippet changed: ${receipt.file}`);
    }
    const changes = [];
    const change = (file, after) => {
      const before = inspect(file);
      if (!same(before, after)) changes.push({ file, before, after });
    };
    let runtime, entry;
    if (!values.remove) {
      const codex = native('codex', priorEntry), claude = native('claude', priorEntry);
      if (!codex && !claude) throw new Error('install native Codex and/or Claude and put it on PATH before installing Monitor');
      const args = [...(codex ? ['--codex', codex.binary] : []), ...(claude ? ['--claude', claude.binary] : [])];
      if (values.snapshot) runtime = snapshot(product, runtimeRoot, owner.token);
      entry = stageInstaller(runtime?.directory ?? product, args,
        [codex && !codex.explicit && 'codex', claude && !claude.explicit && 'claude'].filter(Boolean));
    }
    const cleanupNativeDirectories = planNativeHooks({ bin, runtime: values['hook-runtime'] ? path.resolve(values['hook-runtime']) : runtime?.directory ?? product,
      kinds: entry && exists(path.join(product, 'herdr/native-entry.mjs')) ? [entry.native && 'codex', entry.claudeNative && 'claude'].filter(Boolean) : [], inspect, change });
    for (const name of names) change(path.join(bin, name), entry?.files[name] === undefined ? null : { content: Buffer.from(entry.files[name]), mode: 0o755 });
    change(entryFile, entry ? { content: Buffer.from(JSON.stringify(entry, null, 2) + '\n'), mode: 0o600 } : null);
    for (const receipt of receipts) {
      const current = inspectBytes(receipt.file), index = current.indexOf(receipt.block);
      const content = values.remove ? Buffer.concat([current.subarray(0, index), current.subarray(index + receipt.block.length)]) : priorShell ? current : Buffer.concat([receipt.before, receipt.block]);
      change(receipt.file, values.remove && receipt.missing && content.length === 0 ? null : { content, mode: receipt.mode });
    }
    const storedHooks = receipts.map((receipt) => ({ ...receipt, before: receipt.before.toString('base64'), block: receipt.block.toString('base64') }));
    change(marker, values.remove ? null : { content: Buffer.from(JSON.stringify({ version: 2, bin, hooks: storedHooks }, null, 2) + '\n'), mode: 0o600 });
    for (const { file } of changes) writable(file);
    // Include unchanged destinations: an idempotent install/check must not
    // silently accept edits that arrived after ownership preflight either.
    for (const [file, before] of inspected) {
      if (!same(state(file), before)) throw new Error(`machine file changed during planning: ${file}`);
    }
    if (!values.check && (changes.length || runtime?.created)) transact(journal, bin, runtimeRoot, changes, runtime, owner);
    if (!values.check) cleanupNativeDirectories();
    console.log(`entry: ${values.check ? 'checked' : values.remove ? 'restored' : 'installed'} machine entry at ${bin}`);
    if (!values.check && !values.remove && entry?.native) console.log('entry: required Codex setup: open /hooks and review the Monitor user SessionStart hook in every profile used for workers or native/desktop entry. Use codex -p PROFILE for a named profile; plain codex uses its configured default profile. Trust in one profile does not cover another. Dispatch blocks at "Hooks need review" until you review in the affected worker/profile, then use dispatch --retry R-n. Hook trust stays under your control; installation never writes trust records.');
  });
} catch (error) { console.error(`entry: ${error.message}`); process.exitCode = 1; }
