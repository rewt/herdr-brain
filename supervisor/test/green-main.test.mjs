// Actual main source plus an explicit ordinary bootstrap overlay. No refs,
// source checkout, deployment configuration or records are mutated by this probe.
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gitProject } from '../../lib/project.mjs';
import { findOrgDir } from '../../lib/store.mjs';
import { GREEN_CONTRACTS, greenManifestIdentity } from '../green-pass.mjs';
import { buildManifest, BOOTSTRAP_FILES, manifestScope } from '../green-manifest.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
test('real main admits an exact renderer change and refuses every boundary control', async t => {
  const checkout = fs.realpathSync(new URL('../../', import.meta.url));
  const project = gitProject(checkout), root = project.canonical;
  const git = args => {
    const result = spawnSync('git', ['--no-optional-locks', '-C', checkout, ...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    assert.equal(result.status, 0, result.stderr || result.error?.message); return result.stdout;
  };
  const main = git(['rev-parse', 'main']).trim(), files = new Map(), cache = new Map();
  for (const row of git(['ls-tree', '-r', '-z', main]).split('\0').filter(Boolean)) {
    const match = /^(\d{6}) \w+ ([a-f0-9]+)\t(.+)$/.exec(row); assert.ok(match); files.set(match[3], { mode: match[1], oid: match[2] });
  }
  const mainRead = file => {
    if (!cache.has(file)) { assert.ok(files.has(file), file); cache.set(file, git(['cat-file', 'blob', files.get(file).oid])); }
    return cache.get(file);
  };
  const original = mainRead('board/render.mjs');
  // Main does not yet contain ENG-396. This explicitly models its required
  // ordinary bootstrap; it does not waive missing manifest/checker inputs.
  const overlay = new Map();
  for (const file of BOOTSTRAP_FILES.concat('supervisor/autopilot.mjs', 'supervisor/README.md', 'test/helpers/tier.mjs')) {
    overlay.set(file, fs.readFileSync(path.join(checkout, file), 'utf8')); files.set(file, { mode: '100644' });
  }
  const before = { files, root, read: file => overlay.has(file) ? overlay.get(file) : mainRead(file) };
  const brain = { repo: root, identity: project.identity, org: fs.realpathSync(findOrgDir({ cwd: root, env: { ...process.env, ORG_DIR: '' } })) };
  const manifest = { ...buildManifest(before, { bindings: { brain } }), exclusions: GREEN_CONTRACTS.exclusions };
  overlay.set('supervisor/green-contracts.json', JSON.stringify(manifest));
  const trusted = file => overlay.has(file) ? overlay.get(file) : fs.readFileSync(path.join(checkout, file), 'utf8');
  const oldLine = 'export function render(snapshot, { width = 120, height = Infinity, now = Date.now() } = {}) {';
  const newLine = oldLine.replace('120', '121'); assert.ok(original.includes(oldLine));
  const candidate = original.replace(oldLine, newLine), outcomes = [];
  for (const [label, file, contents, expected] of [
    ['renderer', 'board/render.mjs', candidate, null],
    ['bch-entry', 'supervisor/reconcile.mjs', before.read('supervisor/reconcile.mjs') + '// changed\n', 'GREEN_BCH_CONSUMED'],
    ['promotion-authority', 'test/helpers/run.mjs', before.read('test/helpers/run.mjs') + '// changed\n', 'GREEN_SELF_AUTHORITY'],
    ['manifest', 'supervisor/green-contracts.json', before.read('supervisor/green-contracts.json') + '\n', 'GREEN_SELF_AUTHORITY'],
    ['boundary', 'board/rows.mjs', before.read('board/rows.mjs') + '// changed\n', 'GREEN_BOUNDARY_CHANGED'],
    ['new-edge', 'board/render.mjs', candidate + 'import(process.env.TARGET);\n', 'GREEN_REACH_UNKNOWN'],
  ]) {
    const after = { ...before, read: name => name === file ? contents : before.read(name) };
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
  const foreign = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'green-foreign-')));
  t.after(() => fs.rmSync(foreign, { recursive: true, force: true }));
  const initialized = spawnSync('git', ['-C', foreign, 'init', '-qb', 'main'], { encoding: 'utf8' }); assert.equal(initialized.status, 0);
  assert.equal(greenManifestIdentity({ ...brain, bindings: { brain, lab: null, activatedAt: new Date().toISOString() } }, { manifest, sourceRoot: checkout }).identity, brain.identity);
  assert.throws(() => greenManifestIdentity({ ...brain, repo: foreign, bindings: { brain, lab: null, activatedAt: new Date().toISOString() } }, { manifest, sourceRoot: checkout }), /GREEN_IDENTITY_MISMATCH/);
  outcomes.push({ label: 'foreign-project-target', eligible: false, code: 'GREEN_IDENTITY_MISMATCH' });

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
    bootstrap_overlay: [...overlay.keys()].map(file => ({ file, sha256: hash(overlay.get(file)) })),
    manifest_sha256: hash(JSON.stringify(manifest)), boundary_inputs: Object.keys(manifest.boundary).length,
    candidate: { file: 'board/render.mjs', old_line: oldLine, new_line: newLine, before_sha256: hash(original), after_sha256: hash(candidate) },
    validation: { exact_candidate_bytes: true, default_width: 121, explicit_width: 80, height: 1 }, outcomes,
    independent_review: 'not performed by this engineer; ordinary bootstrap and ready review required before activation/promotion' };
  t.diagnostic(`GREEN_MAIN_PROBE ${JSON.stringify(evidence)}`);
});
