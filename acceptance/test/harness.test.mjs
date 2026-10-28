import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { composerEmpty } from '../../supervisor/composer.mjs';
import { harnessEnvironment, abandonWatcher } from '../run.mjs';
import { pollNative } from '../poll.mjs';
import { cleanupInboxes } from '../cleanup.mjs';
import { acquireHostTestSlot } from '../../test-slot/test-slot.mjs';
import { createLoadMonitor, LoadTimeout } from '../load.mjs';
import { cases, runCase } from '../cases.mjs';
import { createHash } from 'node:crypto';
import { liveKeys, freshLiveKeys, liveContinuation, validateLiveSummary } from '../../lib/live-coverage.mjs';

test('live continuation retains only bound completed passes and requires fresh scope plus real failed-case proof', () => {
  assert.deepEqual(liveKeys, Object.values(cases).filter(c => c !== cases.tools).map(c => c.key));
  const sha = value => createHash('sha256').update(value).digest('hex');
  const prior = { candidateCommit: 'a'.repeat(40), evidence: '/owned/original/evidence', results: liveKeys.map((key, i) =>
    ({ id: String(i + 1).padStart(2, '0'), key, status: key === 'housekeeping' ? 'FAIL' : 'PASS', evidence: `${i + 1}.jsonl`, detail: 'Actual original observation' })) };
  const priorBytes = JSON.stringify(prior), base = { schema: 'release-live-coverage/v1', commit: 'b'.repeat(40), tree: 'c'.repeat(40),
    sourceCommit: prior.candidateCommit, keys: liveKeys, complete: true, unresolved: [], rerun: [...freshLiveKeys, 'housekeeping'],
    prior: { inputBase64: Buffer.from(priorBytes).toString('base64'), sha256: sha(priorBytes) },
    reconciliation: Object.fromEntries(['source', 'runner', 'environment', 'dependencies', 'cleanup'].map(k => [k, `Explicit actual ${k} compatibility disposition for the retained cases.`])) };
  const signed = value => JSON.stringify({ ...value, attestationDigest: sha(JSON.stringify(value)), attestationSeq: 1 });
  const verify = value => liveContinuation(signed(value), { commit: base.commit, tree: base.tree });
  const plan = verify(base); assert.equal(plan.retained.length, 13);
  assert.throws(() => verify({ ...base, rerun: freshLiveKeys }), /red, pending or skipped/);
  assert.throws(() => verify({ ...base, rerun: base.rerun.filter(k => k !== 'operator-focus') }), /fresh scope/);
  assert.throws(() => verify({ ...base, sourceCommit: 'd'.repeat(40) }), /source changed/);
  assert.throws(() => verify({ ...base, unresolved: ['unverified correction'] }), /incomplete/);
  assert.throws(() => verify({ ...base, prior: { ...base.prior, sha256: '0'.repeat(64) } }), /mismatched/);
  const results = prior.results.map(r => plan.rerun.has(r.key) ? { ...r, status: 'PASS' } :
    { ...r, evidence: path.join(prior.evidence, r.evidence), retained: { sha256: base.prior.sha256, commit: prior.candidateCommit, key: r.key } });
  const summary = { candidateCommit: base.commit, ready: true, results, liveCoverage: { kind: 'supervisor-reconciled-live-coverage',
    sha256: plan.sha256, inputBase64: plan.inputBase64 } };
  validateLiveSummary(summary);
  const tampered = structuredClone(summary); tampered.results[1].detail = 'Invented replacement';
  assert.throws(() => validateLiveSummary(tampered), /retained result changed/);
  const skipped = structuredClone(summary); skipped.results[12].retained = results[1].retained;
  assert.throws(() => validateLiveSummary(skipped), /fresh required case retained/);
  const notRun = structuredClone(summary); notRun.results[12].status = 'SKIP';
  assert.throws(() => validateLiveSummary(notRun), /fresh case is not PASS/);
});

const source = path.resolve(import.meta.dirname, '../..');
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-harness-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const until = async fn => {
  const end = Date.now() + 10000;
  while (!fn()) { assert.ok(Date.now() < end, 'fixture ready'); await new Promise(r => setTimeout(r, 20)); }
};

