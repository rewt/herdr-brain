// Read real main blobs and apply the explicit ordinary-bootstrap delta. Stale
// committed pins refuse green admission without blocking ordinary development.
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { GREEN_CONTRACTS } from '../green-pass.mjs';
import { buildManifest, BOOTSTRAP_FILES, BCH_ENTRIES, boundaryInput, manifestScope, componentShape, checkDeployment } from '../green-manifest.mjs';

// Test containment is already imported; child launches remain contained.
delete process.env.NODE_OPTIONS;
const hash = value => createHash('sha256').update(value).digest('hex');
const SNAPSHOT = 'outside canonical Brain Git checkout (release snapshot or foreign repository)';
const checkout = fs.realpathSync(new URL('../../', import.meta.url));
function git(repo, args, raw = false) {
  const result = spawnSync('git', ['--no-optional-locks', '-C', repo, ...args], { encoding: raw ? null : 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message); return result.stdout;
}
function sourceTree(repo, ref = 'HEAD') {
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
function bootstrapTree(main, head, changed) {
  const files = new Map(main.files), overlay = new Set(changed);
  for (const file of changed) {
    if (head.files.has(file)) files.set(file, head.files.get(file)); else files.delete(file);
  }
  const bytes = file => (overlay.has(file) ? head : main).bytes(file);
  return { files, root: main.root, head: head.head, bytes, read: file => bytes(file).toString('utf8') };
}
function probeSource(before) {
  const manifest = JSON.parse(before.read('supervisor/green-contracts.json'));
  const trusted = (file, _mode, raw) => raw ? before.bytes(file) : before.read(file);
  return { before, manifest, trusted };
}
function canonicalSource(repo) {
  const query = args => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const top = query(['rev-parse', '--show-toplevel']), common = query(['rev-parse', '--git-common-dir']);
  if (top.status !== 0 || common.status !== 0 || top.stdout.trim() !== repo) return false;
  return fs.realpathSync(path.resolve(repo, common.stdout.trim())) === GREEN_CONTRACTS.bindings.brain.identity &&
    query(['rev-parse', '--verify', 'refs/heads/main']).status === 0;
}
function deploymentSelection(manifest, check) {
  // Only manifestScope/checkDeployment run here: they hash declared inputs and never
  // discovers or mutates the live record/fleet. Restore the isolated fixture
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
function staleManifestReason(before, manifest, trusted) {
  const inventory = [...before.files.keys()].filter(boundaryInput).sort();
  if (JSON.stringify(inventory) !== JSON.stringify(Object.keys(manifest.boundary).sort())) return 'runtime/configuration inventory drift';
  for (const [file, pin] of Object.entries(manifest.boundary)) {
    if (before.files.get(file)?.mode !== pin.mode || hash(before.bytes(file)) !== pin.sha256) return `boundary version drift: ${file}`;
  }
  try { deploymentSelection(manifest, () => checkDeployment(manifest, trusted)); }
  catch (error) { return error.message; }
  return null;
}
function assertCommittedAdmission(before, after, options) {
  const stale = staleManifestReason(before, options.manifest, options.trusted);
  const result = deploymentSelection(options.manifest, () => manifestScope(before, after, options));
  if (stale) {
    assert.equal(result.eligible, false, 'stale pins must refuse green admission');
    assert.equal(result.code, 'GREEN_REACH_UNKNOWN');
  } else assert.equal(result.eligible, true, JSON.stringify(result));
  return { ...result, stale_manifest: stale };
}
const withCurrentPins = (t, result, check) => result.stale_manifest ? t.skip(`stale committed manifest: ${result.stale_manifest}`) : check();
test('real-main committed pins admit while current and boundary controls always refuse', async t => {
  if (!canonicalSource(checkout)) return t.skip(SNAPSHOT);
  const mainTree = sourceTree(checkout, 'main'), headTree = sourceTree(checkout);
  git(checkout, ['merge-base', '--is-ancestor', mainTree.head, headTree.head]);
  const changed = git(checkout, ['diff', '--name-only', '--no-renames', '-z', mainTree.head, headTree.head]).split('\0').filter(Boolean);
  const tree = bootstrapTree(mainTree, headTree, changed);
  const mainInputs = [...mainTree.files.keys()].filter(boundaryInput).sort().map(file => [file, mainTree.files.get(file).mode, hash(mainTree.bytes(file))]);
  const { before, manifest, trusted } = probeSource(tree), files = before.files;
  assert.equal(before.read('supervisor/green-contracts.json'), fs.readFileSync(new URL('../green-contracts.json', import.meta.url), 'utf8'), 'probe must use the committed manifest bytes');
  assert.deepEqual(manifest.externalConsumers.map(c => c.entry), BCH_ENTRIES);
  assert.ok(manifest.externalInputs.length > 0);
  for (const binding of [manifest.consumerEvidenceBinding.confirmation, manifest.consumerEvidenceBinding.inventory])
    assert.equal(hash(before.bytes(binding.path)), binding.sha256, binding.path);
  for (const file of ['lanes/routes.mjs', 'lanes/lane.mjs']) if (manifest.boundary[file]) assert.equal(manifest.boundary[file].role, 'promotion-authority', file);
  const original = before.read('board/render.mjs');
  const oldWidth = componentShape(original, 'board-default-width/v1').width, newWidth = oldWidth === 240 ? 239 : oldWidth + 1;
  const oldLine = `export function render(snapshot, { width = ${oldWidth}, height = Infinity, now = Date.now() } = {}) {`;
  const newLine = oldLine.replace(`width = ${oldWidth},`, `width = ${newWidth},`); assert.ok(original.includes(oldLine));
  const candidate = original.replace(oldLine, newLine), outcomes = [];
  const after = { ...before, read: file => file === 'board/render.mjs' ? candidate : before.read(file),
    bytes: file => file === 'board/render.mjs' ? Buffer.from(candidate) : before.bytes(file) };
  const admission = assertCommittedAdmission(before, after, { manifest, trusted,
    changes: [{ file: 'board/render.mjs', status: 'M', before: '100644', after: '100644' }] });
  outcomes.push({ label: 'renderer', file: 'board/render.mjs', eligible: admission.eligible, code: admission.code ?? null,
    reason: admission.reason ?? null, stale_manifest: admission.stale_manifest, before_sha256: hash(original), after_sha256: hash(candidate) });
  const content = file => before.files.has(file) ? before.read(file) : '';
  for (const [label, file, contents, expected] of [
    ['bch-entry', 'supervisor/reconcile.mjs', content('supervisor/reconcile.mjs') + '// changed\n', manifest.boundary['supervisor/reconcile.mjs']?.role === 'promotion-authority' ? 'GREEN_SELF_AUTHORITY' : 'GREEN_BCH_CONSUMED'],
    ['promotion-authority', 'test/helpers/run.mjs', content('test/helpers/run.mjs') + '// changed\n', 'GREEN_SELF_AUTHORITY'],
    ...['.lane.validation.json', '.promotion-selector.json'].map(file => ['check-selection', file, content(file) + '\n', 'GREEN_SELF_AUTHORITY']),
    ['manifest', 'supervisor/green-contracts.json', before.read('supervisor/green-contracts.json') + '\n', 'GREEN_SELF_AUTHORITY'],
    ['boundary', 'board/facts.mjs', content('board/facts.mjs') + '// changed\n', 'GREEN_BOUNDARY_CHANGED'],
    ['new-edge', 'board/render.mjs', candidate + 'import(process.env.TARGET);\n', 'GREEN_REACH_UNKNOWN'],
  ]) {
    const after = { ...before, read: name => name === file ? contents : before.read(name), bytes: name => name === file ? Buffer.from(contents) : before.bytes(name) };
    const mode = before.files.get(file)?.mode ?? '000000';
    const result = deploymentSelection(manifest, () => manifestScope(before, after, { manifest, trusted, changes: [{ file, status: mode === '000000' ? 'A' : 'M', before: mode, after: '100644' }] }));
    assert.equal(result.eligible, false, JSON.stringify(result)); assert.equal(result.code, expected);
    outcomes.push({ label, file, eligible: result.eligible, code: result.code ?? null, reason: result.reason ?? null,
      before_sha256: before.files.has(file) ? hash(before.bytes(file)) : null, after_sha256: hash(contents) });
  }
  // A missing base boundary cannot disappear just because it is unchanged by
  // the candidate diff.
  const missingFiles = new Map(files); missingFiles.delete('board/rows.mjs');
  const result = manifestScope({ ...before, files: missingFiles }, before, { manifest, trusted, changes: [{ file: 'board/render.mjs', status: 'M', before: '100644', after: '100644' }] });
  assert.equal(result.eligible, false); outcomes.push({ label: 'missing-boundary', eligible: false, code: result.code });
  const foreign = manifestScope(before, before, { manifest, trusted, project: 'foreign', changes: [] });
  assert.equal(foreign.eligible, false); outcomes.push({ label: 'foreign-project', eligible: false, code: foreign.code });
  let validation = { executed: false, reason: admission.stale_manifest };
  await t.test('renderer admission with current committed pins', sub => withCurrentPins(sub, admission, async () => {
    // Execute these exact candidate bytes only in a private offline directory,
    // once their runtime boundary is current, never in admission itself.
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'green-main-renderer-')));
    sub.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    fs.writeFileSync(path.join(scratch, 'render.mjs'), candidate); fs.writeFileSync(path.join(scratch, 'rows.mjs'), before.read('board/rows.mjs'));
    const { render } = await import(pathToFileURL(path.join(scratch, 'render.mjs')).href);
    const snapshot = { memory: 0, herdr: 'x'.repeat(150), slot: { state: 'idle', heldSeconds: 0, queueLength: 0 }, rows: [] };
    assert.equal(render(snapshot).split('\n')[0].length, newWidth); assert.equal(render(snapshot, { width: 80 }).split('\n')[0].length, 80);
    assert.equal(render(snapshot, { height: 1 }).split('\n').length, 1);
    validation = { executed: true, exact_candidate_bytes: true, default_width: newWidth, explicit_width: 80, height: 1 };
  }));
  const evidence = { schema: 'green-main-probe/v4', main: mainTree.head, stage: 'committed manifest probe after explicit ordinary bootstrap; stale admission skips, independent review still pending',
    head: tree.head, bootstrap_overlay: git(checkout, ['diff', '--name-status', mainTree.head, tree.head]).trim(),
    main_boundary_inputs: mainInputs.length, main_boundary_sha256: hash(JSON.stringify(mainInputs)),
    boundary_inherited_from_main: Object.keys(manifest.boundary).filter(file => !changed.includes(file)).length,
    manifest_sha256: hash(before.bytes('supervisor/green-contracts.json')), boundary_inputs: Object.keys(manifest.boundary).length,
    external_consumers: manifest.externalConsumers, consumer_evidence: manifest.consumerEvidenceBinding,
    candidate: { file: 'board/render.mjs', old_line: oldLine, new_line: newLine, before_sha256: hash(original), after_sha256: hash(candidate) },
    validation, outcomes,
    independent_review: 'not performed by this engineer; ordinary bootstrap and ready review required before activation/promotion' };
  t.diagnostic(`GREEN_MAIN_PROBE ${JSON.stringify(evidence)}`);
});

