#!/usr/bin/env node
// Offline NEW-writer -> OLD-reader evidence. Never resolves current or a project pin.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/cli-help.mjs';

const worker = fileURLToPath(new URL('./compat-probes.mjs', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function scratchEnvironment(root) {
  // Allowlist, rather than inherit project selectors, native identities, model
  // hooks, Node preloads, Git worktrees or any of the live host lock overrides.
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'SystemRoot'].flatMap(k => process.env[k] ? [[k, process.env[k]]] : []));
  return { ...env, TMPDIR: root, HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'), XDG_CACHE_HOME: path.join(root, 'cache'),
    PATH: `${path.join(root, 'bin')}${path.delimiter}${env.PATH ?? ''}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Compatibility fixture', GIT_AUTHOR_EMAIL: 'compat@example.invalid',
    GIT_COMMITTER_NAME: 'Compatibility fixture', GIT_COMMITTER_EMAIL: 'compat@example.invalid',
    HERDR_MONITOR_HOME: path.join(root, 'installation'), HERDR_MONITOR_FLEET: path.join(root, 'fleet'),
    HERDR_SOCKET_PATH: path.join(root, 'absent.sock'), HERDR_RETIRE_HERDR: 'herdr',
    BRAIN_SHADOW_ROOT: path.join(root, 'shadow'), ORG_ACTOR: 'compat-fixture',
    MONITOR_TEST_SLOT_PATH: path.join(root, 'slot.lock'), MONITOR_TEST_SLOT_COMPAT_PATH: path.join(root, 'slot.lock'),
    MONITOR_GATE_HISTORY_ROOT: path.join(root, 'gate-history') };
}

function identity(root) {
  const marker = path.join(root, '.release-commit');
  const git = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10000 });
  return { root, commit: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : git.status === 0 ? git.stdout.trim() : null };
}

export function checkCompatibility(oldBundle, newRoot) {
  oldBundle = fs.realpathSync(oldBundle); newRoot = fs.realpathSync(newRoot);
  const list = fs.readFileSync(path.join(newRoot, 'docs/contracts/formats.json'));
  const catalog = JSON.parse(list);
  if (catalog.schema !== 'brain-formats/v1' || !Array.isArray(catalog.formats)) throw Error('invalid NEW format inventory');
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'brain-compat-')));
  const env = scratchEnvironment(scratch);
  for (const dir of [env.HOME, env.XDG_CONFIG_HOME, path.join(scratch, 'bin')]) fs.mkdirSync(dir, { recursive: true });
  // No native CLI can escape into the operator's installation. Inventory is an
  // empty physical seam; dispatch accepts only the fixture supervisor lookup.
  fs.writeFileSync(path.join(scratch, 'bin/herdr'), `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[0]==='agent'&&a[1]==='get') console.log(JSON.stringify({result:{agent:{name:a[2]}}}));\nelse if(a[1]==='list') console.log(JSON.stringify({result:{workspaces:[],tabs:[],panes:[],agents:[]}}));\nelse { console.error('compat fixture refuses native effects: '+a.join(' ')); process.exitCode=1; }\n`, { mode: 0o755 });
  const execute = (phase, root, probe, directory) => {
    const result = spawnSync(process.execPath, [worker, phase, root, probe, directory],
      { cwd: directory, env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    return { exit: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '',
      ...(result.error ? { error: result.error.message } : {}) };
  };
  try {
    const formats = catalog.formats.map((format, index) => {
      const row = { id: format.id, version: format.version, rule: format.rule };
      if (!format.probe) return { ...row, status: 'not-covered', reason: format.notCovered ?? 'no writer/reader probe registered' };
      const directory = path.join(scratch, `brain-transport-${index}`); fs.mkdirSync(directory, { mode: 0o700 });
      const writer = execute('write', newRoot, format.probe, directory);
      if (writer.exit !== 0) return { ...row, status: 'fail', stage: 'NEW writer', writer };
      let metadata, artifacts;
      try {
        metadata = JSON.parse(fs.readFileSync(path.join(directory, 'fixture.json'), 'utf8'));
        artifacts = metadata.files.map(file => {
          const absolute = fs.realpathSync(file);
          if (!absolute.startsWith(scratch + path.sep)) throw Error('writer artifact escaped scratch');
          return { path: path.relative(directory, absolute), sha256: digest(fs.readFileSync(absolute)) };
        });
        if (!artifacts.length) throw Error(`no writer evidence for ${format.id}`);
      } catch (error) { return { ...row, status: 'fail', stage: 'NEW writer evidence', writer, stderr: error.message }; }
      const reader = execute('read', oldBundle, format.probe, directory);
      return { ...row, status: reader.exit === 77 ? 'not-covered' : reader.exit === 0 ? 'pass' : 'fail',
        ...(reader.exit === 77 ? { reason: reader.stderr.trim() } : {}),
        scope: metadata.scope, artifacts, writer, reader };
    });
    const failed = formats.filter(f => f.status === 'fail').map(f => f.id);
    const notCovered = formats.filter(f => f.status === 'not-covered').map(f => f.id);
    return { schema: 'brain-compat/v1', generatedAt: new Date().toISOString(), old: identity(oldBundle), new: identity(newRoot),
      inventory_sha256: digest(list), node: process.version,
      counts: { pass: formats.filter(f => f.status === 'pass').length, fail: failed.length, 'not-covered': notCovered.length },
      message: failed.length ? `rollback to OLD needs KEEP/forward recovery for: ${failed.join(', ')}`
        : 'No failures in covered old readers; not-covered formats still need switch-specific evidence.',
      limitations: 'Representative offline state only; pass does not authorize a switch, migration, completed-gate replay or job handoff.', formats };
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

export function main(args = process.argv.slice(2)) {
  const positional = [], options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') options.json = true;
    else if (args[i] === '--out' && args[i + 1]) options.out = args[++i];
    else if (args[i].startsWith('--')) throw Error(`unknown or incomplete option: ${args[i]}`);
    else positional.push(args[i]);
  }
  if (positional.length !== 2) throw Error('Usage: node herdr/compat.mjs OLD_BUNDLE NEW_ROOT [--json] [--out FILE]');
  if (options.out) {
    const target = path.resolve(options.out), old = fs.realpathSync(positional[0]);
    // Resolve parents too: an --out symlink must not modify an immutable bundle.
    let parent = path.dirname(target), suffix = [];
    while (!fs.existsSync(parent)) { suffix.unshift(path.basename(parent)); parent = path.dirname(parent); }
    const resolved = path.join(fs.realpathSync(parent), ...suffix, path.basename(target));
    if (resolved === old || resolved.startsWith(old + path.sep) || fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw Error('--out must not write into OLD or through a symlink');
  }
  const result = checkCompatibility(...positional), json = JSON.stringify(result, null, 2) + '\n';
  if (options.out) { fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true }); fs.writeFileSync(options.out, json); }
  process.stdout.write(options.json ? json : result.formats.map(f => `${f.status}\t${f.id}${f.reason ? `: ${f.reason}` : ''}`).join('\n') + `\n${result.message}\n`);
  process.exitCode = result.counts.fail ? 1 : 0;
}

if (isMain(import.meta.url)) {
  try { main(); } catch (error) { console.error(`compat: ${error.message}`); process.exitCode = 1; }
}
