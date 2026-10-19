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
const disposable = ['node_modules', '.pnpm-store', 'dist', 'build', '.cache', 'coverage', 'target'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const options = f => ({ common: f.common, lane: f.lane, topic: 'topic', tip: f.head, env: f.env,
  tracked: new Set(f.git(['ls-files', '-z'], f.lane).split('\0').filter(Boolean)) });
const ignore = (f, patterns) => fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n' + patterns.join('\n') + '\n');
const protect = (f, patterns) => fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ retirement: { protected_paths: patterns } }));
function write(f, relative, bytes = 'unique evidence') {
  const file = path.join(f.lane, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file;
}
const manifest = proof => JSON.parse(fs.readFileSync(proof.manifest));

test('integrated lane retires with oversized ignored disposable trees, recording metadata without reading or copying their payloads', t => {
  const f = fixture(t, { occupied: false }); ignore(f, disposable.map(name => `${name}/`));
  for (const name of disposable) write(f, `${name}/package/output`, 'rebuildable');
  for (const relative of ['node_modules/.pnpm/pkg/node_modules/@scope/pkg/build/lib/key/wallet-import-format.js',
    'node_modules/.pnpm/pkg/node_modules/@scope/pkg/build/lib/schema/wallet-template.js',
    'node_modules/package/private-key.pem', 'dist/.env', 'target/.local-live-notes/state']) write(f, relative, 'synthetic dependency fixture');
  const large = write(f, 'node_modules/package/output\n.bin', ''); fs.truncateSync(large, 256 * 1024 * 1024 + 1);
  const store = write(f, '.pnpm-store/v3/files/large.bin', ''); fs.truncateSync(store, 256 * 1024 * 1024 + 1);
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

test('an unignored .pnpm-store preserves its payload and counts against the copy budget', t => {
  const f = fixture(t, { occupied: false }), relative = '.pnpm-store/v3/files/output';
  const bytes = Buffer.from('unique non-ignored store bytes'); write(f, relative, bytes);
  assert.equal(f.git(['status', '--porcelain', '--', '.pnpm-store'], f.lane), '?? .pnpm-store/');
  f.env.LANE_EVIDENCE_MAX_BYTES = '0';
  assert.throws(() => measureLaneEvidence(options(f)), /exceeds budget/);
  assert.throws(() => preserveLaneEvidence(options(f)), /exceeds budget/);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
  f.env.LANE_EVIDENCE_MAX_BYTES = String(bytes.length);
  const proof = preserveLaneEvidence(options(f)), entry = manifest(proof).entries.find(entry => entry.path === relative);
  assert.equal(entry.metadataOnly, undefined); assert.equal(entry.sha256, digest(bytes));
  assert.equal(measureLaneEvidence(options(f)).bytes, bytes.length);
  assert.deepEqual(fs.readFileSync(path.join(proof.directory, 'files', relative)), bytes);
  proof.verify();
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

for (const relative of ['.local-live/round.secrets.json', 'wallet/state.json', 'pinned/checkout/state', '.lane/.aws/credentials', '.env']) {
  test(`protected ${relative} keeps the lane before any payload read or copy`, t => {
    const f = fixture(t, { occupied: false }); ignore(f, ['*']); const file = write(f, relative, 'synthetic protected-state fixture');
    if (!relative.startsWith('.local-live/')) protect(f, [relative === 'wallet/state.json' ? 'wallet/**' : relative]);
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

test('tracked live modules and wallet policy files retire through the verified Git tip', t => {
  const f = fixture(t, { occupied: false });
  const files = ['sessions/live.mjs', 'sessions/live-observe.mjs', 'docs/WALLET-POLICY-V1.md', '.local-live/tracked', '.env'];
  for (const relative of files) write(f, relative, 'tracked fixture');
  f.git(['add', '.'], f.lane); f.git(['commit', '-qm', 'tracked modules and policy'], f.lane);
  const tip = f.git(['rev-parse', 'HEAD'], f.lane); f.git(['merge', '--ff-only', tip]);
  protect(f, ['sessions/**', 'docs/**', '.env']); f.env.LANE_EVIDENCE_MAX_BYTES = '0';
  assert.equal(measureLaneEvidence(options(f)).bytes, 0);
  const closed = spawnSync(process.execPath, [cli, 'close', 'topic', '--git-only', '--expected-tip', tip], { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(closed.status, 0, closed.stdout + closed.stderr); assert.equal(fs.existsSync(f.lane), false);
  for (const relative of files) assert.equal(f.git(['show', `main:${relative}`]), 'tracked fixture');
});

test('a declared non-ignored protected path keeps before payload reads and archive creation', t => {
  const f = fixture(t, { occupied: false }), file = write(f, 'state/wallet-1/keys.json');
  protect(f, ['state/wallet-?/keys.json']);
  const o = options(f), read = fs.readFileSync;
  fs.readFileSync = (target, ...args) => { if (target === file) assert.fail('protected payload was read'); return read(target, ...args); };
  try { assert.throws(() => preserveLaneEvidence(o), /protected wallet\/secret\/live state/); }
  finally { fs.readFileSync = read; }
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
});

test('undeclared wallet, secret and live prefixes outside disposable output preserve ordinary bytes', t => {
  const f = fixture(t, { occupied: false }); ignore(f, ['*']);
  const files = ['wallet/state.json', 'secrets.json', 'live-notes.txt', '.local-live-notes/summary', '.env'];
  for (const relative of files) write(f, relative, 'ordinary fixture');
  const proof = preserveLaneEvidence(options(f));
  for (const relative of files) assert.equal(fs.readFileSync(path.join(proof.directory, 'files', relative), 'utf8'), 'ordinary fixture');
});

test('a lane without a discoverable record keeps when ignored disposable output would be omitted', t => {
  const f = fixture(t, { occupied: false }); ignore(f, ['node_modules/']); write(f, 'node_modules/pkg/output');
  delete f.env.ORG_DIR;
  assert.throws(() => measureLaneEvidence(options(f)), /evidence\/reference claims unavailable; lane kept/);
  assert.throws(() => preserveLaneEvidence(options(f)), /evidence\/reference claims unavailable; lane kept/);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false); assert.ok(fs.existsSync(f.lane));
});

test('no claim source is needed when evidence names already require full copies', t => {
  const f = fixture(t, { occupied: false }); ignore(f, ['.lane/']); write(f, '.lane/build/output', 'unique bytes');
  delete f.env.ORG_DIR;
  const proof = preserveLaneEvidence(options(f));
  assert.equal(fs.readFileSync(path.join(proof.directory, 'files/.lane/build/output'), 'utf8'), 'unique bytes');
});

test('bare words, prose and foreign relative or absolute claims do not capture this lane output', t => {
  const f = fixture(t, { occupied: false }); ignore(f, disposable.map(name => `${name}/`));
  for (const name of disposable) write(f, `${name}/output`);
  const events = fs.readFileSync(f.eventFile, 'utf8').trim().split('\n').map(JSON.parse);
  events.find(event => event.type === 'report.ingested').report.artifacts = ['build', 'coverage', 'target', 'See build/output for details'];
  events.push({ type: 'run.started', id: 'R-foreign', item: 'ENG-1', workspace: path.join(f.scratch, 'foreign') },
    { type: 'report.ingested', run: 'R-foreign', report: { artifacts: ['build/output', './coverage/'] } });
  fs.writeFileSync(f.eventFile, events.map(event => JSON.stringify(event) + '\n').join(''));
  fs.writeFileSync(path.join(f.org, 'references/foreign.json'), JSON.stringify({ cwd: path.join(f.scratch, 'foreign'),
    artifacts: ['build/output', path.join(f.scratch, 'foreign/node_modules')], description: 'coverage' }));
  fs.writeFileSync(path.join(f.org, 'references/unscoped.json'), JSON.stringify({ path: 'target/output', artifacts: ['build', 'coverage', 'target'] }));
  f.env.LANE_EVIDENCE_MAX_BYTES = '0'; const proof = preserveLaneEvidence(options(f));
  assert.equal(measureLaneEvidence(options(f)).bytes, 0);
  assert.ok(manifest(proof).entries.every(entry => entry.metadataOnly));
});

for (const context of ['cwd', 'lane', 'topic']) test(`a relative reference claim bound by ${context} preserves only its exact subtree`, t => {
  const f = fixture(t, { occupied: false }); ignore(f, ['build/']);
  write(f, 'build/claimed/output', 'claimed bytes'); write(f, 'build/claimed-sibling/output');
  fs.writeFileSync(path.join(f.org, 'references/local.json'), JSON.stringify({ [context === 'topic' ? 'lane' : context]: context === 'topic' ? 'topic' : f.lane, path: './build/claimed' }));
  const proof = preserveLaneEvidence(options(f));
  assert.equal(fs.readFileSync(path.join(proof.directory, 'files/build/claimed/output'), 'utf8'), 'claimed bytes');
  assert.equal(fs.existsSync(path.join(proof.directory, 'files/build/claimed-sibling')), false);
});

test('a claimed disposable directory still keeps protected state without copying', t => {
  const f = fixture(t, { occupied: false }); ignore(f, ['node_modules/']);
  write(f, 'node_modules/pkg/.local-live/fixture', 'claimed fixture'); protect(f, ['node_modules/**']);
  fs.writeFileSync(path.join(f.org, 'references/local.json'), JSON.stringify({ path: path.join(f.lane, 'node_modules/pkg') }));
  assert.throws(() => preserveLaneEvidence(options(f)), /protected wallet\/secret\/live state at node_modules; lane kept without copying/);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
  assert.ok(fs.existsSync(path.join(f.lane, 'node_modules/pkg/.local-live/fixture')));
});

test('protected configuration errors keep before evidence payloads are read', t => {
  const f = fixture(t, { occupied: false }); write(f, 'scratch');
  for (const value of ['{', '{"retirement":{"protected_paths":"wallet/**"}}', '{"retirement":{"protected_paths":null}}', '{"retirement":{"protected_paths":["../wallet/**"]}}']) {
    fs.writeFileSync(path.join(f.repo, '.lane.json'), value);
    assert.throws(() => preserveLaneEvidence(options(f)), /protected path|retirement.protected_paths/);
  }
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
});

test('recursive project globs cover root and nested paths and are reread during verification', t => {
  const f = fixture(t, { occupied: false }); ignore(f, ['*']);
  write(f, 'round.secrets.json'); write(f, 'rounds/nested/round.secrets.json');
  write(f, '.lane.json', JSON.stringify({ retirement: { protected_paths: [] } }));
  const proof = preserveLaneEvidence(options(f)); protect(f, ['**/*.secrets.json']);
  assert.throws(proof.verify, /protected wallet\/secret\/live state/);
  fs.unlinkSync(path.join(f.lane, 'round.secrets.json'));
  assert.throws(() => preserveLaneEvidence(options(f)), /protected wallet\/secret\/live state/);
});

test('claim indexing inventories a pnpm-sized ignored tree with many declared artifacts', t => {
  const f = fixture(t, { occupied: false }); ignore(f, ['node_modules/']);
  const count = 16647, directory = 'node_modules/.pnpm/pkg/node_modules/@scope/pkg/build/lib/schema';
  fs.mkdirSync(path.join(f.lane, directory), { recursive: true });
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(f.lane, directory, `wallet-template-${i}.js`), '');
  const events = fs.readFileSync(f.eventFile, 'utf8').trim().split('\n').map(JSON.parse);
  events.find(event => event.type === 'report.ingested').report.artifacts = Array.from({ length: 2048 }, (_, i) => `build/claimed-${i}`);
  fs.writeFileSync(f.eventFile, events.map(event => JSON.stringify(event) + '\n').join(''));
  f.env.LANE_EVIDENCE_MAX_BYTES = '0';
  const start = performance.now(); assert.equal(measureLaneEvidence(options(f)).bytes, 0);
  const measured = performance.now(), proof = preserveLaneEvidence(options(f)), end = performance.now();
  const saved = manifest(proof);
  assert.equal(saved.entries.filter(entry => entry.type === 'file').length, count);
  assert.ok(saved.entries.every(entry => entry.metadataOnly));
  assert.deepEqual(fs.readdirSync(path.join(proof.directory, 'files')), []);
  t.diagnostic(`${count} files, 2048 claims: measurement ${(measured - start).toFixed(0)}ms; preservation plus source/archive verification ${(end - measured).toFixed(0)}ms`);
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
  const fresh = preserveLaneEvidence(options(f)); write(f, '.local-live/state', 'synthetic state');
  assert.throws(fresh.verify, /protected wallet\/secret\/live state/); assert.ok(fs.existsSync(f.lane));
});
