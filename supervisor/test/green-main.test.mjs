// Opt-in enable-time probe. Never selected by the promotion or cycle tiers.
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BCH_ENTRIES, boundaryInput, manifestScope, componentShape } from '../green-manifest.mjs';
import { git, sourceTree, bootstrapTree, probeSource, canonicalSource, deploymentSelection, hash, staleManifestReason, assertCommittedAdmission, withCurrentPins } from './green-probe.mjs';

// Test containment is already loaded; child launches stay contained.
delete process.env.NODE_OPTIONS;
const SNAPSHOT = 'outside canonical Brain Git checkout (release snapshot or foreign repository)';
const checkout = fs.realpathSync(new URL('../../', import.meta.url));
test('real-main committed pins admit while current and boundary controls always refuse', async t => {
  if (process.env.HERDR_GREEN_ENABLE_PROBE !== '1') return t.skip('enable-time probe only; set HERDR_GREEN_ENABLE_PROBE=1 explicitly');
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
  const stale = staleManifestReason(before, manifest, trusted);
  if (stale) {
    // Probe even an incompatible/deleted renderer without parsing its signature.
    // Admission must refuse before the explicit enable-time stale skip.
    const mode = before.files.get('board/render.mjs')?.mode ?? '000000';
    const admission = assertCommittedAdmission(before, before, { manifest, trusted,
      changes: [{ file: 'board/render.mjs', status: 'M', before: mode, after: mode }] });
    await t.test('renderer admission with current committed pins', sub => withCurrentPins(sub, admission,
      () => assert.fail('stale enable-time inputs must not qualify')));
    t.diagnostic(`GREEN_MAIN_STALE ${JSON.stringify(admission)}`);
    return;
  }
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