test('the real scripted supervisor presents an empty composer before publishing idle and after each notice', async t => {
  const root = scratch(t);
  for (const file of ['worker.mjs', 'producers.mjs', 'environment.mjs']) fs.copyFileSync(path.join(source, 'acceptance', file), path.join(root, file));
  fs.copyFileSync(path.join(source, 'lib/deadline.mjs'), path.join(root, 'deadline.mjs'));
  fs.writeFileSync(path.join(root, 'herdr.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(path.join(root, 'worker-environment.json'))},JSON.stringify(process.env));fs.appendFileSync(${JSON.stringify(path.join(root, 'states'))},process.argv.join(' ')+'\\n');console.log('{"result":{}}');`);
  const child = spawnChild(t, process.execPath, [path.join(root, 'worker.mjs'), root, 'supervisor', 'offline-supervisor'],
    { env: { ...process.env, HERDR_PANE_ID: 'owned:pane' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', bytes => { output += bytes; });
  await until(() => fs.existsSync(path.join(root, 'script-panes/owned:pane')));
  const workerEnv = JSON.parse(fs.readFileSync(path.join(root, 'worker-environment.json'), 'utf8'));
  assert.equal(workerEnv.HERDR_MONITOR_FLEET, path.join(root, 'f'));
  assert.equal(workerEnv.HOME, path.join(root, 'home'));
  assert.equal(workerEnv.CODEX_HOME, path.join(root, 'home/.codex'));
  assert.equal(composerEmpty(output, 'codex'), true, output);
  child.stdin.write('[org-report] run=R-1 report=/scratch/report\n');
  await until(() => output.includes('[org-report]'));
  await until(() => fs.readFileSync(path.join(root, 'states'), 'utf8').match(/--state idle/g)?.length === 2);
  assert.equal(composerEmpty(output, 'codex'), true, output);
  child.kill('SIGTERM'); assert.equal((await waitForExit(child)).code, 0);
});

test('the scripted agent launch has a real Codex executable identity without starting a model', t => {
  const root = scratch(t), binary = path.join(root, 'native.mjs');
  for (const file of ['herdr.mjs', 'receipts.mjs', 'producers.mjs', 'environment.mjs', 'poll.mjs'])
    fs.copyFileSync(path.join(source, 'acceptance', file), path.join(root, file));
  fs.copyFileSync(path.join(source, 'lib/deadline.mjs'), path.join(root, 'deadline.mjs'));
  fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ binary, workspaces: ['owned'], panes: ['owned:pane'], tabs: [] }));
  const observed = path.join(root, 'worker-observed.json');
  fs.writeFileSync(path.join(root, 'worker.mjs'), `import fs from 'node:fs';
    import {lookupProcess} from ${JSON.stringify(path.join(source, 'lib/processes.mjs'))};
    fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({executable:process.execPath,node:process.versions.node,
      args:process.argv.slice(2),process:lookupProcess(process.pid,{identityOnly:true})}));`);
  fs.writeFileSync(binary, `#!${process.execPath}
    import {spawnSync} from 'node:child_process';const a=process.argv.slice(2);let result={};
    if(a[0]==='pane'&&a[1]==='get')result={pane:{pane_id:'owned:pane',workspace_id:'owned',foreground_cwd:${JSON.stringify(root)}}};
    if(a[0]==='pane'&&a[1]==='run'){
      const r=spawnSync('/bin/sh',['-c',a[3]],{encoding:'utf8'});
      if(r.status!==0){console.error(r.stderr);process.exit(1);}
    }
    if(a[0]==='agent')result=a[1]==='list'?{agents:[{pane_id:'owned:pane',agent_status:'idle'}]}:{agent:{pane_id:'owned:pane',agent_status:'idle'}};
    console.log(JSON.stringify({result}));`, { mode: 0o755 });
  const reply = spawnSync(process.execPath, [path.join(root, 'herdr.mjs'), 'agent', 'start', 'offline-worker', '--kind', 'codex', '--pane', 'owned:pane'],
    { env: { ...process.env, ACCEPTANCE_ROOT: root }, encoding: 'utf8', timeout: 15000 });
  assert.equal(reply.status, 0, reply.stdout + reply.stderr);
  const worker = JSON.parse(fs.readFileSync(observed));
  assert.equal(worker.executable, path.join(root, 'script-runtime/codex'));
  assert.equal(worker.node, process.versions.node);
  assert.deepEqual(worker.args, [root, 'worker', 'offline-worker']);
  assert.equal(worker.process.ok, true, worker.process.error);
  assert.equal(worker.process.value.command, '[codex]', 'the native process reader sees the registered agent kind');
});

test('scratch promotion inherits the actual gate slot while project and session metadata are scrubbed', async t => {
  const root = scratch(t);
  const inherited = { ...process.env, MONITOR_TEST_SLOT_PATH: path.join(root, 'slot'), MONITOR_TEST_SLOT_COMPAT_PATH: path.join(root, 'compat'),
    ORG_DIR: '/foreign/record', HERDR_PANE_ID: 'foreign:pane', MONITOR_ENTRY: 'foreign',
    SE_ROOT: '/foreign/project', SE_LOCK_PORT: '47391', NW_OUTBOX: '/foreign/outbox', NW_WAITERS: '/foreign/waiters' };
  const slot = await acquireHostTestSlot('offline gate', { env: inherited });
  t.after(slot.release);
  inherited.MONITOR_TEST_SLOT_TOKEN = slot.token;
  inherited.BCH_CLOAK_TEST_SLOT_TOKEN = slot.token;
  const env = harnessEnvironment(inherited, root);
  assert.equal(env.ORG_DIR, undefined); assert.equal(env.HERDR_PANE_ID, undefined); assert.equal(env.MONITOR_ENTRY, undefined);
  for (const key of ['SE_ROOT', 'SE_LOCK_PORT', 'NW_OUTBOX', 'NW_WAITERS']) assert.equal(env[key], undefined);
  const code = `import {acquireHostTestSlot} from ${JSON.stringify(path.join(source, 'test-slot/test-slot.mjs'))};const slot=await acquireHostTestSlot('nested promotion');console.log(slot.nested);slot.release();`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout.trim(), 'true');
  assert.ok(fs.existsSync(inherited.MONITOR_TEST_SLOT_PATH));
});

for (const failure of [false, true]) test(`native polling preserves ${failure ? 'actual read errors' : 'late completion'} beyond its former allowance`, async () => {
  let now = 0; const deadlines = [];
  const pending = pollNative(async deadline => {
    deadlines.push(deadline); now += 80;
    if (deadlines.length < 3) return false;
    if (failure) throw Error('actual native read refused');
    return true;
  }, 'stand-in did not register', 100, { now: () => now, allowance: ms => ms, sleep: async ms => { now += ms; }, intervalMs: 10 });
  if (failure) await assert.rejects(pending, /actual native read refused/);
  else assert.equal(await pending, true);
  assert.deepEqual(deadlines, [undefined, undefined, undefined]); assert.equal(now, 260);
});

test('harness cleanup stops only verified inbox owners under its scratch root and retains receipts', async t => {
  const root = scratch(t), candidate = path.join(root, 'candidate'), org = path.join(root, 'record');
  const script = path.join(candidate, 'supervisor/prompt-supervisor.mjs'), file = path.join(org, 'supervisor/inbox.log');
  fs.mkdirSync(path.dirname(script), { recursive: true }); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(script, `import fs from 'node:fs';const file=process.argv[process.argv.indexOf('--inbox')+1];fs.mkdirSync(file+'.owner.lock');fs.writeFileSync(file+'.owner.lock/owner.json',JSON.stringify({pid:process.pid,argv:[process.execPath,...process.argv.slice(1)]}));setInterval(()=>{},1000);`);
  const gitInbox = path.join(root, 'project/.git/supervisor/inbox.log');
  fs.mkdirSync(path.dirname(gitInbox), { recursive: true });
  const foreignRoot = scratch(t), foreignInbox = path.join(foreignRoot, 'inbox.log');
  const files = [file, gitInbox, foreignInbox];
  const children = files.map(file => spawnChild(t, process.execPath, [script, '--inbox', file, '--owner-worker', '--settings', '{}'], { detached: true }));
  await until(() => files.every(file => fs.existsSync(`${file}.owner.lock/owner.json`)));
  fs.symlinkSync(foreignRoot, path.join(root, 'foreign-alias'));
  fs.mkdirSync(path.join(root, 'alias-project/.git'), { recursive: true });
  fs.symlinkSync(foreignRoot, path.join(root, 'alias-project/.git/supervisor'));
  const evidence = path.join(root, 'evidence'); fs.mkdirSync(evidence);
  await cleanupInboxes({ root, candidate, evidence });
  for (const child of children.slice(0, 2)) assert.equal((await waitForExit(child)).signal, 'SIGKILL');
  assert.doesNotThrow(() => process.kill(children[2].pid, 0), 'symlinked foreign inbox owner must remain alive');
  children[2].kill('SIGTERM'); await waitForExit(children[2]);
  const receipts = JSON.parse(fs.readFileSync(path.join(evidence, 'inbox-cleanup.json')));
  assert.deepEqual(receipts.map(receipt => receipt.pid).sort(), children.slice(0, 2).map(child => child.pid).sort());
  for (const child of children.slice(0, 2)) assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});

test('product tidy preserves a focused finished tab while closing the same tab in the background', async () => {
  const { planTidy } = await import('../../supervisor/tidy-tabs.mjs');
  const snapshot = { common: '/repo/.git',
    workspaces: [{ workspace_id: 'lane', worktree: { checkout_path: '/repo/lane', repo_key: '/repo/.git', is_linked_worktree: true } }],
    git: [{ path: '/repo/lane', common: '/repo/.git', head: 'head', clean: true, integrated: true, lane: 'topic' }],
    record: { items: [{ id: 'ENG-1', role: 'engineer', closed: { as: 'done' } }],
      runs: [{ id: 'R-1', item: 'ENG-1', started: { seq: 1 }, workspace: '/repo/lane',
        meta: { agent: 'lane-worker', pane: 'worker:pane', worker_workspace: 'lane', terminal_id: 'terminal', lane: 'topic' },
        report: { seq: 2, outcome: 'done' } }] },
    tabs: [{ tab_id: 'worker', workspace_id: 'lane', lane: true, label: 'finished' }],
    panes: [{ pane_id: 'worker:pane', tab_id: 'worker', workspace_id: 'lane', shellOnly: true, focused: true,
      process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, name: 'zsh' }], process_tree_complete: true,
        process_tree: [{ pid: 1, identity: 'shell', state: 'S', command: '[zsh]' }] } }],
    agents: [{ name: 'lane-worker', status: 'idle', pane_id: 'worker:pane', tab_id: 'worker', workspace_id: 'lane',
      cwd: '/repo/lane', terminal_id: 'terminal' }],
    reportedAgents: new Set(['lane-worker']) };
  assert.deepEqual(planTidy(snapshot).close, []);
  snapshot.panes[0].focused = false;
  assert.equal(planTidy(snapshot).close.length, 1);
  snapshot.record.runs[0].report = null;
  assert.deepEqual(planTidy(snapshot).close, [], 'the legacy name set never substitutes for ingestion');
});

