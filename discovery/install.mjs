#!/usr/bin/env node
// Machine install, never project setup. An explicit destination is required so
// development/testing cannot silently change a harness's user configuration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../lib/cli-help.mjs';
import { quote } from './runtime.mjs';
import { selectSandbox } from './confinement.mjs';
const { values } = parseArgs({ options: { bin: { type: 'string' }, codex: { type: 'string' }, claude: { type: 'string' }, validator: { type: 'string' }, remove: { type: 'boolean' }, check: { type: 'boolean' } } });
const product = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/u, '');
function launcher(candidate, field, directory) {
  // Recognize wrappers through directory and executable symlinks as before,
  // but preserve symlinks that lead to a native harness's stable launcher.
  const target = fs.realpathSync(candidate);
  for (const parent of new Set([path.dirname(candidate), path.dirname(target)])) {
    const marker = path.join(parent, '.monitor-entry.json');
    if (fs.existsSync(marker)) {
      candidate = JSON.parse(fs.readFileSync(marker, 'utf8'))[field];
      break;
    }
  }
  if (!candidate || !path.isAbsolute(candidate)) throw new Error('invalid native executable receipt');
  const resolved = fs.realpathSync(candidate);
  if (path.dirname(candidate) === directory || path.dirname(resolved) === directory ||
      fs.existsSync(path.join(path.dirname(resolved), '.monitor-entry.json'))) throw new Error('recursive native executable receipt');
  fs.accessSync(candidate, fs.constants.X_OK);
  if (!fs.statSync(candidate).isFile()) throw new Error('native executable must be a file');
  return candidate;
}
try {
  if (!values.bin) throw new Error('usage: node discovery/install.mjs --bin MACHINE_BIN [--codex ABSOLUTE_NATIVE_CODEX] [--claude ABSOLUTE_NATIVE_CLAUDE] [--validator auto|ABSOLUTE_PROVIDER|experimental-bubblewrap:ABSOLUTE_BWRAP] [--remove]');
  const directory = path.resolve(values.bin), marker = path.join(directory, '.monitor-entry.json');
  const exists = (file) => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
  if (exists(marker) && !fs.lstatSync(marker).isFile()) throw new Error(`install receipt is not a plain file: ${marker}`);
  const prior = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
  // Receipts are machine-owned, but never let corrupted names escape the bin.
  if (prior && Object.keys(prior.files ?? {}).some((name) => !['codex', 'monitor-codex', 'claude', 'monitor-claude', 'monitor'].includes(name))) throw new Error('invalid managed entry receipt');
  if (values.remove) {
    if (!prior) throw new Error('no managed entry install at this destination');
    for (const [name, content] of Object.entries(prior.files)) {
      const file = path.join(directory, name);
      if (!fs.lstatSync(file).isFile() || (fs.statSync(file).mode & 0o777) !== 0o755 || fs.readFileSync(file, 'utf8') !== content) throw new Error(`managed file changed: ${file}`);
    }
    if (values.check) { console.log('entry removal checked'); process.exit(0); }
    for (const name of Object.keys(prior.files)) fs.unlinkSync(path.join(directory, name));
    fs.unlinkSync(marker);
    console.log(`removed Monitor entry adapters from ${directory}`);
  } else {
    if (values.validator && values.validator !== 'auto') selectSandbox(values.validator);
    if (!values.codex && !values.claude) throw new Error('select --codex and/or --claude by absolute path');
    if (values.codex && !path.isAbsolute(values.codex)) throw new Error('--codex must name the native executable by absolute path');
    if (!values.codex && prior?.native) throw new Error('retain --codex when updating a managed Codex install');
    // Preserve a stable launcher/symlink in the receipt; never pin its current release.
    const native = values.codex && launcher(values.codex, 'native', directory);
    // Derive the actual installed directory, including during transactional staging.
    const prefix = `#!/bin/sh\nentry_bin=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd) || exit 1\n`;
    const adapter = `${quote(process.execPath)} ${quote(`${product}/discovery/adapters/codex.mjs`)} --entry-bin "$entry_bin" --binary ${quote(native ?? 'codex')}${values.validator ? ` --validator ${quote(values.validator)}` : ''} --repo "$PWD"`;
    const common = `${prefix}# Herdr Monitor: automatic fresh interactive entry only\nexec ${adapter} --auto-entry -- "$@"\n`;
    const files = { ...(native ? { codex: common, 'monitor-codex': `${prefix}exec ${adapter} "$@"\n` } : {}),
      monitor: `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(`${product}/discovery/client.mjs`)} "$@"\n` };
    let claudeNative;
    if (values.claude) {
      if (!path.isAbsolute(values.claude)) throw new Error('--claude must name the native executable by absolute path');
      claudeNative = launcher(values.claude, 'claudeNative', directory);
      const claudeAdapter = `${quote(process.execPath)} ${quote(`${product}/discovery/adapters/claude.mjs`)} --entry-bin "$entry_bin" --binary ${quote(claudeNative)}${values.validator || !native ? ` --validator ${quote(values.validator ?? 'auto')}` : ` --codex-fallback ${quote(native)}`} --repo "$PWD"`;
      files.claude = `${prefix}exec ${claudeAdapter} --auto-entry -- "$@"\n`;
      files['monitor-claude'] = `${prefix}exec ${claudeAdapter} "$@"\n`;
    } else if (prior?.claudeNative) throw new Error('retain --claude when updating a managed Claude install');
    for (const [name] of Object.entries(files)) {
      const file = path.join(directory, name);
      if (exists(file) && (!fs.lstatSync(file).isFile() || (fs.statSync(file).mode & 0o777) !== 0o755 || !prior?.files?.[name] || fs.readFileSync(file, 'utf8') !== prior.files[name])) throw new Error(`refusing to replace unmanaged file ${file}`);
    }
    if (values.check) { console.log('entry installation checked'); process.exit(0); }
    fs.mkdirSync(directory, { recursive: true });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content, { mode: 0o755 });
    fs.writeFileSync(marker, JSON.stringify({ product, native, claudeNative, validator: values.validator ?? native ?? 'auto', files }, null, 2) + '\n', { mode: 0o600 });
    console.log(`installed entry adapters in ${directory}; put this machine directory before the native harness directories on PATH`);
  }
} catch (e) { console.error(`monitor install: ${e.message}`); process.exitCode = 1; }
