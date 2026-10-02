// Separate from npm test: verifies the acceptance capability boundary offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const guard = path.resolve(import.meta.dirname, '../herdr.mjs');
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-boundary-')));
  const binary = path.join(root, 'fake-herdr');
  fs.writeFileSync(binary, `#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(path.join(root, 'calls'))},JSON.stringify(a)+'\\n');let r={};if(a[0]==='pane'&&a[1]==='list')r={panes:[{pane_id:'new:p2',workspace_id:'new'}]};if(a[0]==='tab'&&a[1]==='list')r={tabs:[{tab_id:'new:t2',workspace_id:'new'}]};if(a[0]==='pane'&&a[1]==='get')r={pane:{foreground_cwd:${JSON.stringify(root)}}};if(a[0]==='workspace'&&a[1]==='create'){fs.mkdirSync(${JSON.stringify(path.join(root, 'shell'))},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(root, 'shell/ready-new:p1'))},'');}if(a[0]==='agent'&&a[1]==='get')r={agent:{pane_id:a[2]==='foreign'?'other:p1':'own:p1',agent_status:'idle'}};if(a[0]==='workspace'&&a[1]==='create')r={workspace:{workspace_id:'new'},root_pane:{pane_id:'new:p1'},tab:{tab_id:'new:t1'}};console.log(JSON.stringify({result:r}));\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ binary, workspaces: ['own'], tabs: ['own:t1'], panes: ['own:p1'] }));
  const call = (...args) => spawnSync(process.execPath, [guard, ...args], { env: { ...process.env, ACCEPTANCE_ROOT: root }, encoding: 'utf8' });
  const calls = () => fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, call, calls, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test('foreign pane/workspace targets and symlink escapes never reach mutation APIs', () => {
  const f = fixture();
  try {
    for (const args of [['pane', 'run', 'other:p1', 'anything'], ['workspace', 'close', 'other'], ['agent', 'prompt', 'foreign', 'anything'], ['server', 'stop']]) {
      assert.notEqual(f.call(...args).status, 0);
    }
    fs.symlinkSync(os.tmpdir(), path.join(f.root, 'escape'));
    assert.notEqual(f.call('workspace', 'create', '--cwd', path.join(f.root, 'escape')).status, 0);
    assert.ok(f.calls().every((a) => a[0] === 'agent' && a[1] === 'get'), 'only read-only identity lookup is allowed');
  } finally { f.close(); }
});
test('model launch requests are always replaced by the scratch worker script', () => {
  const f = fixture();
  try {
    assert.equal(f.call('agent', 'start', 'script', '--kind', 'codex', '--pane', 'own:p1', '--', '--model', 'expensive').status, 0);
    assert.ok(f.calls().every((a) => !(a[0] === 'agent' && a[1] === 'start')));
    const transported = f.calls().find((a) => a[0] === 'pane' && a[1] === 'run');
    assert.ok(transported[3].includes(path.join(f.root, 'worker.mjs')));
    assert.ok(!transported[3].includes('expensive'));
  } finally { f.close(); }
});
test('creation receipts grant the only new targets and force no-focus', () => {
  const f = fixture();
  try {
    assert.equal(f.call('workspace', 'create', '--cwd', f.root).status, 0);
    const state = JSON.parse(fs.readFileSync(path.join(f.root, 'ownership.json'), 'utf8'));
    assert.ok(state.workspaces.includes('new')); assert.ok(state.panes.includes('new:p1'));
    assert.ok(state.panes.includes('new:p2')); assert.ok(state.tabs.includes('new:t2'));
    assert.equal(f.call('pane', 'process-info', '--pane', 'new:p2').status, 0);
    assert.notEqual(f.call('pane', 'process-info', '--pane', 'foreign:p2').status, 0);
    assert.ok(f.calls().find((a) => a[0] === 'workspace').includes('--no-focus'));
    assert.equal(f.call('workspace', 'close', 'new').status, 0);
    assert.notEqual(f.call('workspace', 'close', 'newer').status, 0);
  } finally { f.close(); }
});
