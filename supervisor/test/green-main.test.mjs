// Probe pins and trusted bytes always come from the same complete Git tree.
// No live record/config discovery, checkout writes or operator state are needed.
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { GREEN_CONTRACTS } from '../green-pass.mjs';
import { buildManifest, BOOTSTRAP_FILES, manifestScope } from '../green-manifest.mjs';

// Test containment is already imported; child launches remain contained.
delete process.env.NODE_OPTIONS;
const hash = value => createHash('sha256').update(value).digest('hex');
const SNAPSHOT = 'no Git work tree (release snapshot)';
const checkout = fs.realpathSync(new URL('../../', import.meta.url));
function git(repo, args, raw = false) {
  const result = spawnSync('git', ['--no-optional-locks', '-C', repo, ...args], { encoding: raw ? null : 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message); return result.stdout;
}
function sourceTree(repo) {
  const head = git(repo, ['rev-parse', 'HEAD']).trim(), files = new Map(), cache = new Map();
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
function probeSource(before) {
  // Binding is data for manifestScope; canonical identity is exercised by the
  // isolated full-admission fixtures, never by discovering the live record.
  const brain = GREEN_CONTRACTS.bindings.brain;
  const manifest = { ...buildManifest(before, { bindings: { brain } }), exclusions: GREEN_CONTRACTS.exclusions };
  const overlay = new Map([['supervisor/green-contracts.json', JSON.stringify(manifest)]]);
  const original = before;
  before = { ...original, read: file => overlay.has(file) ? overlay.get(file) : original.read(file),
    bytes: file => overlay.has(file) ? Buffer.from(overlay.get(file)) : original.bytes(file) };
  const trusted = (file, _mode, raw) => raw ? before.bytes(file) : before.read(file);
  return { before, manifest, trusted };
}
test('real main plus the complete HEAD overlay admits a renderer and refuses boundary controls', async t => {
  const hasTree = spawnSync('git', ['-C', checkout, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' }).stdout?.trim() === 'true';
  const hasMain = hasTree && spawnSync('git', ['-C', checkout, 'rev-parse', '--verify', 'refs/heads/main'], { encoding: 'utf8' }).status === 0;
  if (!hasMain) return t.skip(SNAPSHOT);
  const main = git(checkout, ['rev-parse', 'main']).trim(), tree = sourceTree(checkout);
  const { before, manifest, trusted } = probeSource(tree), files = before.files;
  const original = before.read('board/render.mjs');
  const oldLine = 'export function render(snapshot, { width = 120, height = Infinity, now = Date.now() } = {}) {';
  const newLine = oldLine.replace('120', '121'); assert.ok(original.includes(oldLine));
  const candidate = original.replace(oldLine, newLine), outcomes = [];
  for (const [label, file, contents, expected] of [
    ['renderer', 'board/render.mjs', candidate, null],
    ['bch-entry', 'supervisor/reconcile.mjs', before.read('supervisor/reconcile.mjs') + '// changed\n', 'GREEN_BCH_CONSUMED'],
    ['promotion-authority', 'test/helpers/run.mjs', before.read('test/helpers/run.mjs') + '// changed\n', 'GREEN_SELF_AUTHORITY'],
    ...['.lane.validation.json', '.promotion-selector.json'].map(file => ['check-selection', file, before.read(file) + '\n', 'GREEN_SELF_AUTHORITY']),
    ['manifest', 'supervisor/green-contracts.json', before.read('supervisor/green-contracts.json') + '\n', 'GREEN_SELF_AUTHORITY'],
    ['boundary', 'board/rows.mjs', before.read('board/rows.mjs') + '// changed\n', 'GREEN_BOUNDARY_CHANGED'],
    ['new-edge', 'board/render.mjs', candidate + 'import(process.env.TARGET);\n', 'GREEN_REACH_UNKNOWN'],
  ]) {
    const after = { ...before, read: name => name === file ? contents : before.read(name), bytes: name => name === file ? Buffer.from(contents) : before.bytes(name) };
    const result = manifestScope(before, after, { manifest, trusted, changes: [{ file, status: 'M', before: '100644', after: '100644' }] });
    assert.equal(result.eligible, expected === null, JSON.stringify(result)); if (expected) assert.equal(result.code, expected);
    outcomes.push({ label, file, eligible: result.eligible, code: result.code ?? null, reason: result.reason ?? null,
      before_sha256: hash(before.read(file)), after_sha256: hash(contents) });
  }
  // A missing base boundary cannot disappear just because it is unchanged by
  // the candidate diff.
  const missingFiles = new Map(files); missingFiles.delete('board/rows.mjs');
  const result = manifestScope({ ...before, files: missingFiles }, before, { manifest, trusted, changes: [{ file: 'board/render.mjs', status: 'M', before: '100644', after: '100644' }] });
  assert.equal(result.eligible, false); outcomes.push({ label: 'missing-boundary', eligible: false, code: result.code });
  // Focused validation executes these exact candidate bytes only here in a
  // private offline test directory, never in the admission implementation.
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'green-main-renderer-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  fs.writeFileSync(path.join(scratch, 'render.mjs'), candidate); fs.writeFileSync(path.join(scratch, 'rows.mjs'), before.read('board/rows.mjs'));
  const { render } = await import(pathToFileURL(path.join(scratch, 'render.mjs')).href);
  const snapshot = { memory: 0, herdr: 'x'.repeat(150), slot: { state: 'idle', heldSeconds: 0, queueLength: 0 }, rows: [] };
  assert.equal(render(snapshot).split('\n')[0].length, 121); assert.equal(render(snapshot, { width: 80 }).split('\n')[0].length, 80);
  assert.equal(render(snapshot, { height: 1 }).split('\n').length, 1);
  const evidence = { schema: 'green-main-probe/v2', main, stage: 'containment after required ordinary bootstrap overlay; independent review still pending',
    head: tree.head, bootstrap_overlay: git(checkout, ['diff', '--name-status', main, tree.head]).trim(),
    manifest_sha256: hash(JSON.stringify(manifest)), boundary_inputs: Object.keys(manifest.boundary).length,
    candidate: { file: 'board/render.mjs', old_line: oldLine, new_line: newLine, before_sha256: hash(original), after_sha256: hash(candidate) },
    validation: { exact_candidate_bytes: true, default_width: 121, explicit_width: 80, height: 1 }, outcomes,
    independent_review: 'not performed by this engineer; ordinary bootstrap and ready review required before activation/promotion' };
  t.diagnostic(`GREEN_MAIN_PROBE ${JSON.stringify(evidence)}`);
});

for (const operation of ['changed', 'deleted']) test(`complete probe tree handles an unrelated pinned checkout file ${operation}`, t => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'green-probe-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  for (const file of BOOTSTRAP_FILES.concat('board/render.mjs', 'board/rows.mjs', 'test/board-view.test.mjs', 'lib/unrelated.mjs')) {
    fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
    fs.writeFileSync(path.join(scratch, file), file.startsWith('board/') ? fs.readFileSync(path.join(checkout, file)) : '// base\n');
  }
  git(scratch, ['init', '-qb', 'main']); git(scratch, ['config', 'user.name', 'Fixture']); git(scratch, ['config', 'user.email', 'fixture@example.invalid']);
  git(scratch, ['add', '.']); git(scratch, ['commit', '-qm', 'Base']);
  if (operation === 'changed') fs.writeFileSync(path.join(scratch, 'lib/unrelated.mjs'), '// unrelated promotion change\n');
  else fs.unlinkSync(path.join(scratch, 'lib/unrelated.mjs'));
  git(scratch, ['add', '-A']); git(scratch, ['commit', '-qm', 'Unrelated promotion']);
  const { before, manifest, trusted } = probeSource(sourceTree(scratch));
  const candidate = before.read('board/render.mjs').replace('width = 120,', 'width = 121,');
  const after = { ...before, read: file => file === 'board/render.mjs' ? candidate : before.read(file),
    bytes: file => file === 'board/render.mjs' ? Buffer.from(candidate) : before.bytes(file) };
  const result = manifestScope(before, after, { manifest, trusted, changes: [{ file: 'board/render.mjs', before: '100644', after: '100644', status: 'M' }] });
  assert.equal(result.eligible, true, JSON.stringify(result));
});
