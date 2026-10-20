import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCompatibility, scratchEnvironment } from '../herdr/compat.mjs';
import { copyProduct } from '../lib/product-files.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(source, 'herdr/compat.mjs');
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'compat-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

for (const probe of ['events', 'closeout']) test(`${probe} opt-in preserves committed fixture settings and a clean canonical tree`, t => {
  const root = scratch(t), env = scratchEnvironment(root);
  fs.mkdirSync(env.HOME); fs.mkdirSync(env.XDG_CONFIG_HOME);
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin/herdr'), `#!${process.execPath}\nconst a=process.argv.slice(2);\nif(a[1]==='list') console.log(JSON.stringify({result:{workspaces:[],tabs:[],panes:[],agents:[]}}));\nelse { console.error('fixture refuses native effects'); process.exitCode=1; }\n`, { mode: 0o755 });
  const written = spawnSync(process.execPath, [path.join(source, 'herdr/compat-probes.mjs'), 'write', source, probe, root],
    { cwd: root, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(written.status, 0, written.stderr);
  const repo = path.join(root, 'project');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo, '.lane.json'))), {
    prepare: [], routes: { engineer: { kind: 'codex' }, review: { kind: 'codex' } }, retirement: { closeout_queue: true },
  });
  const status = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { env, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr); assert.equal(status.stdout, '');
});
test('NEW real writers -> archived OLD own readers without an OLD formats list', t => {
  const root = scratch(t), old = path.join(root, 'old'); fs.mkdirSync(old);
  const archive = spawnSync('git', ['archive', 'HEAD', 'bin', 'lib', 'lanes', 'discovery', 'herdr', 'housekeeping', 'dispatch', 'watch',
    'settle', 'promote', 'test-slot', 'verify', 'supervisor', 'brain', 'messages', 'contrib', 'sessions', 'setup', 'logs', 'board', 'package.json', '.nvmrc'],
  { cwd: source, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(archive.status, 0, archive.stderr.toString());
  const unpack = spawnSync('tar', ['-xf', '-', '-C', old], { input: archive.stdout });
  assert.equal(unpack.status, 0, unpack.stderr.toString());
  assert.equal(fs.existsSync(path.join(old, 'docs/contracts/formats.json')), false);
  const result = checkCompatibility(old, source);
  assert.equal(result.counts.fail, 0, JSON.stringify(result.formats.filter(f => f.status === 'fail'), null, 2));
  for (const id of ['record-events', 'closeout-entry/v1', 'promotion-queue', 'promotion-train/v1', 'lane-validation/v1', 'dispatch-journal', 'settle-journal', 'housekeeping-owner', '.herdr-release.json']) {
    assert.equal(result.formats.find(f => f.id === id).status, 'pass', id);
  }
  assert.equal(result.formats.find(f => f.id === 'promotion-closeout-outbox').status, 'not-covered');
  assert.match(result.formats.find(f => f.id === 'promotion-closeout-outbox').reason, /acknowledgement/);
  assert.ok(result.formats.filter(f => f.status === 'not-covered').every(f => f.reason));
  assert.equal(result.formats.length, Object.values(result.counts).reduce((a, b) => a + b));
});
test('reader failures retain OLD stderr, exit nonzero, write JSON and require KEEP; missing readers are named', t => {
  const root = scratch(t), old = path.join(root, 'old'), newer = path.join(root, 'new');
  fs.mkdirSync(path.join(old, 'lib'), { recursive: true });
  copyProduct(source, newer);
  const catalogFile = path.join(newer, 'docs/contracts/formats.json'), catalog = JSON.parse(fs.readFileSync(catalogFile));
  catalog.formats = catalog.formats.filter(f => f.id === 'run-timing');
  fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  const reader = path.join(old, 'lib/run-timing.mjs');
  fs.writeFileSync(reader, 'export function readTiming() { throw Error("old reader refuses new timing"); }\n');
  const output = path.join(root, 'result.json');
  const result = spawnSync(process.execPath, [cli, old, newer, '--json', '--out', output], { encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 1, result.stderr);
  const evidence = JSON.parse(result.stdout); assert.deepEqual(JSON.parse(fs.readFileSync(output)), evidence);
  assert.equal(evidence.counts.fail, 1); assert.match(evidence.formats[0].reader.stderr, /old reader refuses new timing/);
  assert.match(evidence.message, /rollback to OLD needs KEEP\/forward recovery for: run-timing/);
  fs.unlinkSync(reader);
  const missing = checkCompatibility(old, newer);
  assert.equal(missing.counts.fail, 0); assert.equal(missing.counts['not-covered'], 1);
  assert.match(missing.formats[0].reason, /OLD lacks reader module lib\/run-timing.mjs/);
  const rejected = spawnSync(process.execPath, [cli, old, newer, '--out', path.join(old, 'evidence.json')], { encoding: 'utf8' });
  assert.equal(rejected.status, 1); assert.match(rejected.stderr, /must not write into OLD/);
  assert.equal(fs.existsSync(path.join(old, 'evidence.json')), false);
});
test('scratch environment removes inherited identity, Git selectors, preloads and live resource paths', t => {
  const env = scratchEnvironment(scratch(t));
  for (const key of ['ORG_DIR', 'LANE_CONFIG', 'HERDR_PANE_ID', 'GIT_DIR', 'GIT_WORK_TREE', 'NODE_OPTIONS', 'HERDR_BRAIN_ROOT', 'BCH_CLOAK_TEST_SLOT_TOKEN']) assert.equal(env[key], undefined);
  assert.ok(env.MONITOR_TEST_SLOT_PATH.startsWith(env.HOME.slice(0, -4)));
  assert.ok(env.HERDR_MONITOR_FLEET.startsWith(env.HOME.slice(0, -4)));
});
