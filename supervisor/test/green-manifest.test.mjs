import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GREEN_CONTRACTS } from '../green-pass.mjs';
import { buildManifest, BOOTSTRAP_FILES, manifestScope, componentShape } from '../green-manifest.mjs';
import { renderer } from './green-fixture.mjs';
import { git, sourceTree, probeSource, canonicalSource, assertCommittedAdmission, withCurrentPins, hash } from './green-probe.mjs';

// Containment is already loaded; model the production loader environment.
delete process.env.NODE_OPTIONS;
for (const operation of ['changed', 'deleted', 'added', 'external-drift']) test(`ordinary ${operation} keeps the suite green while stale pins refuse green admission`, async t => {
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'green-probe-')));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  for (const file of BOOTSTRAP_FILES.concat('board/render.mjs', 'board/rows.mjs', 'test/board-view.test.mjs', 'lib/unrelated.mjs')) {
    fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
    fs.writeFileSync(path.join(scratch, file), file === 'board/render.mjs' ? renderer : file === 'board/rows.mjs' ? "export const WITHHELD = 'fixture';\n" : '// base\n');
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

for (const operation of ['renderer-signature', 'renderer-range', 'renderer-deleted', 'renderer-mode',
  'validation-deleted', 'validation-renamed', 'validation-mode', 'confirmation-changed', 'confirmation-deleted', 'inventory-changed'])
test(`ordinary ${operation} skips committed admission while offline manifest tests stay usable`, async t => {
  const sources = new Map(BOOTSTRAP_FILES.map(file => [file, '// trusted fixture\n']));
  sources.set('board/render.mjs', renderer); sources.set('board/rows.mjs', "export const WITHHELD = 'fixture';\n");
  sources.set('test/board-view.test.mjs', '// reviewed validation\n');
  sources.set('docs/confirmation.txt', 'owner confirmation\n'); sources.set('docs/inventory.json', '{}\n');
  const makeTree = (bytes, files = new Map([...bytes.keys()].map(file => [file, { mode: '100644' }]))) => ({
    files, read: file => { assert.ok(bytes.has(file), file); return bytes.get(file); },
    bytes: file => { assert.ok(bytes.has(file), file); return Buffer.from(bytes.get(file)); },
  });
  const reviewed = makeTree(sources), manifest = buildManifest(reviewed, { bindings: GREEN_CONTRACTS.bindings,
    consumerEvidenceBinding: Object.fromEntries([['confirmation', 'docs/confirmation.txt'], ['inventory', 'docs/inventory.json']]
      .map(([key, file]) => [key, { path: file, sha256: hash(sources.get(file)) }])) });
  sources.set('supervisor/green-contracts.json', JSON.stringify(manifest));
  const current = new Map(sources), files = new Map(reviewed.files);
  if (operation === 'renderer-signature') current.set('board/render.mjs', renderer.replace('height = Infinity,', 'height = Infinity, palette = null,'));
  if (operation === 'renderer-range') current.set('board/render.mjs', renderer.replace('width = 120,', 'width = 300,'));
  if (operation === 'renderer-deleted') { files.delete('board/render.mjs'); current.delete('board/render.mjs'); }
  if (operation === 'renderer-mode') files.set('board/render.mjs', { mode: '100755' });
  if (operation === 'validation-deleted' || operation === 'validation-renamed') { files.delete('test/board-view.test.mjs'); current.delete('test/board-view.test.mjs'); }
  if (operation === 'validation-renamed') { files.set('test/renamed.test.mjs', { mode: '100644' }); current.set('test/renamed.test.mjs', '// renamed\n'); }
  if (operation === 'validation-mode') files.set('test/board-view.test.mjs', { mode: '100755' });
  if (operation === 'confirmation-changed') current.set('docs/confirmation.txt', 'different confirmation\n');
  if (operation === 'confirmation-deleted') { files.delete('docs/confirmation.txt'); current.delete('docs/confirmation.txt'); }
  if (operation === 'inventory-changed') current.set('docs/inventory.json', '{"different":true}\n');
  const before = makeTree(current, files), candidate = new Map(current); candidate.set('board/render.mjs', renderer.replace('width = 120,', 'width = 121,'));
  const afterFiles = new Map(files); afterFiles.set('board/render.mjs', { mode: '100644' });
  const changes = [{ file: 'board/render.mjs', status: 'M', before: files.get('board/render.mjs')?.mode ?? '000000', after: '100644' }];
  const stale = assertCommittedAdmission(before, makeTree(candidate, afterFiles), {
    manifest, trusted: (file, _mode, raw) => raw ? before.bytes(file) : before.read(file), changes });
  assert.equal(stale.eligible, false); assert.ok(stale.stale_manifest, operation);
  await t.test('stale component, validation or evidence is an explicit admission-only skip', sub =>
    withCurrentPins(sub, stale, () => assert.fail('stale input reached admission')));
  const repaired = new Map(sources); repaired.set('board/render.mjs', renderer.replace('width = 120,', 'width = 121,'));
  const admitted = assertCommittedAdmission(reviewed, makeTree(repaired), {
    manifest, trusted: (file, _mode, raw) => raw ? reviewed.bytes(file) : reviewed.read(file),
    changes: [{ file: 'board/render.mjs', status: 'M', before: '100644', after: '100644' }] });
  assert.equal(admitted.eligible, true, 'restoring reviewed inputs permits the candidate');
});
