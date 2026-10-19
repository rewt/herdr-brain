import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture, isolatedEnv } from './helpers/retire-fixture.mjs';
import { measureLaneEvidence, preserveLaneEvidence } from '../lib/lane-removal.mjs';

const cli = fileURLToPath(new URL('../lanes/lane.mjs', import.meta.url));
const disposable = ['node_modules', 'dist', 'build', '.cache', 'coverage', 'target'];
// BCH REV-863's complete declaration and synthetic samples, copied here so the
// offline regression never imports another project's files or configuration.
const protectedCases = [
  ['**/secrets/**', 'secrets', true],
  ['**/wallet-state/**', 'wallet-state', true],
  ['**/profiles/**', 'profiles', true],
  ['**/funded-sources/**', 'funded-sources', true],
  ['**/.local/**', '.local', true],
  ['**/*.wallet.json', 'guard.wallet.json'],
  ['**/*.profile.json', 'guard.profile.json'],
  ['**/*.pem', 'guard.pem'],
  ['**/*.key', 'guard.key'],
  ['**/*.seed', 'guard.seed'],
  ['**/*.mnemonic', 'guard.mnemonic'],
  ['**/alice_fusion_chipnet/**', 'alice_fusion_chipnet', true],
  ['**/bob_fusion_chipnet/**', 'bob_fusion_chipnet', true],
  ['**/.local-probes/**', '.local-probes', true],
  ['**/.local-proof/**', '.local-proof', true],
  ['**/.local-console/**', '.local-console', true],
  ['**/.publication/**', '.publication', true],
  ['**/.local-export-staging*/**', '.local-export-staging-review', true],
  ['**/.env', '.env'],
  ['**/.env.*', '.env.production'],
  [null, '.local-live', true],
];
const inside = (file, root) => typeof file === 'string' && (file === root || file.startsWith(root + path.sep));
const options = f => ({ common: f.common, lane: f.lane, topic: 'topic', tip: f.head, env: f.env,
  tracked: new Set(f.git(['ls-files', '-z'], f.lane).split('\0').filter(Boolean)) });
const protect = (f, patterns) => fs.writeFileSync(path.join(f.repo, '.lane.json'), JSON.stringify({ retirement: { protected_paths: patterns } }));
function setup(t) {
  const f = fixture(t, { occupied: false }); isolatedEnv(t, f);
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\n' + [...disposable.map(name => `${name}/`), 'aaa-evidence'].join('\n') + '\n');
  // Refusal must precede reads of other, non-protected evidence as well.
  fs.writeFileSync(path.join(f.lane, 'aaa-evidence'), 'ordinary synthetic evidence');
  return f;
}
function write(f, relative) {
  const file = path.join(f.lane, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'synthetic canary; no private material'); return file;
}

function withoutPayloadOrArchive(f, body) {
  const archive = path.join(f.common, 'lane-archive'), originals = new Map();
  const attempts = { payload: 0, archive: 0 };
  for (const operation of ['openSync', 'readFileSync', 'readlinkSync', 'copyFileSync', 'mkdirSync', 'writeFileSync', 'symlinkSync']) {
    const original = fs[operation]; originals.set(operation, original);
    fs[operation] = (file, ...args) => {
      if (['openSync', 'readFileSync', 'readlinkSync', 'copyFileSync'].includes(operation) && inside(file, f.lane)) {
        attempts.payload++; assert.fail(`payload access through ${operation}`);
      }
      if (inside(file, archive) || (['copyFileSync', 'symlinkSync'].includes(operation) && inside(args[0], archive))) {
        attempts.archive++; assert.fail(`archive access through ${operation}`);
      }
      return original(file, ...args);
    };
  }
  try { body(); }
  finally { for (const [operation, original] of originals) fs[operation] = original; }
  assert.deepEqual(attempts, { payload: 0, archive: 0 });
}
function assertKept(f, o, relative) {
  const message = `protected wallet/secret/live state at ${relative}; lane kept without copying`;
  withoutPayloadOrArchive(f, () => {
    assert.throws(() => measureLaneEvidence(o), { message });
    assert.throws(() => preserveLaneEvidence(o), { message });
  });
  assert.ok(fs.existsSync(path.join(f.lane, relative)));
  assert.ok(fs.existsSync(f.lane));
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
}

for (const directory of disposable) for (const depth of [1, 3]) {
  test(`all 20 protected globs and built-in live state keep under ${directory} at depth ${depth}`, t => {
    const f = setup(t), o = options(f);
    const prefix = depth === 1 ? directory : `${directory}/deep/level`;
    for (const [glob, sample, isDirectory] of protectedCases) {
      protect(f, glob ? [glob] : []);
      const relative = `${prefix}/${sample}`, target = path.join(f.lane, relative);
      const canary = write(f, isDirectory ? `${relative}/synthetic-canary.txt` : relative);
      assert.equal(f.git(['check-ignore', '--', relative], f.lane), relative, 'matrix path must actually be ignored');
      assertKept(f, o, relative);
      assert.equal(fs.readFileSync(canary, 'utf8'), 'synthetic canary; no private material');
      fs.rmSync(target, { recursive: true, force: true });
    }
    assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
    assert.equal(f.git(['tag', '--list', 'archive/lane/*']), '');
    t.diagnostic('21 protected cases; measurement and preservation refused with no payload or archive access');
  });
}

