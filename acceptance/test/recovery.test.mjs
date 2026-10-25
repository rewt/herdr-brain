import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { loadTimeout } from '../../lib/deadline.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';
import { cleanupWorkspaces } from '../cleanup.mjs';
import { saveCreationIntent } from '../receipts.mjs';
import { registerProducer } from '../producers.mjs';

const here = path.resolve(import.meta.dirname, '..');
function scratch(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-recovery-')));
  fs.mkdirSync(path.join(root, 'evidence'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const until = async predicate => {
  const deadline = Date.now() + loadTimeout(10_000);
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('fixture did not reach active creation');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};

// Interrupt the runner while its adapter's native call is ACTIVE. Native Herdr
// commits after receiving the signal and deliberately returns no JSON receipt.
// Cleanup must wait for that operation, recover its IDs, then close them.
for (const signal of ['SIGINT', 'SIGTERM']) for (const form of ['workspace', 'create-cwd', 'open-cwd', 'create-workspace', 'open-workspace']) {
  test(`${signal} drains an active ${form} and recovers its lost reply`, async t => {
    const root = scratch(t), binary = path.join(root, 'fake-herdr.mjs');
    const linked = path.join(root, 'linked');
    const existing = [
      { workspace_id: 'operator', label: 'Requested label', cwd: '/foreign' },
      { workspace_id: 'parent', label: 'Existing', cwd: '/existing-parent' },
    ];
    fs.writeFileSync(path.join(root, 'native.json'), JSON.stringify(existing));
    fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ binary, workspaces: ['parent'], panes: [], tabs: [] }));
    // Parent ownership is needed to authorize --workspace. Remove that already
    // owned fixture from the cleanup ledger after admission so its preservation
    // demonstrates baseline exclusion rather than fixture ownership.
    const args = form === 'workspace' ? ['workspace', 'create', '--cwd', root] :
      ['worktree', form.startsWith('create') ? 'create' : 'open', form.endsWith('cwd') ? '--cwd' : '--workspace',
        form.endsWith('cwd') ? root : 'parent', '--path', linked, '--label', 'Requested label'];
    fs.writeFileSync(binary, `#!${process.execPath}
      import fs from 'node:fs';
      const root=${JSON.stringify(root)},a=process.argv.slice(2),file=root+'/native.json';
      const rows=()=>JSON.parse(fs.readFileSync(file));
      if(a[0]==='workspace'&&a[1]==='list') console.log(JSON.stringify({result:{workspaces:rows()}}));
      else if(a[0]==='workspace'&&a[1]==='close') {
        if(['operator','parent'].includes(a[2])) throw Error('foreign/baseline workspace closed');
        fs.writeFileSync(file,JSON.stringify(rows().filter(r=>r.workspace_id!==a[2])));console.log('{"result":{}}');
      } else if(a[0]==='pane'&&a[1]==='list') console.log(JSON.stringify({result:{panes:[{pane_id:a[3]+':pane'}]}}));
      else if(a[0]==='pane'&&a[1]==='get') console.log(JSON.stringify({result:{pane:{pane_id:a[2],workspace_id:a[2].split(':')[0],foreground_cwd:${JSON.stringify(linked)}}}}));
      else {
        const intent=JSON.parse(fs.readFileSync(root+'/creation-intents.jsonl','utf8').trim());
        if(JSON.stringify(intent.args)!==JSON.stringify(a)) throw Error('intent not persisted before creation');
        const state=JSON.parse(fs.readFileSync(root+'/ownership.json'));state.workspaces=[];fs.writeFileSync(root+'/ownership.json',JSON.stringify(state));
        let ended=false;const finish=()=>{if(ended)return;ended=true;setTimeout(()=>{
          const added=[{workspace_id:'created',label:intent.label}];
          if(a.includes('--cwd')&&a[0]==='worktree') added.push({workspace_id:'implicit',label:'Main',cwd:root});
          fs.writeFileSync(file,JSON.stringify([...rows(),...added]));fs.writeFileSync(root+'/completed',String(Date.now()));process.exit(0);
        },200)};
        process.on('SIGINT',finish);process.on('SIGTERM',finish);
        fs.writeFileSync(root+'/active','yes');setInterval(()=>{},1000);
      }
    `, { mode: 0o755 });
    const code = `
      import fs from 'node:fs';import {spawn,spawnSync,execFileSync} from 'node:child_process';
      import {cleanupWorkspaces} from ${JSON.stringify(path.join(here, 'cleanup.mjs'))};
      import {installSignalCleanup} from ${JSON.stringify(path.join(here, 'signal-cleanup.mjs'))};
      const root=${JSON.stringify(root)},binary=${JSON.stringify(binary)};
      const child=spawn(process.execPath,[${JSON.stringify(path.join(here, 'herdr.mjs'))},...${JSON.stringify(args)}],{env:{...process.env,ACCEPTANCE_ROOT:root},stdio:'pipe'});
      child.stdout.resume();child.stderr.resume();
      installSignalCleanup({root,onSignal:signal=>child.kill(signal),cleanup:async()=>{
        const result=await cleanupWorkspaces({root,evidence:root+'/evidence',native:async a=>{
          if(!fs.existsSync(root+'/completed'))throw Error('inventory preceded producer completion');
          if(fs.readdirSync(root+'/producers').some(f=>f.endsWith('.json')))throw Error('inventory preceded producer drain');
          return JSON.parse(execFileSync(binary,a,{encoding:'utf8',timeout:${loadTimeout(10000)}})).result;
        }});
        if(result.errors.length)throw Error(result.errors.join(';'));
        const denied=spawnSync(process.execPath,[${JSON.stringify(path.join(here, 'herdr.mjs'))},'workspace','create','--cwd',root],{env:{...process.env,ACCEPTANCE_ROOT:root},encoding:'utf8',timeout:${loadTimeout(10000)}});
        if(denied.status===0||!denied.stderr.includes('producers stopped'))throw Error('late creation admitted');
      },summarize:s=>fs.writeFileSync(root+'/summary.json',JSON.stringify(s))});
      setInterval(()=>{},1000);
    `;
    const child = spawnChild(t, process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ORG_ACTOR: `eng107-r131-${form}-${signal}` } });
    await until(() => fs.existsSync(path.join(root, 'active')));
    child.kill(signal);
    const result = await waitForExit(child);
    assert.equal(result.code, signal === 'SIGINT' ? 130 : 143, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'summary.json'))).cleanupErrors, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'native.json'))), existing);
    const intent = JSON.parse(fs.readFileSync(path.join(root, 'creation-intents.jsonl')));
    assert.deepEqual(intent.before, ['operator', 'parent']);
    assert.ok(intent.paths.includes(form === 'workspace' ? root : linked));
    assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'evidence/producers-drained.json'))).at >= Number(fs.readFileSync(path.join(root, 'completed'))));
    const receipts = fs.readFileSync(path.join(root, 'creations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(receipts.some(row => row.targets.workspaces.includes('created')));
  });
}

