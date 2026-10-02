import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cleanupWorkspaces } from '../cleanup.mjs';
import { saveCreation, saveCreationIntent } from '../receipts.mjs';
import { spawnChild, waitForExit } from '../../test/helpers/child.mjs';

const adapter = path.resolve(import.meta.dirname, '../herdr.mjs');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-cleanup-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidence = path.join(root, 'evidence');
  fs.mkdirSync(evidence);
  fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ binary: 'fake', workspaces: [], panes: [], tabs: [] }));
  let rows = [{ workspace_id: 'operator', label: 'Keep me', cwd: '/foreign' }];
  const calls = [];
  const native = async args => {
    calls.push(args);
    if (args[1] === 'list') return { workspaces: [...rows] };
    assert.equal(args[0], 'workspace'); assert.equal(args[1], 'close');
    assert.notEqual(args[2], 'operator');
    rows = rows.filter(row => row.workspace_id !== args[2]);
    return {};
  };
  const add = id => rows.push({ workspace_id: id, label: id, cwd: root });
  const clean = extra => cleanupWorkspaces({ root, evidence, native, ...extra });
  return { root, evidence, add, clean, native, calls, rows: () => rows };
}
for (const mode of ['pass', 'fail']) test(`cleanup closes main and linked workspaces after ${mode}, including an unfurled creation receipt`, async t => {
  const f = fixture(t);
  f.add('main'); f.add('linked');
  saveCreation(f.root, ['workspace', 'create'], { workspace: { workspace_id: 'main' } });
  saveCreation(f.root, ['worktree', 'open'], { open_result: { workspace: { workspace_id: 'linked' } } });
  try { if (mode === 'fail') throw Error('injected case failure'); }
  catch {} finally {
    const result = await f.clean();
    assert.deepEqual(result.errors, []); assert.deepEqual(result.remaining, []);
  }
  assert.deepEqual(f.rows().map(row => row.workspace_id), ['operator']);
  assert.deepEqual(f.calls.filter(args => args[1] === 'close').map(args => args[2]), ['linked', 'main']);
});
test('failed inventory still attempts every owned receipt and audits the actual residue by ID and label', async t => {
  const f = fixture(t);
  for (const id of ['broken', 'closed']) { f.add(id); saveCreation(f.root, ['workspace', 'create'], { workspace: { workspace_id: id } }); }
  let lists = 0;
  const result = await f.clean({ native: args => {
    if (args[1] === 'list' && ++lists === 1) throw Error('inventory unavailable');
    if (args[1] === 'close' && args[2] === 'broken') throw Error('close refused');
    return f.native(args);
  } });
  assert.deepEqual(f.rows().map(row => row.workspace_id), ['operator', 'broken']);
  assert.ok(result.errors.some(error => error.includes('broken (broken)')));
  const audit = JSON.parse(fs.readFileSync(path.join(f.evidence, 'cleanup-residue.json')));
  assert.deepEqual(audit.workspaces.map(row => row.workspace_id), ['broken']);
  assert.ok(audit.after.some(row => row.workspace_id === 'operator'));
});
test('unreceipted scratch workspace is named by the raw audit without gaining closure authority', async t => {
  const f = fixture(t); f.add('lost-reply');
  const result = await f.clean();
  assert.ok(result.errors.some(error => error.includes('lost-reply')));
  assert.ok(!f.calls.some(args => args[1] === 'close'));
});
for (const shape of ['direct', 'nested']) test(`${shape} linked creation receipt survives a failed pane-layout read`, t => {
  const f = fixture(t), binary = path.join(f.root, 'fake-herdr');
  const receipt = { workspace: { workspace_id: 'linked' }, root_pane: { pane_id: 'linked:p1' }, tab: { tab_id: 'linked:t1' } };
  const value = shape === 'nested' ? { open_result: receipt } : receipt;
  fs.writeFileSync(binary, `#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='workspace'&&a[1]==='list'){console.log('{"result":{"workspaces":[]}}')}else if(a[0]==='worktree'){console.log(${JSON.stringify(JSON.stringify({ result: value }))});}else{console.error('injected layout failure');process.exit(1)}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(f.root, 'ownership.json'), JSON.stringify({ binary, workspaces: [], panes: [], tabs: [] }));
  const r = spawnSync(process.execPath, [adapter, 'worktree', 'create', '--cwd', f.root, '--path', path.join(f.root, 'linked'), '--no-focus'], {
    env: { ...process.env, ACCEPTANCE_ROOT: f.root, ORG_ACTOR: `eng107-layout-${shape}` }, encoding: 'utf8', timeout: 15000 });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /layout receipt unavailable/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'ownership.json'))).workspaces, ['linked']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'creations.jsonl'))).targets.workspaces, ['linked']);
});
test('cleanup recovers implicit main and linked workspaces from a confined creation intent when the reply is lost', async t => {
  const f = fixture(t);
  // Even an existing workspace at the same cwd must be retained.
  f.add('existing');
  saveCreationIntent(f.root, ['worktree', 'create', '--cwd', f.root, '--path', path.join(f.root, 'linked')], f.rows(), f.root);
  f.add('implicit-main'); f.add('linked');
  const result = await f.clean();
  assert.ok(result.errors.every(error => error.includes('existing')));
  assert.deepEqual(f.rows().map(row => row.workspace_id), ['operator', 'existing']);
  assert.deepEqual(result.owned.workspaces.sort(), ['implicit-main', 'linked']);
});
test('a malformed journal entry does not prevent closing other receipt-owned workspaces', async t => {
  const f = fixture(t); f.add('main');
  fs.writeFileSync(path.join(f.root, 'creations.jsonl'), '{bad json}\n');
  saveCreation(f.root, ['workspace', 'create'], { workspace: { workspace_id: 'main' } });
  const result = await f.clean();
  assert.deepEqual(f.rows().map(row => row.workspace_id), ['operator']);
  assert.ok(result.errors.some(error => error.includes('creation receipt line 1')));
});
for (const signal of ['SIGINT', 'SIGTERM']) test(`${signal} closes receipt-owned main and linked workspaces before emitting summary`, async t => {
  const f = fixture(t), module = path.resolve(import.meta.dirname, '../signal-cleanup.mjs'), cleanup = path.resolve(import.meta.dirname, '../cleanup.mjs');
  for (const id of ['main', 'linked']) { f.add(id); saveCreation(f.root, ['worktree', 'create'], { workspace: { workspace_id: id } }); }
  const code = `import fs from 'node:fs';import {installSignalCleanup} from ${JSON.stringify(module)};import {cleanupWorkspaces} from ${JSON.stringify(cleanup)};
    let rows=${JSON.stringify(f.rows())};let stopping=false;const root=${JSON.stringify(f.root)};
    installSignalCleanup({root,onSignal:()=>{stopping=true},cleanup:async()=>{if(!stopping)throw Error('work still authorized');const result=await cleanupWorkspaces({root,evidence:root+'/evidence',native:async a=>{if(a[1]==='list')return {workspaces:rows};if(a[2]==='operator')throw Error('foreign close');rows=rows.filter(r=>r.workspace_id!==a[2]);return {}}});if(result.errors.length)throw Error(result.errors.join(';'))},summarize:s=>fs.writeFileSync(root+'/summary.json',JSON.stringify({...s,rows}))});console.log('ready');setInterval(()=>{},1000);`;
  const child = spawnChild(t, process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ORG_ACTOR: `eng107-${signal}` } });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  child.kill(signal);
  assert.equal((await waitForExit(child)).code, signal === 'SIGINT' ? 130 : 143);
  const summary = JSON.parse(fs.readFileSync(path.join(f.root, 'summary.json')));
  assert.deepEqual(summary.cleanupErrors, []);
  assert.deepEqual(summary.rows.map(row => row.workspace_id), ['operator']);
});
test('adapter records the implicit main workspace as well as the explicit linked creation reply', t => {
  const f = fixture(t), binary = path.join(f.root, 'fake-herdr'), created = path.join(f.root, 'created');
  const before = { workspace_id: 'existing', worktree: { checkout_path: f.root } };
  const parent = { workspace_id: 'implicit-main', worktree: { checkout_path: f.root } };
  const linked = { workspace_id: 'linked', worktree: { checkout_path: path.join(f.root, 'linked') } };
  fs.writeFileSync(binary, `#!${process.execPath}
    const fs=require('fs'),a=process.argv.slice(2);let result={};
    if(a[0]==='workspace'&&a[1]==='list')result={workspaces:fs.existsSync(${JSON.stringify(created)})?${JSON.stringify([before,parent,linked])}:${JSON.stringify([before])}};
    else if(a[0]==='worktree'){fs.writeFileSync(${JSON.stringify(created)},'yes');result={workspace:${JSON.stringify(linked)}}}
    else if(a[1]==='list')result={[a[0]+'s']:[]};else process.exit(1);
    console.log(JSON.stringify({result}));
  `, { mode: 0o755 });
  fs.writeFileSync(path.join(f.root, 'ownership.json'), JSON.stringify({ binary, workspaces: [], panes: [], tabs: [] }));
  const r = spawnSync(process.execPath, [adapter, 'worktree', 'create', '--cwd', f.root, '--path', path.join(f.root, 'linked')], {
    env: { ...process.env, ACCEPTANCE_ROOT: f.root, ORG_ACTOR: 'eng107-implicit-parent' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'ownership.json'))).workspaces.sort(), ['implicit-main', 'linked']);
  const intent = JSON.parse(fs.readFileSync(path.join(f.root, 'creation-intents.jsonl')));
  assert.deepEqual(intent.before, ['existing']);
});
