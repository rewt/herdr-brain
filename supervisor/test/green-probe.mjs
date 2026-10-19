// Shared read-only probe helpers; offline tests supply only private fixture trees.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { GREEN_CONTRACTS } from '../green-pass.mjs';
import { BOOTSTRAP_FILES, boundaryInput, manifestScope, componentShape, checkDeployment, checkConsumerEvidence } from '../green-manifest.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex');
export function git(repo, args, raw = false) {
  const result = spawnSync('git', ['--no-optional-locks', '-C', repo, ...args], { encoding: raw ? null : 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message); return result.stdout;
}
export function sourceTree(repo, ref = 'HEAD') {
  const head = git(repo, ['rev-parse', ref]).trim(), files = new Map(), cache = new Map();
  for (const row of git(repo, ['ls-tree', '-r', '-z', head]).split('\0').filter(Boolean)) {
    const match = /^(\d{6}) \w+ ([a-f0-9]+)\t(.+)$/.exec(row); assert.ok(match);
    files.set(match[3], { mode: match[1], oid: match[2] });
  }
  const bytes = file => {
    if (!cache.has(file)) { assert.ok(files.has(file), file); cache.set(file, git(repo, ['cat-file', 'blob', files.get(file).oid], true)); }
    return cache.get(file);
  };
  return { files, root: repo, head, bytes, read: file => bytes(file).toString('utf8') };
}
export function bootstrapTree(main, head, changed) {
  const files = new Map(main.files), overlay = new Set(changed);
  for (const file of changed) {
    if (head.files.has(file)) files.set(file, head.files.get(file)); else files.delete(file);
  }
  const bytes = file => (overlay.has(file) ? head : main).bytes(file);
  return { files, root: main.root, head: head.head, bytes, read: file => bytes(file).toString('utf8') };
}
export function probeSource(before) {
  const manifest = JSON.parse(before.read('supervisor/green-contracts.json'));
  const trusted = (file, _mode, raw) => raw ? before.bytes(file) : before.read(file);
  return { before, manifest, trusted };
}
export function canonicalSource(repo) {
  const query = args => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const top = query(['rev-parse', '--show-toplevel']), common = query(['rev-parse', '--git-common-dir']);
  if (top.status !== 0 || common.status !== 0 || top.stdout.trim() !== repo) return false;
  return fs.realpathSync(path.resolve(repo, common.stdout.trim())) === GREEN_CONTRACTS.bindings.brain.identity &&
    query(['rev-parse', '--verify', 'refs/heads/main']).status === 0;
}
export function deploymentSelection(manifest, check) {
  // Only manifestScope/checkDeployment run here: they hash declared inputs and never
  // discover or mutate the live record/fleet. Restore the isolated fixture
  // selection before any other product operation or asynchronous work.
  const saved = Object.fromEntries(Object.keys(manifest.environment.selection).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(manifest.environment.selection)) {
      if (value === null) delete process.env[key]; else process.env[key] = value;
    }
    return check();
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}
export function staleManifestReason(before, manifest, trusted) {
  const inventory = [...before.files.keys()].filter(boundaryInput).sort();
  if (JSON.stringify(inventory) !== JSON.stringify(Object.keys(manifest.boundary).sort())) return 'runtime/configuration inventory drift';
  for (const [file, pin] of Object.entries(manifest.boundary)) {
    if (before.files.get(file)?.mode !== pin.mode || hash(before.bytes(file)) !== pin.sha256) return `boundary version drift: ${file}`;
  }
  try {
    for (const component of manifest.components) {
      if (component.project !== 'brain') continue;
      if (before.files.get(component.path)?.mode !== '100644' ||
          componentShape(before.read(component.path), component.profile).sha256 !== component.shape_sha256)
        return `component drift: ${component.path}`;
      if (!Array.isArray(component.validation) || !component.validation.length ||
          component.validation.some(file => before.files.get(file)?.mode !== '100644')) return `component validation drift: ${component.path}`;
    }
    checkConsumerEvidence(before, manifest);
    deploymentSelection(manifest, () => checkDeployment(manifest, trusted));
  }
  catch (error) { return error.message; }
  return null;
}
export function assertCommittedAdmission(before, after, options) {
  const stale = staleManifestReason(before, options.manifest, options.trusted);
  const result = deploymentSelection(options.manifest, () => manifestScope(before, after, options));
  if (stale) {
    assert.equal(result.eligible, false, 'stale pins must refuse green admission');
    assert.ok(['GREEN_REACH_UNKNOWN', 'GREEN_NATIVE_ISOLATION'].includes(result.code), JSON.stringify(result));
  } else assert.equal(result.eligible, true, JSON.stringify(result));
  return { ...result, stale_manifest: stale };
}
export const withCurrentPins = (t, result, check) => result.stale_manifest ? t.skip(`stale committed manifest: ${result.stale_manifest}`) : check();
