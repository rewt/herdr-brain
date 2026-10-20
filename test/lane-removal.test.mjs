import { healthyMemoryEnvironment } from './helpers/promotion-memory-fixture.mjs';
import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnChild, waitForExit } from './helpers/child.mjs';
import { measureLaneEvidence, readLaneCwdReferences } from '../lib/lane-removal.mjs';

const cli = fileURLToPath(new URL('../lanes/lane.mjs', import.meta.url));
function fixture(t, { merged = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lane-removal-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'), lane = path.join(root, 'lane'), org = path.join(root, 'record');
  fs.mkdirSync(repo); fs.mkdirSync(org);
  const env = { ...healthyMemoryEnvironment(), ORG_DIR: org, HERDR_MONITOR_FLEET: path.join(root, 'fleet'),
    MONITOR_TEST_SLOT_PATH: path.join(root, 'slot'), MONITOR_TEST_SLOT_COMPAT_PATH: path.join(root, 'slot'),
    XDG_STATE_HOME: path.join(root, 'state'), HERDR_TAB_ID: '', HERDR_PANE_ID: '' };
  for (const key of Object.keys(env)) if (/^LANE_|^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG)/.test(key)) delete env[key];
  const git = (args, cwd = repo) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.lane/\n');
  fs.writeFileSync(path.join(repo, 'tracked'), 'base'); git(['add', '.']); git(['commit', '-qm', 'base']);
  git(['worktree', 'add', '-b', 'lane/topic', lane]);
  fs.writeFileSync(path.join(lane, 'tracked'), 'unique'); git(['commit', '-am', 'unique'], lane);
  const head = git(['rev-parse', 'HEAD'], lane), common = path.join(repo, '.git');
  if (merged) git(['merge', '--ff-only', head]);
  const herdr = path.join(root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}\nconsole.log(JSON.stringify({result:{workspaces:[],agents:[],panes:[],tabs:[]}}));\n`, { mode: 0o755 });
  env.HERDR_RETIRE_HERDR = herdr;
  fs.writeFileSync(path.join(org, 'events.jsonl'), '');
  const config = path.join(root, 'lane.json'); fs.writeFileSync(config, JSON.stringify({ main: 'main', validate: 'true', worktree_root: root })); env.LANE_CONFIG = config;
  const close = ({ preload, gitOnly = true } = {}) => spawnSync(process.execPath,
    [...(preload ? ['--import', preload] : []), cli, 'close', 'topic', ...(gitOnly ? ['--git-only'] : [])], { cwd: repo, env, encoding: 'utf8' });
  const kept = r => { assert.notEqual(r.status, 0, r.stdout); assert.ok(fs.existsSync(lane)); assert.equal(git(['rev-parse', 'lane/topic']), head); assert.match(git(['worktree', 'list', '--porcelain']), /branch refs\/heads\/lane\/topic/); };
  const evidence = () => {
    fs.mkdirSync(path.join(lane, '.lane', 'empty'), { recursive: true });
    fs.writeFileSync(path.join(lane, '.lane', 'scratch\n.bin'), Buffer.from([0, 1, 255, 4]));
    fs.symlinkSync('scratch\n.bin', path.join(lane, '.lane', 'link'));
  };
  const receipt = r => r.stdout.split('\n').filter(l => l.startsWith('{')).map(JSON.parse).find(row => row.action === 'lane-preflight');
  return { root, repo, lane, org, common, env, git, head, close, kept, evidence, receipt };
}

for (const gitOnly of [true, false]) test(`lane removal ${gitOnly ? 'git-only' : 'normal'} preserves bytes, symlinks and exact archive tip`, t => {
  const f = fixture(t); f.evidence();
  const r = f.close({ gitOnly }); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(fs.existsSync(f.lane), false); assert.equal(f.git(['rev-parse', 'archive/lane/topic']), f.head);
  const proof = f.receipt(r), manifest = fs.readFileSync(proof.evidence.manifest);
  assert.equal(createHash('sha256').update(manifest).digest('hex'), proof.evidence.sha256);
  const archived = path.join(proof.evidence.directory, 'files', '.lane');
  assert.deepEqual(fs.readFileSync(path.join(archived, 'scratch\n.bin')), Buffer.from([0, 1, 255, 4]));
  assert.equal(fs.readlinkSync(path.join(archived, 'link')), 'scratch\n.bin'); assert.ok(fs.statSync(path.join(archived, 'empty')).isDirectory());
  assert.equal(JSON.parse(manifest).entries.find(e => e.type === 'file').sha256, createHash('sha256').update(Buffer.from([0, 1, 255, 4])).digest('hex'));
});

test('archive tag collision refuses before worktree removal; matching durable tag allows retry', t => {
  const f = fixture(t); f.evidence(); f.git(['tag', 'archive/lane/topic', 'main']);
  const r = f.close(); f.kept(r); assert.match(r.stderr, /archive tag collision/);
  assert.equal(f.git(['rev-parse', 'archive/lane/topic']), f.git(['rev-parse', 'main']));
  assert.ok(fs.existsSync(path.join(f.lane, '.lane/scratch\n.bin')));
  f.git(['tag', '-d', 'archive/lane/topic']); f.git(['tag', 'archive/lane/topic', f.head]);
  const retry = f.close(); assert.equal(retry.status, 0, retry.stdout + retry.stderr);
  assert.equal(f.git(['rev-parse', 'archive/lane/topic']), f.head);
});

for (const mode of ['failed', 'mismatched', 'source-changed', 'manifest-changed']) test(`a ${mode} evidence copy keeps the complete lane`, t => {
  const f = fixture(t); f.evidence(); const preload = path.join(f.root, 'fault.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';
const copy=fs.copyFileSync, write=fs.writeFileSync;
fs.copyFileSync=(source,target,...args)=>{
 if(!target.includes('/lane-archive/'))return copy(source,target,...args);
 ${mode === 'failed' ? "throw Error('injected evidence copy failure');" : "copy(source,target,...args);"}
 ${mode === 'mismatched' ? "write(target,'corrupted');" : ''}
 ${mode === 'source-changed' ? "write(source,'changed during copy');" : ''}
};
${mode === 'manifest-changed' ? "const read=fs.readFileSync;fs.readFileSync=(file,...args)=>{if(String(file).endsWith('/sha256.json'))write(file,'{}');return read(file,...args);};" : ''}
`);
  const r = f.close({ preload }); f.kept(r); assert.match(r.stderr, /evidence|copy|hash|inventory/);
  assert.equal(f.git(['rev-parse', 'archive/lane/topic']), f.head);
});