test('cleanup refuses snapshots until every registered producer acknowledges stop', async t => {
  const root = scratch(t), producer = registerProducer(root, 'held-fixture');
  fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ workspaces: [], panes: [], tabs: [] }));
  let calls = 0;
  try {
    let finished = false;
    const pending = cleanupWorkspaces({ root, evidence: path.join(root, 'evidence'), native: () => { calls++; return { workspaces: [] }; }, producerTimeoutMs: 1 }).then(r => { finished = true; return r; });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(calls, 0);
    assert.equal(finished, false, 'an elapsed allowance cannot admit snapshots before actual producer drain');
    assert.throws(() => registerProducer(root, 'late'), /producers stopped/);
    producer.release();
    const result = await pending;
    assert.deepEqual(result.errors, []); assert.ok(calls > 0);
  } finally { producer.release(); }
});

test('cleanup reconciles again when a lost-reply workspace appears after the first inventory', async t => {
  const root = scratch(t);
  fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ workspaces: [], panes: [], tabs: [] }));
  saveCreationIntent(root, ['workspace', 'create', '--cwd', root], [], root);
  let lists = 0, closed = false;
  const result = await cleanupWorkspaces({ root, evidence: path.join(root, 'evidence'), native: async args => {
    if (args[1] === 'list') return { workspaces: ++lists === 1 || closed ? [] : [{ workspace_id: 'late', cwd: root }] };
    assert.deepEqual(args, ['workspace', 'close', 'late']); closed = true; return {};
  } });
  assert.deepEqual(result.errors, []); assert.equal(closed, true); assert.equal(lists, 3);
});

