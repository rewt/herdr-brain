#!/usr/bin/env node
// Machine installation boundary. Release builds call only the dependency step;
// activation and Herdr's plugin build install policy transport from a final tree.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { quote } from '../discovery/runtime.mjs';

const { values } = parseArgs({ options: { product: { type: 'string' }, remove: { type: 'boolean' }, check: { type: 'boolean' } } });
const product = path.resolve(values.product ?? fileURLToPath(new URL('../', import.meta.url)));
const monitorHome = process.env.HERDR_MONITOR_HOME ?? path.join(process.env.HOME, '.local/share/herdr-monitor');
const bin = path.resolve(process.env.HERDR_MONITOR_ENTRY_BIN ?? path.join(monitorHome, 'entry/bin'));
const marker = path.join(bin, '.monitor-shell.json');
const tag = '# >>> Herdr Monitor entry >>>';
const block = `\n${tag}\nexport PATH=${quote(bin)}:"$PATH"\n# <<< Herdr Monitor entry <<<\n`;
const exists = (file) => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
function plain(file) {
  if (exists(file) && !fs.lstatSync(file).isFile()) throw new Error(`refusing non-plain machine file: ${file}`);
}
function read(file) { plain(file); return exists(file) ? fs.readFileSync(file, 'utf8') : ''; }
function invoke(installer, args) {
  const r = spawnSync(process.execPath, [installer, '--bin', bin, ...args], { encoding: 'utf8', timeout: 15000 });
  if (r.error || r.status !== 0) throw new Error(r.error?.message ?? r.stderr.trim());
  if (!values.check) process.stdout.write(r.stdout);
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
  const priorShell = exists(marker) ? JSON.parse(read(marker)) : null;
  if (priorShell && (priorShell.bin !== bin || !Array.isArray(priorShell.hooks))) throw new Error('invalid shell installation receipt');
  const allowedNames = ['.zshenv', '.zshrc', '.bashrc', '.bash_profile', '.bash_login', '.profile'];
  if (priorShell?.hooks.some((r) => typeof r.file !== 'string' || !path.isAbsolute(r.file) || !allowedNames.includes(path.basename(r.file)) ||
    typeof r.before !== 'string' || typeof r.missing !== 'boolean' || !Number.isInteger(r.mode) || r.mode < 0 || r.mode > 0o777 || r.block !== block) ||
    (priorShell && new Set(priorShell.hooks.map((r) => r.file)).size !== priorShell.hooks.length)) throw new Error('invalid shell file receipt');
  const priorEntryFile = path.join(bin, '.monitor-entry.json');
  const priorEntry = exists(priorEntryFile) ? JSON.parse(read(priorEntryFile)) : null;
  const installer = path.join(values.remove && priorEntry ? priorEntry.product : product, 'discovery/install.mjs');
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
  if (values.remove) {
    if (priorEntry) invoke(installer, ['--remove', '--check']);
    if (!values.check) {
      if (priorEntry) invoke(installer, ['--remove']);
      for (const receipt of priorShell?.hooks ?? []) {
        const remaining = read(receipt.file).replace(receipt.block, '');
        if (receipt.missing && remaining === '') fs.unlinkSync(receipt.file);
        else fs.writeFileSync(receipt.file, remaining, { mode: receipt.mode });
      }
      if (priorShell) fs.unlinkSync(marker);
    }
  } else {
    const codex = native('codex', priorEntry), claude = native('claude', priorEntry);
    const args = ['--codex', codex, ...(claude ? ['--claude', claude] : [])];
    invoke(installer, [...args, '--check']);
    if (!values.check) {
      invoke(installer, args);
      for (const receipt of receipts) {
        fs.mkdirSync(path.dirname(receipt.file), { recursive: true });
        if (!priorShell) fs.writeFileSync(receipt.file, receipt.before + receipt.block, { mode: receipt.mode });
      }
      fs.writeFileSync(marker, JSON.stringify({ bin, hooks: receipts }, null, 2) + '\n', { mode: 0o600 });
    }
  }
  console.log(`entry: ${values.check ? 'checked' : values.remove ? 'restored' : 'installed'} machine entry at ${bin}`);
} catch (error) { console.error(`entry: ${error.message}`); process.exitCode = 1; }