test('archive durability fresh-read mismatch keeps the lane before deletion', t => {
  const f = fixture(t), preload = path.join(f.root, 'fault.mjs'); f.evidence();
  fs.writeFileSync(preload, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const run=cp.spawnSync;let created=false;
cp.spawnSync=(exe,args,...rest)=>{const r=run(exe,args,...rest);if(exe==='git'&&args.includes('tag')&&args.includes('archive/lane/topic')&&!args.includes('--list'))created=true;
 if(created&&exe==='git'&&args.includes('refs/tags/archive/lane/topic^{commit}'))return {...r,stdout:'${'f'.repeat(40)}\\n'};return r;};syncBuiltinESMExports();\n`);
  const r = f.close({ preload }); f.kept(r); assert.match(r.stderr, /tag durability/);
});

for (const operation of ['openSync', 'unlinkSync', 'rmdirSync']) test(`Git metadata ${operation} refusal leaves directory, registration and branch intact`, t => {
  const f = fixture(t), preload = path.join(f.root, 'fault.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';const original=fs.${operation};fs.${operation}=(file,...args)=>{if(String(file).includes('/.git/worktrees/'))throw Object.assign(Error('injected EPERM metadata'),{code:'EPERM'});return original(file,...args);};\n`);
  const r = f.close({ preload }); f.kept(r); assert.match(r.stderr, /Git metadata preflight failed.*EPERM/);
  assert.equal(f.git(['tag', '--list', 'archive/lane/topic']), '');
});