for (const operation of ['changed', 'deleted', 'added', 'external-drift']) test(`ordinary ${operation} keeps the suite green while stale pins refuse green admission`, async t => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'green-probe-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  for (const file of BOOTSTRAP_FILES.concat('board/render.mjs', 'board/rows.mjs', 'test/board-view.test.mjs', 'lib/unrelated.mjs')) {
    fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
    fs.writeFileSync(path.join(scratch, file), file === 'board/render.mjs' ? fs.readFileSync(path.join(checkout, file)) : file === 'board/rows.mjs' ? "export const WITHHELD = 'fixture';\n" : '// base\n');
  }
  git(scratch, ['init', '-qb', 'main']); git(scratch, ['config', 'user.name', 'Fixture']); git(scratch, ['config', 'user.email', 'fixture@example.invalid']);
  git(scratch, ['add', '.']); git(scratch, ['commit', '-qm', 'Base']);
  const external = path.join(scratch, '.git/launcher.json'); fs.writeFileSync(external, '{}');
  const pinnedTree = sourceTree(scratch), manifest = buildManifest(pinnedTree, { bindings: GREEN_CONTRACTS.bindings, externalInputs: [external] });
  fs.writeFileSync(path.join(scratch, 'supervisor/green-contracts.json'), JSON.stringify(manifest));
  git(scratch, ['add', '.']); git(scratch, ['commit', '-qm', 'Reviewed pins']);
  if (operation === 'changed') fs.writeFileSync(path.join(scratch, 'lib/unrelated.mjs'), '// unrelated promotion change\n');
  else if (operation === 'deleted') fs.unlinkSync(path.join(scratch, 'lib/unrelated.mjs'));
  else if (operation === 'added') fs.writeFileSync(path.join(scratch, 'lib/added.mjs'), '// ordinary new runtime file\n');
  else fs.writeFileSync(external, '{"ordinaryDeploymentChange":true}');
  fs.writeFileSync(path.join(scratch, 'board/render.mjs'), fs.readFileSync(path.join(scratch, 'board/render.mjs'), 'utf8').replace('width = 120,', `width = ${operation === 'changed' ? 121 : 240},`));
  git(scratch, ['add', '-A']); git(scratch, ['commit', '-qm', 'Unrelated promotion']);
  let { before, trusted } = probeSource(sourceTree(scratch, 'main'));
  const original = before.read('board/render.mjs'), width = componentShape(original, 'board-default-width/v1').width;
  const candidate = original.replace(`width = ${width},`, `width = ${width === 240 ? 239 : width + 1},`);
  const after = { ...before, read: file => file === 'board/render.mjs' ? candidate : before.read(file),
    bytes: file => file === 'board/render.mjs' ? Buffer.from(candidate) : before.bytes(file) };
  const changes = [{ file: 'board/render.mjs', before: '100644', after: '100644', status: 'M' }];
  const stale = assertCommittedAdmission(before, after, { manifest, trusted, changes });
  assert.equal(stale.eligible, false); assert.match(stale.stale_manifest, /boundary version|inventory drift|external configuration drift/);
  await t.test('committed admission is explicitly skipped for stale pins', sub =>
    withCurrentPins(sub, stale, () => assert.fail('stale pins must skip only committed admission')));
  const refreshed = buildManifest(before, { bindings: GREEN_CONTRACTS.bindings, externalInputs: [external] });
  fs.writeFileSync(path.join(scratch, 'supervisor/green-contracts.json'), JSON.stringify(refreshed));
  git(scratch, ['add', '.']); git(scratch, ['commit', '-qm', 'Ordinary reviewed refresh']);
  ({ before, trusted } = probeSource(sourceTree(scratch, 'main')));
  const admitted = manifestScope(before, { ...before, read: file => file === 'board/render.mjs' ? candidate : before.read(file),
    bytes: file => file === 'board/render.mjs' ? Buffer.from(candidate) : before.bytes(file) }, { manifest: refreshed, trusted, changes });
  assert.equal(admitted.eligible, true, JSON.stringify(admitted));
  const expanded = manifestScope(before, { ...before, read: file => file === 'board/render.mjs' ? candidate + 'import(process.env.TARGET);\n' : before.read(file) }, { manifest: refreshed, trusted, changes });
  assert.equal(expanded.eligible, false); assert.match(expanded.reason, /component boundary expanded/);
});

test('a release snapshot nested under an unrelated Git main is not a canonical source checkout', t => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'green-snapshot-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  git(scratch, ['init', '-qb', 'main']);
  const nested = path.join(scratch, 'snapshot'); fs.mkdirSync(nested);
  assert.equal(canonicalSource(nested), false); assert.equal(canonicalSource(scratch), false);
});