test('all protected globs and built-in live state still keep outside disposable directories', t => {
  const f = setup(t), o = options(f);
  for (const [glob, sample, isDirectory] of protectedCases) {
    protect(f, glob ? [glob] : []);
    const relative = `ordinary/deep/${sample}`;
    write(f, isDirectory ? `${relative}/synthetic-canary.txt` : relative);
    assertKept(f, o, relative);
    fs.rmSync(path.join(f.lane, relative), { recursive: true, force: true });
  }
});

test('tracked parents never hide untracked protected descendants in disposable trees', t => {
  const f = setup(t); fs.unlinkSync(path.join(f.lane, 'aaa-evidence'));
  for (const directory of disposable) for (const name of ['secrets', '.local-live']) write(f, `${directory}/${name}/tracked`);
  f.git(['add', '-f', ...disposable], f.lane); f.git(['commit', '-qm', 'tracked protected parents'], f.lane);
  const o = options(f); protect(f, ['**/secrets/**']);
  assert.equal(measureLaneEvidence(o).bytes, 0, 'tracked-only protected parents remain recoverable through Git');
  for (const directory of disposable) for (const name of ['secrets', '.local-live']) {
    const relative = `${directory}/${name}/untracked-canary`, file = write(f, relative);
    assertKept(f, o, relative); fs.unlinkSync(file);
  }
});

test('lane close keeps claimed protected and live descendants without an evidence or Git archive', t => {
  const f = setup(t);
  const preload = path.join(f.scratch, 'no-protected-payload.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';const root=${JSON.stringify(f.lane)};
for(const operation of ['openSync','readFileSync','readlinkSync','copyFileSync']){const original=fs[operation];fs[operation]=(file,...args)=>{
if(typeof file==='string'&&file.startsWith(root+'/')&&!file.startsWith(root+'/.git'))throw Error('lane payload access');return original(file,...args);};}
`);
  for (const [relative, patterns] of [['dist/secrets', ['**/secrets/**']], ['build/.local-live', []]]) {
    protect(f, patterns); const canary = write(f, `${relative}/synthetic-canary.txt`);
    const events = fs.readFileSync(f.eventFile, 'utf8').trim().split('\n').map(JSON.parse);
    events.find(event => event.type === 'report.ingested').report.artifacts = [path.dirname(canary)];
    fs.writeFileSync(f.eventFile, events.map(event => JSON.stringify(event) + '\n').join(''));
    const closed = spawnSync(process.execPath, ['--import', preload, cli, 'close', 'topic', '--git-only', '--expected-tip', f.head],
      { cwd: f.repo, env: f.env, encoding: 'utf8' });
    assert.notEqual(closed.status, 0);
    assert.ok(closed.stderr.includes(`protected wallet/secret/live state at ${relative}; lane kept without copying`), closed.stdout + closed.stderr);
    assert.ok(fs.existsSync(canary));
    assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
    assert.equal(f.git(['tag', '--list', 'archive/lane/*']), '');
    assert.equal(f.git(['rev-parse', 'lane/topic']), f.head);
    assert.ok(f.git(['worktree', 'list', '--porcelain']).includes(`worktree ${f.lane}\n`));
    fs.rmSync(path.join(f.lane, relative), { recursive: true, force: true });
  }
});

test('ordinary ignored disposable payloads still remove with metadata only', t => {
  const f = setup(t); fs.unlinkSync(path.join(f.lane, 'aaa-evidence'));
  protect(f, protectedCases.map(([glob]) => glob).filter(Boolean));
  for (const directory of disposable) write(f, `${directory}/pkg/output`);
  f.env.LANE_EVIDENCE_MAX_BYTES = '0';
  withoutPayloadOrArchive(f, () => assert.deepEqual(measureLaneEvidence(options(f)), { bytes: 0, maxBytes: 0 }));
  const preload = path.join(f.scratch, 'no-disposable-payload.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';const root=${JSON.stringify(f.lane)};const names=${JSON.stringify(disposable)};
for(const operation of ['openSync','readFileSync','readlinkSync','copyFileSync']){const original=fs[operation];fs[operation]=(file,...args)=>{
if(typeof file==='string'&&names.some(name=>file.startsWith(root+'/'+name+'/')))throw Error('disposable payload access');return original(file,...args);};}
`);
  const closed = spawnSync(process.execPath, ['--import', preload, cli, 'close', 'topic', '--git-only', '--expected-tip', f.head],
    { cwd: f.repo, env: f.env, encoding: 'utf8' });
  assert.equal(closed.status, 0, closed.stdout + closed.stderr);
  assert.equal(fs.existsSync(f.lane), false);
  const proof = closed.stdout.split('\n').filter(line => line.startsWith('{')).map(JSON.parse).find(row => row.action === 'lane-preflight').evidence;
  const saved = JSON.parse(fs.readFileSync(proof.manifest));
  assert.equal(saved.entries.length, disposable.length * 3);
  assert.ok(saved.entries.every(entry => entry.metadataOnly && entry.sha256 === undefined));
  assert.deepEqual(fs.readdirSync(path.join(proof.directory, 'files')), []);
});