test('a process outside Herdr with a cwd below the lane prevents removal', async t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.lane, '.lane')); const ready = path.join(f.root, 'ready');
  const child = spawnChild(t, process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`], { cwd: path.join(f.lane, '.lane'), env: f.env });
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(ready)) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 20)); }
  const r = f.close(); f.kept(r); assert.match(r.stderr, /process cwd reference/);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
  assert.equal(f.git(['tag', '--list', 'archive/lane/topic']), '');
  child.kill(); await waitForExit(child);
});

test('a parked design chain requires explicit record disposition despite an archived tip', t => {
  const f = fixture(t); f.evidence(); f.git(['tag', 'archive/lane/topic', f.head]);
  const events = [
    { type: 'item.added', id: 'DES-1', role: 'architect', title: 'Intentionally parked design' },
    { type: 'run.started', id: 'R-1', item: 'DES-1', workspace: f.lane },
    { type: 'report.ingested', run: 'R-1', report: { outcome: 'done', summary: 'Design complete; parked for later.' } },
  ].map((e, i) => ({ ...e, seq: i + 1, at: '2000-01-01T00:00:00Z', by: 'test' }));
  const record = path.join(f.org, 'events.jsonl'), bytes = events.map(e => JSON.stringify(e) + '\n').join(''); fs.writeFileSync(record, bytes);
  const r = f.close(); f.kept(r); assert.match(r.stderr, /chain is still open/); assert.equal(fs.readFileSync(record, 'utf8'), bytes);
  fs.appendFileSync(record, JSON.stringify({ type: 'item.closed', id: 'DES-1', as: 'dropped', seq: 4, at: '2026-01-01T00:00:00Z', by: 'test' }) + '\n');
  const done = f.close(); assert.equal(done.status, 0, done.stdout + done.stderr);
});

test('cwd source failures and incomplete observations refuse instead of claiming vacancy', () => {
  assert.throws(() => readLaneCwdReferences('/lane', { platform: 'darwin', command: () => ({ status: 1, stdout: '', stderr: 'denied' }) }), /unavailable/);
  assert.throws(() => readLaneCwdReferences('/lane', { platform: 'darwin', command: () => ({ status: 0, stdout: 'p999\0\nn/lane\0\n' }) }), /omitted its caller/);
  const refs = readLaneCwdReferences('/lane', { platform: 'darwin', command: () => ({ status: 0, stdout: `p${process.pid}\0\nn/elsewhere\0\np999\0\nn/lane/child\0\n` }) });
  assert.equal(refs.length, 1); assert.equal(refs[0].cwd, '/lane/child');
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) test(`hidden tracked changes under ${flag} keep the lane and their unique bytes`, t => {
  const f = fixture(t, { merged: true }); f.git(['update-index', flag, 'tracked'], f.lane);
  fs.writeFileSync(path.join(f.lane, 'tracked'), 'unique hidden local content');
  assert.equal(f.git(['status', '--porcelain'], f.lane), '');
  const r = f.close(); f.kept(r); assert.match(r.stderr, /index flags/);
  assert.equal(fs.readFileSync(path.join(f.lane, 'tracked'), 'utf8'), 'unique hidden local content');
});

for (const lock of ['refs/heads/lane/topic.lock', 'packed-refs.lock']) test(`an existing Git writer lock ${lock} refuses before directory deletion`, t => {
  const f = fixture(t, { merged: true }), file = path.join(f.common, lock); fs.writeFileSync(file, 'writer lock');
  const r = f.close(); f.kept(r); assert.match(r.stderr, /Git metadata preflight failed.*EEXIST/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'writer lock');
});

test('packed branch refs retain recovery and can close safely', t => {
  const f = fixture(t); f.git(['pack-refs', '--all', '--prune']);
  const r = f.close(); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.git(['rev-parse', 'archive/lane/topic']), f.head); assert.equal(fs.existsSync(f.lane), false);
});

test('branch-only close also goes through archive and metadata preflight', t => {
  const f = fixture(t); f.git(['worktree', 'remove', f.lane]);
  const r = f.close(); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(f.git(['rev-parse', 'archive/lane/topic']), f.head);
  assert.ok(r.stdout.includes('lane-removed'));
});

test('CLI lane close survives unrelated native state churn and record appends during every observation', t => {
  const f = fixture(t), counter = path.join(f.root, 'observations');
  fs.writeFileSync(f.env.HERDR_RETIRE_HERDR, `#!${process.execPath}
const fs=require('node:fs'),a=process.argv.slice(2),counter=${JSON.stringify(counter)};
if(a[0]==='agent'&&a[1]==='list'){
 const n=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8'))+1:1;fs.writeFileSync(counter,String(n));
 fs.appendFileSync(${JSON.stringify(path.join(f.org, 'events.jsonl'))},JSON.stringify({type:'item.added',id:'ENG-'+n,role:'engineer',seq:n,at:'2026-01-01T00:00:00Z',by:'fixture'})+'\\n');
 console.log(JSON.stringify({result:{agents:[{name:'unrelated',cwd:${JSON.stringify(path.join(f.root, 'other'))},workspace_id:'other',pane_id:'other:p',agent_status:n%2?'working':'idle',state_change_seq:n}]}}));
}else console.log(JSON.stringify({result:{workspaces:[],panes:[],tabs:[]}}));
`, { mode: 0o755 });
  const r = f.close(); assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(Number(fs.readFileSync(counter, 'utf8')) >= 2, 'native state changed across fresh observations');
  assert.match(r.stdout, /lane-removed/); assert.doesNotMatch(r.stdout + r.stderr, /authority changed since lane removal plan/);
  assert.equal(fs.existsSync(f.lane), false); assert.equal(f.git(['rev-parse', 'archive/lane/topic']), f.head);
});

test('lane evidence reference scanning also skips stray non-JSON entries without deleting them', t => {
  const f = fixture(t), directory = path.join(f.org, 'references');
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\nnode_modules/\n');
  fs.mkdirSync(path.join(f.lane, 'node_modules')); fs.writeFileSync(path.join(f.lane, 'node_modules/generated'), 'disposable');
  fs.mkdirSync(path.join(directory, '.claude'), { recursive: true });
  for (const name of ['notes.txt', '.hidden.json']) fs.writeFileSync(path.join(directory, name), '{');
  const before = fs.readdirSync(directory).sort(), r = f.close();
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.equal(fs.existsSync(f.lane), false);
  assert.deepEqual(fs.readdirSync(directory).sort(), before);
});

for (const kind of ['symlink', 'directory']) test(`a ${kind} JSON reference blocks both evidence scanning and CLI lane removal`, t => {
  const f = fixture(t), directory = path.join(f.org, 'references'), file = path.join(directory, 'x.json');
  fs.mkdirSync(directory);
  fs.appendFileSync(path.join(f.common, 'info/exclude'), '\nnode_modules/\n');
  fs.mkdirSync(path.join(f.lane, 'node_modules')); fs.writeFileSync(path.join(f.lane, 'node_modules/generated'), 'disposable');
  const tracked = new Set(f.git(['ls-files', '-z'], f.lane).split('\0').filter(Boolean));
  assert.equal(measureLaneEvidence({ lane: f.lane, tracked, env: f.env }).bytes, 0, 'the evidence scan reaches and accepts the empty reference directory');
  if (kind === 'symlink') {
    fs.writeFileSync(path.join(directory, '.target.json'), JSON.stringify({ schema: 'herdr-reference/v1',
      owner: 'fixture', kind: 'pending job', job: 'job', state: 'pending', item: 'ENG-1', cwd: f.lane,
      created_at: '2026-01-01T00:00:00Z', expires_at: '9999-01-01T00:00:00Z' }));
    fs.symlinkSync('.target.json', file);
  } else fs.mkdirSync(file);
  assert.throws(() => measureLaneEvidence({ lane: f.lane, tracked, env: f.env }), /evidence\/reference claims unavailable; lane kept/);
  const r = f.close(); f.kept(r); assert.match(r.stderr, /reference is not a regular JSON file; project kept/);
  assert.equal(fs.lstatSync(file).isSymbolicLink(), kind === 'symlink');
  assert.equal(fs.lstatSync(file).isDirectory(), kind === 'directory');
});

test('a Git index writer lock keeps the worktree, branch and lock intact', t => {
  const f = fixture(t, { merged: true });
  const metadata = f.git(['rev-parse', '--absolute-git-dir'], f.lane), lock = path.join(metadata, 'index.lock');
  fs.writeFileSync(lock, 'busy index writer');
  const r = f.close(); f.kept(r); assert.match(r.stderr, /locked Git metadata/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'busy index writer');
});

test('resuming an archived lane, promoting and closing preserves the old tag byte for byte', t => {
  const f = fixture(t), first = f.close(); assert.equal(first.status, 0, first.stdout + first.stderr);
  f.git(['tag', '-f', '-a', 'archive/lane/topic', '-m', 'Original recoverable archive', f.head]);
  const tagFile = path.join(f.common, 'refs/tags/archive/lane/topic'), tagBytes = fs.readFileSync(tagFile);
  const tagObject = f.git(['cat-file', '-p', 'archive/lane/topic']);
  const run = args => {
    const r = spawnSync(process.execPath, [cli, ...args], { cwd: f.repo, env: f.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr); return r;
  };
  f.env.LANE_WORKTREE_ROOT = f.root;
  run(['open', 'topic', 'archive/lane/topic', '--git-only']);
  const resumed = path.join(f.root, 'lane-topic'); assert.equal(f.git(['rev-parse', 'HEAD'], resumed), f.head);
  fs.writeFileSync(path.join(resumed, 'tracked'), 'resumed work'); f.git(['commit', '-am', 'resume archived lane'], resumed);
  const tip = f.git(['rev-parse', 'HEAD'], resumed); assert.notEqual(tip, f.head);
  run(['promote', 'topic']); assert.equal(f.git(['rev-parse', 'main']), tip);
  run(['close', 'topic', '--git-only', '--expected-tip', tip]);
  assert.equal(fs.existsSync(resumed), false); assert.equal(f.git(['branch', '--list', 'lane/topic']), '');
  assert.deepEqual(fs.readFileSync(tagFile), tagBytes); assert.equal(f.git(['cat-file', '-p', 'archive/lane/topic']), tagObject);
});

test('the default evidence budget refuses oversized content before payload reads, copying or Git changes', t => {
  const f = fixture(t), size = 256 * 1024 * 1024 + 1;
  fs.mkdirSync(path.join(f.lane, '.lane')); const large = path.join(f.lane, '.lane/large-output');
  fs.writeFileSync(large, ''); fs.truncateSync(large, size);
  const refs = f.git(['for-each-ref', '--format=%(refname) %(objectname)']);
  const registration = f.git(['worktree', 'list', '--porcelain']);
  const preload = path.join(f.root, 'no-large-read.mjs');
  fs.writeFileSync(preload, `import fs from 'node:fs';const read=fs.readFileSync,open=fs.openSync;fs.openSync=(file,...args)=>{if(file===${JSON.stringify(large)})throw Error('oversized evidence payload must not be read');return open(file,...args);};fs.readFileSync=(file,...args)=>{if(file===${JSON.stringify(large)})throw Error('oversized evidence payload must not be read');return read(file,...args);};\n`);
  const r = f.close({ preload }); f.kept(r);
  assert.match(r.stderr, /evidence size 268435457 bytes exceeds budget 268435456 bytes; explicit disposition is required/);
  assert.ok(r.stdout.split('\n').filter(l => l.startsWith('{')).map(JSON.parse).some(row => row.action === 'keep' && /explicit disposition/.test(row.why)));
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false);
  assert.equal(f.git(['for-each-ref', '--format=%(refname) %(objectname)']), refs);
  assert.equal(f.git(['worktree', 'list', '--porcelain']), registration); assert.equal(fs.statSync(large).size, size);
});

test('the optional evidence budget measures the total and allows a verified copy at the exact limit', t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.lane, '.lane'));
  fs.writeFileSync(path.join(f.lane, '.lane/first'), Buffer.alloc(20, 1)); fs.writeFileSync(path.join(f.lane, '.lane/second'), Buffer.alloc(20, 2));
  f.env.LANE_EVIDENCE_MAX_BYTES = '32'; const refs = f.git(['for-each-ref', '--format=%(refname) %(objectname)']);
  const kept = f.close(); f.kept(kept); assert.match(kept.stderr, /evidence size 40 bytes exceeds budget 32 bytes; explicit disposition is required/);
  assert.equal(fs.existsSync(path.join(f.common, 'lane-archive')), false); assert.equal(f.git(['for-each-ref', '--format=%(refname) %(objectname)']), refs);
  f.env.LANE_EVIDENCE_MAX_BYTES = '40'; const closed = f.close(); assert.equal(closed.status, 0, closed.stdout + closed.stderr);
  const saved = path.join(f.receipt(closed).evidence.directory, 'files/.lane');
  assert.deepEqual(fs.readFileSync(path.join(saved, 'first')), Buffer.alloc(20, 1)); assert.deepEqual(fs.readFileSync(path.join(saved, 'second')), Buffer.alloc(20, 2));
  assert.equal(f.git(['rev-parse', 'archive/lane/topic']), f.head); assert.equal(fs.existsSync(f.lane), false);
});
