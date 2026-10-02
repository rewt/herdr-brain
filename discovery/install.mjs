#!/usr/bin/env node
// Machine install, never project setup. An explicit destination is required so
// development/testing cannot silently change a harness's user configuration.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { quote } from './runtime.mjs';
const { values } = parseArgs({ options: { bin: { type: 'string' }, codex: { type: 'string' }, claude: { type: 'string' }, remove: { type: 'boolean' } } });
const product = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/u, '');
try {
  if (!values.bin) throw new Error('usage: node discovery/install.mjs --bin MACHINE_BIN --codex ABSOLUTE_NATIVE_CODEX [--remove]');
  const directory = path.resolve(values.bin), marker = path.join(directory, '.monitor-entry.json');
  const prior = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
  if (values.remove) {
    if (!prior) throw new Error('no managed entry install at this destination');
    for (const [name, content] of Object.entries(prior.files)) {
      const file = path.join(directory, name);
      if (!fs.lstatSync(file).isFile() || fs.readFileSync(file, 'utf8') !== content) throw new Error(`managed file changed: ${file}`);
    }
    for (const name of Object.keys(prior.files)) fs.unlinkSync(path.join(directory, name));
    fs.unlinkSync(marker);
    console.log(`removed Monitor entry adapters from ${directory}`);
  } else {
    if (!values.codex || !path.isAbsolute(values.codex)) throw new Error('--codex must name the native executable by absolute path');
    let native = fs.realpathSync(values.codex);
    const otherMarker = path.join(path.dirname(native), '.monitor-entry.json');
    if (fs.existsSync(otherMarker)) native = JSON.parse(fs.readFileSync(otherMarker, 'utf8')).native;
    const adapter = `${quote(process.execPath)} ${quote(`${product}/discovery/adapters/codex.mjs`)} --binary ${quote(native)} --repo "$PWD"`;
    const common = `#!/bin/sh\n# Herdr Monitor: automatic fresh interactive entry only\nexec ${adapter} --auto-entry -- "$@"\n`;
    const files = { codex: common, 'monitor-codex': `#!/bin/sh\nexec ${adapter} "$@"\n` };
    let claudeNative;
    if (values.claude) {
      if (!path.isAbsolute(values.claude)) throw new Error('--claude must name the native executable by absolute path');
      claudeNative = fs.realpathSync(values.claude);
      const claudeMarker = path.join(path.dirname(claudeNative), '.monitor-entry.json');
      if (fs.existsSync(claudeMarker)) claudeNative = JSON.parse(fs.readFileSync(claudeMarker, 'utf8')).claudeNative;
      if (!claudeNative) throw new Error('managed install has no native Claude receipt');
      const claudeAdapter = `${quote(process.execPath)} ${quote(`${product}/discovery/adapters/claude.mjs`)} --binary ${quote(claudeNative)} --validator ${quote(native)} --repo "$PWD"`;
      files.claude = `#!/bin/sh\nexec ${claudeAdapter} --auto-entry -- "$@"\n`;
      files['monitor-claude'] = `#!/bin/sh\nexec ${claudeAdapter} "$@"\n`;
    } else if (prior?.claudeNative) throw new Error('retain --claude when updating a managed Claude install');
    fs.mkdirSync(directory, { recursive: true });
    for (const [name] of Object.entries(files)) {
      const file = path.join(directory, name);
      if (fs.existsSync(file) && (!prior?.files?.[name] || fs.readFileSync(file, 'utf8') !== prior.files[name])) throw new Error(`refusing to replace unmanaged file ${file}`);
    }
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), content, { mode: 0o755 });
    fs.writeFileSync(marker, JSON.stringify({ product, native, claudeNative, files }, null, 2) + '\n', { mode: 0o600 });
    console.log(`installed entry adapters in ${directory}; put this machine directory before the native Codex directory on PATH`);
  }
} catch (e) { console.error(`monitor install: ${e.message}`); process.exitCode = 1; }
