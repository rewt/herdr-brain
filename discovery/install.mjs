#!/usr/bin/env node
// Machine install, never project setup. An explicit destination is required so
// development/testing cannot silently change a harness's user configuration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { quote } from './runtime.mjs';
import { selectSandbox } from './confinement.mjs';
const { values } = parseArgs({ options: { bin: { type: 'string' }, codex: { type: 'string' }, claude: { type: 'string' }, validator: { type: 'string' }, remove: { type: 'boolean' }, check: { type: 'boolean' } } });
const product = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/u, '');
try {
  if (!values.bin) throw new Error('usage: node discovery/install.mjs --bin MACHINE_BIN [--codex ABSOLUTE_NATIVE_CODEX] [--claude ABSOLUTE_NATIVE_CLAUDE] [--validator auto|ABSOLUTE_PROVIDER|experimental-bubblewrap:ABSOLUTE_BWRAP] [--remove]');
  const directory = path.resolve(values.bin), marker = path.join(directory, '.monitor-entry.json');
  const exists = (file) => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
  if (exists(marker) && !fs.lstatSync(marker).isFile()) throw new Error(`install receipt is not a plain file: ${marker}`);
  const prior = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
  // Receipts are machine-owned, but never let corrupted names escape the bin.
  if (prior && Object.keys(prior.files ?? {}).some((name) => !['codex', 'monitor-codex', 'claude', 'monitor-claude'].includes(name))) throw new Error('invalid managed entry receipt');
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
    let native = values.codex ? fs.realpathSync(values.codex) : undefined;
    const otherMarker = path.join(path.dirname(native ?? directory), '.monitor-entry.json');
    if (native && fs.existsSync(otherMarker)) native = JSON.parse(fs.readFileSync(otherMarker, 'utf8')).native;
    if (values.codex) {
      if (!native || !path.isAbsolute(native) || path.dirname(native) === directory) throw new Error('invalid or recursive native Codex receipt');
      fs.accessSync(native, fs.constants.X_OK);
    }
    const adapter = `${quote(process.execPath)} ${quote(`${product}/discovery/adapters/codex.mjs`)} --binary ${quote(native ?? 'codex')}${values.validator ? ` --validator ${quote(values.validator)}` : ''} --repo "$PWD"`;
    const common = `#!/bin/sh\n# Herdr Monitor: automatic fresh interactive entry only\nexec ${adapter} --auto-entry -- "$@"\n`;
    const files = native ? { codex: common, 'monitor-codex': `#!/bin/sh\nexec ${adapter} "$@"\n` } : {};
    let claudeNative;
    if (values.claude) {
      if (!path.isAbsolute(values.claude)) throw new Error('--claude must name the native executable by absolute path');
      claudeNative = fs.realpathSync(values.claude);
      const claudeMarker = path.join(path.dirname(claudeNative), '.monitor-entry.json');
      if (fs.existsSync(claudeMarker)) claudeNative = JSON.parse(fs.readFileSync(claudeMarker, 'utf8')).claudeNative;
      if (!claudeNative) throw new Error('managed install has no native Claude receipt');
      if (path.dirname(claudeNative) === directory) throw new Error('recursive native Claude receipt');
      fs.accessSync(claudeNative, fs.constants.X_OK);
      const claudeAdapter = `${quote(process.execPath)} ${quote(`${product}/discovery/adapters/claude.mjs`)} --binary ${quote(claudeNative)} --validator ${quote(values.validator ?? native ?? 'auto')} --repo "$PWD"`;
      files.claude = `#!/bin/sh\nexec ${claudeAdapter} --auto-entry -- "$@"\n`;
      files['monitor-claude'] = `#!/bin/sh\nexec ${claudeAdapter} "$@"\n`;
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
