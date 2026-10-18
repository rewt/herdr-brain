import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { fixture } from './helpers/retire-fixture.mjs';
import { measureLaneEvidence, preserveLaneEvidence } from '../lib/lane-removal.mjs';

const cli = fileURLToPath(new URL('../lanes/lane.mjs', import.meta.url));
const disposable = ['node_modules', 'dist', 'build', '.cache', 'coverage', 'target'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const options = f => ({ common: f.common, lane: f.lane, topic: 'topic', tip: f.head, env: f.env,
  tracked: new Set(f.git(['ls-files', '-z'], f.lane).split('\0').filter(Boolean)) });
const ignore = (f, patterns) => fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n' + patterns.join('\n') + '\n');
function write(f, relative, bytes = 'unique evidence') {
  const file = path.join(f.lane, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
}
const manifest = proof => JSON.parse(fs.readFileSync(proof.manifest));

test('integrated lane retires with oversized ignored disposable trees, recording metadata without reading or copying their payloads', t => {
  const f = fixture(t, { occupied: false }); ignore(f, disposable.map(name => `${name}/`));
  for (const name of disposable) write(f, `${name}/package/output`, 'rebuildable');
  const large = write(f, 'node_modules/package/output\n.bin', ''); fs.truncateSync(large, 256 * 1024 * 1024 + 1);
  fs.mkdirSync(path.join(f.lane, 'node_modules/empty'));
  const external = path.join(f.scratch, 'external'); fs.writeFileSync(external, 'external bytes stay outside the archive');
  const link = path.join(f.lane, 'node_modules/link'); fs.symlinkSync(external, link);
  f.env.LANE_EVIDENCE_MAX_BYTES = '0';
  assert.deepEqual(measureLaneEvidence(options(f)), { bytes: 0, maxBytes: 0 });
  const sizes = new Map();
  const visit = relative => {
    const stat = fs.lstatSync(path.join(f.lane, relative)); sizes.set(relative, stat.size);
    if (stat.isDirectory()) for (const name of fs.readdirSync(path.join(f.lane, relative))) visit(path.join(relative, name));
  };
  disposable.forEach(visit);
  const preload = path.join(f.scratch, 'no-disposable-payload.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';const root=${JSON.stringify(f.lane)};const names=${JSON.stringify(disposable)};
const omitted=file=>typeof file==='string'&&names.some(name=>file.startsWith(root+'/'+name+'/'));
for(const operation of ['openSync','readFileSync','copyFileSync','readlinkSync']){const original=fs[operation];fs[operation]=(file,...args)=>{if(omitted(file))throw Error('disposable payload must not be read or copied');return original(file,...args);};}
`);
  const closed = spawnSync(process.execPath, ['--import', preload, cli, 'close', 'topic', '--git-only', '--expected-tip', f.head],
    { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(closed.status, 0, closed.stdout + closed.stderr); assert.equal(fs.existsSync(f.lane), false);
  const proof = closed.stdout.split('\n').filter(line => line.startsWith('{')).map(JSON.parse).find(row => row.action === 'lane-preflight').evidence;
  const saved = fs.readFileSync(proof.manifest); assert.equal(digest(saved), proof.sha256);
  assert.equal(manifest(proof).schema, 'lane-evidence/v2');
  assert.equal(manifest(proof).entries.length, sizes.size);
  for (const entry of manifest(proof).entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['metadataOnly', 'path', 'size', 'type']);
    assert.equal(entry.metadataOnly, true); assert.equal(entry.size, sizes.get(entry.path));
  }
  assert.equal(manifest(proof).entries.find(entry => entry.path === 'node_modules/link').type, 'symlink');
  assert.deepEqual(fs.readdirSync(path.join(proof.directory, 'files')), []);
  assert.equal(fs.readFileSync(external, 'utf8'), 'external bytes stay outside the archive');
});

test('unknown ignored content, reports, diagnostics and evidence inside disposable trees retain verified bytes and symlinks', t => {
  const f = fixture(t, { occupied: false }); ignore(f, ['.lane/', 'unknown/', 'reports/', 'diagnostics/', 'dist/']);
  const files = ['.lane/scratch', 'unknown/blob', 'reports/summary', 'diagnostics/trace', 'dist/evidence/proof', 'dist/reports/result', 'dist/report.json'];
  for (const relative of files) write(f, relative, relative + '\n');
  fs.mkdirSync(path.join(f.lane, 'unknown/empty'));
  fs.symlinkSync('blob', path.join(f.lane, 'unknown/link'));
  write(f, 'dist/package/output', 'rebuildable');
  const o = options(f), proof = preserveLaneEvidence(o), saved = manifest(proof);
  const bytes = files.reduce((total, file) => total + Buffer.byteLength(file + '\n'), Buffer.byteLength('blob'));
  assert.equal(measureLaneEvidence(o).bytes, bytes);
  for (const relative of files) {
    const entry = saved.entries.find(entry => entry.path === relative), expected = Buffer.from(relative + '\n');
    assert.equal(entry.metadataOnly, undefined); assert.equal(entry.sha256, digest(expected));
    assert.deepEqual(fs.readFileSync(path.join(proof.directory, 'files', relative)), expected);
  }
  assert.equal(fs.readlinkSync(path.join(proof.directory, 'files/unknown/link')), 'blob');
  assert.ok(fs.statSync(path.join(proof.directory, 'files/unknown/empty')).isDirectory());
  assert.equal(fs.existsSync(path.join(proof.directory, 'files/dist/package')), false);
  proof.verify();
  fs.writeFileSync(path.join(proof.directory, 'files/unknown/blob'), 'corrupted');
  assert.throws(proof.verify, /hash or inventory mismatch/);
});

for (const absolute of [false, true]) test(`a ${absolute ? 'absolute' : 'relative'} recorded artifact claim overrides disposable classification`, t => {
  const f = fixture(t, { occupied: false }); ignore(f, ['dist/']);
  const file = write(f, 'dist/output.bin', 'claimed artifact'); write(f, 'dist/other.bin', 'rebuildable');
  const events = fs.readFileSync(f.eventFile, 'utf8').trim().split('\n').map(JSON.parse);
  events.find(event => event.type === 'report.ingested').report.artifacts = [absolute ? file : 'dist/output.bin'];
  fs.writeFileSync(f.eventFile, events.map(event => JSON.stringify(event) + '\n').join(''));
  f.env.LANE_EVIDENCE_MAX_BYTES = String(Buffer.byteLength('claimed artifact') - 1);
  assert.throws(() => preserveLaneEvidence(options(f)), /exceeds budget/);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
  f.env.LANE_EVIDENCE_MAX_BYTES = String(Buffer.byteLength('claimed artifact'));
  const proof = preserveLaneEvidence(options(f));
  assert.equal(fs.readFileSync(path.join(proof.directory, 'files/dist/output.bin'), 'utf8'), 'claimed artifact');
  assert.equal(fs.existsSync(path.join(proof.directory, 'files/dist/other.bin')), false);
  assert.equal(measureLaneEvidence(options(f)).bytes, Buffer.byteLength('claimed artifact'));
  proof.verify();
});

test('a reference claim preserves a disposable subtree, and a new claim invalidates an earlier metadata-only proof', t => {
  const f = fixture(t, { occupied: false }); ignore(f, ['build/']);
  write(f, 'build/claimed/output', 'claimed bytes'); write(f, 'build/other', 'rebuildable');
  const proof = preserveLaneEvidence(options(f));
  fs.writeFileSync(path.join(f.org, 'references/artifact.json'), JSON.stringify({ path: path.join(f.lane, 'build/claimed') }));
  assert.throws(proof.verify, /hash or inventory mismatch/);
  const claimed = preserveLaneEvidence(options(f));
  assert.equal(fs.readFileSync(path.join(claimed.directory, 'files/build/claimed/output'), 'utf8'), 'claimed bytes');
  assert.equal(fs.existsSync(path.join(claimed.directory, 'files/build/other')), false);
});

test('normalized and whole-lane artifact claims override disposable classification', t => {
  for (const claim of ['./dist//nested/../output.bin', '.']) {
    const f = fixture(t, { occupied: false }); ignore(f, ['dist/']); write(f, 'dist/output.bin', 'claimed artifact');
    const events = fs.readFileSync(f.eventFile, 'utf8').trim().split('\n').map(JSON.parse);
    events.find(event => event.type === 'report.ingested').report.artifacts = [claim];
    fs.writeFileSync(f.eventFile, events.map(event => JSON.stringify(event) + '\n').join(''));
    const proof = preserveLaneEvidence(options(f));
    assert.equal(fs.readFileSync(path.join(proof.directory, 'files/dist/output.bin'), 'utf8'), 'claimed artifact');
    assert.equal(measureLaneEvidence(options(f)).bytes, Buffer.byteLength('claimed artifact'));
  }
});

test('an allowlisted name without Git ignore confirmation is fully preserved', t => {
  const f = fixture(t, { occupied: false }); write(f, 'dist/output', 'unique non-ignored bytes');
  const proof = preserveLaneEvidence(options(f));
  assert.equal(fs.readFileSync(path.join(proof.directory, 'files/dist/output'), 'utf8'), 'unique non-ignored bytes');
  assert.equal(measureLaneEvidence(options(f)).bytes, Buffer.byteLength('unique non-ignored bytes'));
});

test('nested ignored dependency directories omit payloads while preserving their ordinary parents', t => {
  const f = fixture(t, { occupied: false }); ignore(f, ['node_modules/']); write(f, 'packages/pkg/node_modules/dependency/output');
  const proof = preserveLaneEvidence(options(f));
  assert.ok(fs.statSync(path.join(proof.directory, 'files/packages/pkg')).isDirectory());
  assert.equal(fs.existsSync(path.join(proof.directory, 'files/packages/pkg/node_modules')), false);
  assert.equal(measureLaneEvidence(options(f)).bytes, 0); proof.verify();
});

test('oversized non-ignored untracked bytes still refuse before payload reads or archive creation', t => {
  const f = fixture(t, { occupied: false }), file = write(f, 'untracked-large', ''); fs.truncateSync(file, 256 * 1024 * 1024 + 1);
  const o = options(f), open = fs.openSync;
  fs.openSync = (target, ...args) => { if (target === file) assert.fail('oversized payload was read'); return open(target, ...args); };
  try {
    assert.throws(() => measureLaneEvidence(o), /evidence size 268435457 bytes exceeds budget 268435456/);
    assert.throws(() => preserveLaneEvidence(o), /evidence size 268435457 bytes exceeds budget 268435456/);
  } finally { fs.openSync = open; }
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
  assert.equal(fs.statSync(file).size, 256 * 1024 * 1024 + 1); assert.ok(fs.existsSync(f.lane));
});

for (const relative of ['.local-live/round.secrets.json', 'wallet/state.json', 'dist/.env', 'node_modules/package/private-key.pem', '.lane/.aws/credentials', '.env']) {
  test(`protected ${relative} keeps the lane before any payload read or copy`, t => {
    const f = fixture(t, { occupied: false }); ignore(f, ['*']); const file = write(f, relative, 'synthetic protected-state fixture');
    const o = options(f), open = fs.openSync;
    fs.openSync = (target, ...args) => { if (target === file) assert.fail('protected payload was read'); return open(target, ...args); };
    try {
      assert.throws(() => measureLaneEvidence(o), /protected wallet\/secret\/live state.*lane kept without copying/);
      assert.throws(() => preserveLaneEvidence(o), /protected wallet\/secret\/live state.*lane kept without copying/);
    } finally { fs.openSync = open; }
    const closed = f.close(); assert.notEqual(closed.status, 0); assert.match(closed.stderr, /protected wallet\/secret\/live state/);
    assert.ok(fs.existsSync(file)); assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
    assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
  });
}

test('tracked protected state also refuses rather than being dismissed as Git-recoverable content', t => {
  const f = fixture(t, { occupied: false }); write(f, '.env', 'synthetic protected-state fixture');
  f.git(['add', '.env'], f.lane); f.git(['commit', '-qm', 'synthetic tracked state'], f.lane);
  assert.throws(() => preserveLaneEvidence(options(f)), /protected wallet\/secret\/live state/);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
});

for (const source of ['record', 'reference']) test(`an incomplete ${source} claim source keeps the lane instead of omitting output`, t => {
  const f = fixture(t, { occupied: false }); ignore(f, ['.cache/']); write(f, '.cache/output'); const o = options(f);
  if (source === 'record') fs.appendFileSync(f.eventFile, '{');
  else fs.writeFileSync(path.join(f.org, 'references/broken.json'), '{');
  assert.throws(() => preserveLaneEvidence(o), /evidence\/reference claims unavailable; lane kept/);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
});

for (const output of ['failure', 'truncated']) test(`a ${output} Git ignore classification keeps without creating an archive`, t => {
  const f = fixture(t, { occupied: false }); ignore(f, ['.cache/']); write(f, '.cache/output');
  const o = options(f), git = path.join(f.scratch, 'git');
  fs.writeFileSync(git, `#!${process.execPath}\n${output === 'failure' ? "process.stderr.write('classification unavailable');process.exit(2);" : "process.stdout.write('.cache/output');"}\n`, { mode: 0o755 });
  o.env = { ...o.env, PATH: f.scratch + path.delimiter + o.env.PATH };
  assert.throws(() => preserveLaneEvidence(o), /ignore classification unavailable/);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false); assert.ok(fs.existsSync(f.lane));
});

test('metadata changes and newly appearing protected state invalidate verification before removal', t => {
  const f = fixture(t, { occupied: false }); ignore(f, ['target/']); const file = write(f, 'target/output', 'rebuildable');
  const proof = preserveLaneEvidence(options(f)); fs.writeFileSync(file, 'different size');
  assert.throws(proof.verify, /hash or inventory mismatch/);
  const fresh = preserveLaneEvidence(options(f)); write(f, 'target/wallet/state', 'synthetic state');
  assert.throws(fresh.verify, /protected wallet\/secret\/live state/); assert.ok(fs.existsSync(f.lane));
});