for (const phase of ['cwd', 'registration']) test(`the real adapter accepts a productive slow ${phase} native read beyond its planning allowance`, t => {
  const root = scratch(t), binary = path.join(root, 'native.mjs');
  for (const file of ['herdr.mjs', 'receipts.mjs', 'producers.mjs', 'environment.mjs', 'poll.mjs'])
    fs.copyFileSync(path.join(source, 'acceptance', file), path.join(root, file));
  // Shrink only the two poll windows, independently of the per-call allowance.
  fs.writeFileSync(path.join(root, 'deadline.mjs'), 'export const loadTimeout=ms=>[5000,6000].includes(ms)?1500:ms;');
  fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ binary, workspaces: ['owned'], panes: ['owned:pane'], tabs: [] }));
  fs.writeFileSync(binary, `#!${process.execPath}
    import fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(path.join(root, 'calls'))},JSON.stringify(a)+'\\n');
    if((a[0]==='pane'&&a[1]==='get'&&${JSON.stringify(phase)}==='cwd')||(a[0]==='agent'&&a[1]==='get'&&${JSON.stringify(phase)}==='registration'))await new Promise(r=>setTimeout(r,4000));
    console.log(JSON.stringify({result:a[0]==='pane'&&a[1]==='get'?{pane:{foreground_cwd:${JSON.stringify(root)}}}:a[0]==='agent'?{agent:{agent_status:'idle',pane_id:'owned:pane'}}:{}}));`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.join(root, 'herdr.mjs'), 'agent', 'start', 'offline', '--pane', 'owned:pane'],
    { env: { ...process.env, ACCEPTANCE_ROOT: root }, encoding: 'utf8', timeout: 12000 });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.some(a => a[0]==='agent'&&a[1]==='rename'));
  assert.equal(calls.filter(a => a[0]===(phase==='cwd'?'pane':'agent')&&a[1]==='get').length, 1);
});


test('failure-path teardown holds the worker transition through delayed notice confirmation until watcher exit', async () => {
  let state = 'idle', abandoned = false, exited = false;
  const job = { run: 'R-2', pane: 'owned:pane', lane: 'missing', watcher: { log: '/scratch/watch.log' } };
  await abandonWatcher(job, {
    record: args => { assert.deepEqual(args.slice(0, 2), ['abandon', 'R-2']); abandoned = true; },
    h: (...args) => { state = args[args.indexOf('--state') + 1]; },
    read: () => { assert.equal(abandoned, true); return 'R-2 was abandoned; stopping'; },
    until: async (predicate, label) => {
      if (label === 'R-2 watcher exits') {
        assert.equal(state, 'idle');
        assert.equal(predicate(), false, 'the abandonment log precedes process exit');
        exited = true; assert.equal(predicate(), true); return;
      }
      // The watcher is still confirming its delivered notice. The transition
      // must remain observable when it later arms agent.wait --until working.
      for (let i = 0; i < 3; i++) { assert.equal(state, 'working'); await new Promise(resolve => setImmediate(resolve)); }
      assert.equal(predicate(), true);
    },
    alive: () => !exited,
  });
  assert.equal(exited, true); assert.equal(state, 'idle');
});
