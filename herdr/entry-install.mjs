#!/usr/bin/env node
// Machine installation boundary, independent of the selected release's flags.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { quote } from '../discovery/runtime.mjs';
import { state, same, writable, recover, transact } from './entry-transaction.mjs';
import { snapshot } from './entry-runtime.mjs';

const { values } = parseArgs({ options: { product: { type: 'string' }, remove: { type: 'boolean' }, check: { type: 'boolean' }, snapshot: { type: 'boolean' }, recover: { type: 'boolean' } } });
const product = path.resolve(values.product ?? fileURLToPath(new URL('../', import.meta.url)));
const monitorHome = process.env.HERDR_MONITOR_HOME ?? path.join(process.env.HOME, '.local/share/herdr-monitor');
const bin = path.resolve(process.env.HERDR_MONITOR_ENTRY_BIN ?? path.join(monitorHome, 'entry/bin'));
const marker = path.join(bin, '.monitor-shell.json');
const journal = path.join(bin, '.monitor-recovery.json');
const runtimeRoot = path.resolve(monitorHome, 'entry/runtimes');
const entryFile = path.join(bin, '.monitor-entry.json');
const names = ['codex', 'monitor-codex', 'claude', 'monitor-claude'];
const tag = '# >>> Herdr Monitor entry >>>';
const block = `\n${tag}\nexport PATH=${quote(bin)}:"$PATH"\n# <<< Herdr Monitor entry <<<\n`;
const exists = (file) => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
function plain(file) {
  if (exists(file) && !fs.lstatSync(file).isFile()) throw new Error(`refusing non-plain machine file: ${file}`);
}
function read(file) { plain(file); return exists(file) ? fs.readFileSync(file, 'utf8') : ''; }
function stageInstaller(runtime, args) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-entry-plan-'));
  try {
    // v0.1.4 has no --check. Run its actual installer against a disposable bin,
    // then validate and commit its output ourselves with a recovery receipt.
    const r = spawnSync(process.execPath, [path.join(product, 'discovery/install.mjs'), '--bin', temporary, ...args], { encoding: 'utf8', timeout: 15000 });
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
  if (kind === 'claude' && supplied === '-') {
    if (prior?.claudeNative) throw new Error('retain Claude when upgrading its managed installation');
    return undefined;
  }
  const candidates = supplied ? [supplied] : [prior?.[kind === 'codex' ? 'native' : 'claudeNative'],
    ...(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, kind))];
  for (const candidate of candidates.filter(Boolean)) {
    if (!path.isAbsolute(candidate)) throw new Error(`native ${kind} path must be absolute`);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (!fs.statSync(candidate).isFile()) continue;
    } catch (e) { if (supplied) throw e; continue; }
    const receipt = path.join(path.dirname(candidate), '.monitor-entry.json');
    if (exists(receipt)) {
      const original = JSON.parse(read(receipt))[kind === 'codex' ? 'native' : 'claudeNative'];
      if (!original || !path.isAbsolute(original) || path.dirname(original) === bin) throw new Error(`invalid native ${kind} receipt`);
      fs.accessSync(original, fs.constants.X_OK);
      return original;
    }
    return fs.realpathSync(candidate);
  }
  if (kind === 'codex') throw new Error('native Codex not found on PATH; install Codex before Monitor or set HERDR_MONITOR_CODEX');
}
function hooks() {
  const home = path.resolve(process.env.HOME);
  const zhome = path.resolve(process.env.ZDOTDIR || home);
  const login = ['.bash_profile', '.bash_login', '.profile'].find((name) => exists(path.join(home, name))) ?? '.bash_profile';
  return [...new Set([path.join(zhome, '.zshenv'), path.join(zhome, '.zshrc'), path.join(home, '.bashrc'), path.join(home, login)])];
}
try {
  if (values.check && exists(journal)) throw new Error('pending entry recovery; run entry-install.mjs --recover first');
  if (!values.check) recover(journal, bin, runtimeRoot);
  if (values.recover) { console.log(`entry: recovered machine entry at ${bin}`); process.exit(0); }
  const priorShell = exists(marker) ? JSON.parse(read(marker)) : null;
  if (priorShell && (priorShell.bin !== bin || !Array.isArray(priorShell.hooks))) throw new Error('invalid shell installation receipt');
  const allowedNames = ['.zshenv', '.zshrc', '.bashrc', '.bash_profile', '.bash_login', '.profile'];
  if (priorShell?.hooks.some((r) => typeof r.file !== 'string' || !path.isAbsolute(r.file) || !allowedNames.includes(path.basename(r.file)) ||
    typeof r.before !== 'string' || typeof r.missing !== 'boolean' || !Number.isInteger(r.mode) || r.mode < 0 || r.mode > 0o777 || r.block !== block) ||
    (priorShell && new Set(priorShell.hooks.map((r) => r.file)).size !== priorShell.hooks.length)) throw new Error('invalid shell file receipt');
  const priorEntry = exists(entryFile) ? JSON.parse(read(entryFile)) : null;
  if (priorEntry && (!priorEntry.files || Object.keys(priorEntry.files).some((name) => !names.includes(name)))) throw new Error('invalid managed entry receipt');
  for (const name of names) {
    const current = state(path.join(bin, name)), expected = priorEntry?.files[name];
    if (expected !== undefined && (typeof expected !== 'string' || current?.content !== expected || current.mode !== 0o755)) throw new Error(`managed file changed: ${path.join(bin, name)}`);
    if (expected === undefined && current) throw new Error(`refusing to replace unmanaged file ${path.join(bin, name)}`);
  }
  // Preflight all files before any writes. In-place replacement or removal of a
  // user-edited adapter/snippet requires resolving that edit, never overwriting it.
  const receipts = priorShell?.hooks ?? (values.remove ? [] : hooks()).map((file) => {
    const before = read(file);
    if (before.includes(tag)) throw new Error(`unmanaged shell snippet at ${file}`);
    return { file, before, missing: !exists(file), mode: exists(file) ? fs.statSync(file).mode & 0o777 : 0o644, block };
  });
  for (const receipt of receipts) {
    const current = read(receipt.file);
    if (priorShell && (current.split(receipt.block).length !== 2 || receipt.block !== block)) throw new Error(`managed shell snippet changed: ${receipt.file}`);
  }
  const changes = [];
  const change = (file, after) => {
    const before = state(file);
    if (!same(before, after)) changes.push({ file, before, after });
  };
  let runtime, entry;
  if (!values.remove) {
    const codex = native('codex', priorEntry), claude = native('claude', priorEntry);
    const args = ['--codex', codex, ...(claude ? ['--claude', claude] : [])];
    if (values.snapshot) runtime = snapshot(product, runtimeRoot);
    entry = stageInstaller(runtime?.directory ?? product, args);
  }
  for (const name of names) change(path.join(bin, name), entry?.files[name] === undefined ? null : { content: entry.files[name], mode: 0o755 });
  change(entryFile, entry ? { content: JSON.stringify(entry, null, 2) + '\n', mode: 0o600 } : null);
  for (const receipt of receipts) {
    const content = values.remove ? read(receipt.file).replace(receipt.block, '') : priorShell ? read(receipt.file) : receipt.before + receipt.block;
    change(receipt.file, values.remove && receipt.missing && content === '' ? null : { content, mode: receipt.mode });
  }
  change(marker, values.remove ? null : { content: JSON.stringify({ bin, hooks: receipts }, null, 2) + '\n', mode: 0o600 });
  for (const { file } of changes) writable(file);
  if (!values.check && (changes.length || runtime?.created)) transact(journal, bin, runtimeRoot, changes, runtime);
  console.log(`entry: ${values.check ? 'checked' : values.remove ? 'restored' : 'installed'} machine entry at ${bin}`);
} catch (error) { console.error(`entry: ${error.message}`); process.exitCode = 1; }
