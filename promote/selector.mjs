// Observations only. No selector output enters a command or a gate decision.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withCanonicalSnapshot } from '../settle/test-plan.mjs';

export const SELECTOR_FILE = '.promotion-selector.json';
export const relativePath = file => typeof file === 'string' && file.length > 0 &&
  !path.isAbsolute(file) && !/[\\\x00-\x1f\x7f]/u.test(file) &&
  file.split('/').every(part => part && part !== '.' && part !== '..');
const testFile = file => relativePath(file) && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
const full = reason => ({ pick: 'full', reason });
function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw Error(r.stderr || r.error?.message || 'selector Git read failed');
  return r.stdout;
}
export function candidateChanges(cwd, base, head) {
  const fields = git(cwd, ['diff', '--name-status', '-z', '--no-renames', `${base}...${head}`]).split('\0');
  fields.pop();
  const changed = [];
  for (let i = 0; i < fields.length; i += 2) {
    if (!/^[AMDTUXB]$/.test(fields[i]) || !relativePath(fields[i + 1])) throw Error('unknown selector change status/path');
    changed.push({ path: fields[i + 1], status: fields[i] });
  }
  return changed.sort((a, b) => a.path.localeCompare(b.path));
}
export function validateSelection(value) {
  if (!value || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 4096 ||
      !(value.pick === 'full' || Array.isArray(value.pick) && value.pick.length <= 10000 &&
        value.pick.every(testFile) && new Set(value.pick).size === value.pick.length) ||
      Object.keys(value).some(key => !['pick', 'reason'].includes(key))) throw Error('invalid selector response');
  return { pick: value.pick === 'full' ? 'full' : [...value.pick].sort(), reason: value.reason };
}
export function shadowSelection({ repo, base, head, cwd, env = process.env }) {
  const observation = { schema: 'promotion-selector-shadow/v1', base, head, miss: null };
  try {
    // Opt in only from the captured canonical base, independent of lane config.
    if (!git(repo, ['ls-tree', base, '--', SELECTOR_FILE]).trim()) return null;
    return withCanonicalSnapshot({ repo, base }, root => {
      const config = JSON.parse(fs.readFileSync(path.join(root, SELECTOR_FILE), 'utf8'));
      if (config.schema !== 'promotion-selector/v1' || !relativePath(config.adapter) ||
          Object.keys(config).some(key => !['schema', 'adapter'].includes(key))) throw Error('invalid selector declaration');
      observation.adapter = config.adapter;
      const changed = candidateChanges(cwd, base, head);
      observation.changed = changed;
      if (changed.some(row => !['A', 'M'].includes(row.status))) return { ...observation, ...full('deleted, renamed or non-regular change') };
      const adapter = path.join(root, config.adapter);
      if (!fs.statSync(adapter).isFile()) throw Error('selector adapter must be a regular file');
      const request = { schema: 'promotion-selector/v1', root: cwd, base, head, changed };
      const result = spawnSync(process.execPath, [adapter, '--select'], { cwd: root, env,
        input: JSON.stringify(request), encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
      if (result.error || result.status !== 0) throw Error(result.error?.message || `selector adapter exited ${result.status}`);
      return { ...observation, ...validateSelection(JSON.parse(result.stdout)) };
    });
  } catch (error) {
    return { ...observation, ...full('selector unavailable; conservative full fallback'), error: error.message };
  }
}

// TAP failures carry locations; file-level crashes, Vitest and runner timeouts
// carry file names directly. Unknown failure blocks conservatively count as misses.
export function failingTestFiles(output, roots = []) {
  const files = new Set();
  let pending = false, attributed = false, unattributed = false;
  const close = () => { if (pending && !attributed) unattributed = true; };
  for (const raw of output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n')) {
    const line = raw.replaceAll('file://', '');
    const failure = /^\s*not ok\b|^\s*(?:FAIL|❯|×)\s|testTimeoutFailure:/.test(line);
    if (failure) { close(); pending = true; attributed = false; }
    else if (/^\s*(?:ok\b|# Subtest:)/.test(line)) { close(); pending = false; }
    if (!failure && !(pending && (/^\s*(?:location:|file:|at\s)/.test(line) || raw.includes('file://')))) continue;
    for (const match of line.matchAll(/(?:[^\s'"():]+\/)*[^\s'"():]+\.(?:test|spec)\.[cm]?[jt]sx?/g)) {
      let file = match[0];
      for (const root of roots.filter(Boolean)) if (file.startsWith(root + '/')) { file = file.slice(root.length + 1); break; }
      file = file.replace(/^\.\//, '');
      if (testFile(file)) { files.add(file); attributed = true; }
    }
  }
  close();
  return { failing_files: [...files].sort(), unattributed };
}
export function completeShadow(selection, gate, roots = []) {
  if (!selection) return null;
  try {
    const failures = failingTestFiles(fs.readFileSync(gate.log, 'utf8'), roots);
    const outside = selection.pick === 'full' ? [] : failures.failing_files.filter(file => !selection.pick.includes(file));
    const unknown = failures.unattributed || gate.exit_code !== 0 && failures.failing_files.length === 0;
    return { ...selection, ...failures, unattributed: unknown, outside_pick: outside,
      miss: selection.pick !== 'full' && (outside.length > 0 || unknown) };
  } catch {
    return { ...selection, miss: selection.pick !== 'full', unattributed: true, outside_pick: [],
      failing_files: [], comparison_error: 'gate log unavailable' };
  }
}