test('a matching caller label with a foreign native path never grants recovery authority', async t => {
  const root = scratch(t);
  fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ workspaces: [], panes: [], tabs: [] }));
  saveCreationIntent(root, ['workspace', 'create', '--cwd', root, '--label', 'Requested label'], [], root);
  const result = await cleanupWorkspaces({ root, evidence: path.join(root, 'evidence'), native: async args => {
    assert.equal(args[1], 'list');
    return { workspaces: [{ workspace_id: 'foreign', label: 'Requested label', cwd: '/foreign' }] };
  } });
  assert.deepEqual(result.owned.workspaces, []);
  assert.deepEqual(result.errors, []);
});

test('cleanup stops and awaits a supervisor executing dispatch before reading ownership', async t => {
  const root = scratch(t), binary = path.join(root, 'fake-herdr.mjs');
  fs.copyFileSync(path.join(here, '../lib/deadline.mjs'), path.join(root, 'deadline.mjs'));
  for (const file of ['worker.mjs', 'herdr.mjs', 'receipts.mjs', 'producers.mjs', 'environment.mjs', 'poll.mjs']) fs.copyFileSync(path.join(here, file), path.join(root, file));
  fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ binary, workspaces: [], panes: ['own:pane'], tabs: [] }));
  fs.writeFileSync(path.join(root, 'native.json'), '[]');
  fs.writeFileSync(binary, `#!${process.execPath}
    import fs from 'node:fs';const root=${JSON.stringify(root)},a=process.argv.slice(2),file=root+'/native.json';
    const rows=()=>JSON.parse(fs.readFileSync(file));let result={};
    if(a[0]==='workspace'&&a[1]==='list')result={workspaces:rows()};
    else if(a[0]==='workspace'&&a[1]==='close')fs.writeFileSync(file,JSON.stringify(rows().filter(r=>r.workspace_id!==a[2])));
    else if(a[0]==='pane'&&a[1]==='get')result={pane:{pane_id:a[2],workspace_id:'own',foreground_cwd:root}};
    else if(a[0]==='workspace'&&a[1]==='create') {
      const intent=JSON.parse(fs.readFileSync(root+'/creation-intents.jsonl','utf8').trim());
      fs.writeFileSync(root+'/active','yes');const timer=setInterval(()=>{
        if(!fs.existsSync(root+'/producers-stopping'))return;
        clearInterval(timer);setTimeout(()=>{
          fs.writeFileSync(file,JSON.stringify([{workspace_id:'created',label:intent.label}]));
          fs.writeFileSync(root+'/completed','yes');process.exit(0);
        },150);
      },25);
      await new Promise(()=>{});
    }
    console.log(JSON.stringify({result}));
  `, { mode: 0o755 });
  const candidate = path.join(root, 'candidate');
  for (const dir of ['supervisor', 'discovery', 'bin', 'dispatch']) fs.mkdirSync(path.join(candidate, dir), { recursive: true });
  fs.writeFileSync(path.join(candidate, 'discovery/client.mjs'), "console.log('{}');");
  fs.writeFileSync(path.join(candidate, 'supervisor/supervisor.mjs'), "console.log('Supervisor cold start');");
  fs.writeFileSync(path.join(candidate, 'bin/org.mjs'), `
    import fs from 'node:fs';
    if(process.argv[2]==='add')console.log('ENG-1');
    else if(process.argv[2]==='status')console.log('{}');
    else {fs.writeFileSync(${JSON.stringify(path.join(root, 'late-command'))},'forbidden');console.log('{}');}
  `);
  fs.writeFileSync(path.join(candidate, 'dispatch/dispatch.mjs'), `
    import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(path.join(root, 'dispatch-tmpdir'))}, process.env.TMPDIR ?? '');
    fs.writeFileSync(${JSON.stringify(path.join(root, 'dispatch-slot'))}, JSON.stringify({ token: process.env.MONITOR_TEST_SLOT_TOKEN, path: process.env.MONITOR_TEST_SLOT_PATH }));
    import {execFileSync} from 'node:child_process';
    execFileSync(process.execPath,[${JSON.stringify(path.join(root, 'herdr.mjs'))},'workspace','create','--cwd',${JSON.stringify(root)}],{env:{...process.env,ACCEPTANCE_ROOT:${JSON.stringify(root)}},timeout:${loadTimeout(10000)}});
    console.log('{"run":"R-1"}');
  `);
  fs.writeFileSync(path.join(root, 'test-slot-env.json'), JSON.stringify({ MONITOR_TEST_SLOT_TOKEN: 'gate-token', MONITOR_TEST_SLOT_PATH: path.join(root, 'gate-slot') }));
  fs.writeFileSync(path.join(root, 'default-supervisor-task.json'), JSON.stringify({ repo: root, home: root, binary: 'fake', ask: 'offline task' }));
  const child = spawnChild(t, process.execPath, [path.join(root, 'worker.mjs'), root, 'supervisor', 'offline-supervisor'], {
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HERDR_PANE_ID: 'own:pane', ORG_ACTOR: 'eng107-r131-supervisor' },
  });
  await until(() => fs.existsSync(path.join(root, 'script-panes/own:pane')));
  child.stdin.write('acceptance-default-cycle\n');
  await until(() => fs.existsSync(path.join(root, 'active')));
  assert.equal(fs.readFileSync(path.join(root, 'dispatch-tmpdir'), 'utf8'), root, 'supervisor dispatch must keep temporary environment files in scratch');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'dispatch-slot'))), { token: 'gate-token', path: path.join(root, 'gate-slot') }, 'PTY default dispatch must inherit the gate slot despite environment scrubbing');
  const workerReceipt = fs.readdirSync(path.join(root, 'producers')).filter(file => file.endsWith('.json'))
    .map(file => JSON.parse(fs.readFileSync(path.join(root, 'producers', file))))
    .find(receipt => receipt.pid === child.pid);
  assert.equal(workerReceipt.kind, 'script-supervisor');
  assert.equal(workerReceipt.children.length, 1, 'active dispatch child must be receipted');
  child.kill('SIGTERM');
  const result = await cleanupWorkspaces({ root, evidence: path.join(root, 'evidence'), native: async args => {
    assert.ok(fs.existsSync(path.join(root, 'completed')), 'native creation must finish first');
    assert.ok(fs.existsSync(path.join(root, 'default-supervisor-job.json')), 'supervisor must complete dispatch first');
    assert.equal(fs.readdirSync(path.join(root, 'producers')).some(file => file.endsWith('.json')), false,
      'supervisor must acknowledge stop before any cleanup snapshot');
    return JSON.parse(execFileSync(binary, args, { encoding: 'utf8' })).result;
  } });
  assert.equal((await waitForExit(child)).code, 0);
  assert.deepEqual(result.errors, []); assert.deepEqual(result.remaining, []);
  assert.equal(fs.existsSync(path.join(root, 'late-command')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'native.json'))), []);
});

test('stopping an individual idle PTY worker leaves the run admission barrier open', async t => {
  const root = scratch(t);
  fs.copyFileSync(path.join(here, '../lib/deadline.mjs'), path.join(root, 'deadline.mjs'));
  for (const file of ['worker.mjs', 'producers.mjs', 'environment.mjs']) fs.copyFileSync(path.join(here, file), path.join(root, file));
  fs.writeFileSync(path.join(root, 'herdr.mjs'), "console.log('{\"result\":{}}');");
  const child = spawnChild(t, process.execPath, [path.join(root, 'worker.mjs'), root, 'worker', 'offline-worker'], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HERDR_PANE_ID: 'owned:pane', ORG_ACTOR: 'eng107-r131-idle-worker' },
  });
  await until(() => fs.existsSync(path.join(root, 'script-panes/owned:pane')));
  child.kill('SIGTERM');
  assert.equal((await waitForExit(child)).code, 0);
  assert.equal(fs.existsSync(path.join(root, 'producers-stopping')), false);
  registerProducer(root, 'unrelated-worker').release();
});
