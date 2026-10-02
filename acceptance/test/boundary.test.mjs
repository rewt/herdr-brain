// Separate from npm test: verifies the acceptance capability boundary offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commandFailure, classifyFailure, HarnessLimit } from '../limits.mjs';
import { resultLine } from '../results.mjs';
const guard = path.resolve(import.meta.dirname, '../herdr.mjs');

test('native adapter pins the original socket despite an isolated HOME or caller override', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-socket-')));
  try {
    const binary = path.join(root, 'herdr');
    fs.writeFileSync(binary, `#!${process.execPath}\nconsole.log(JSON.stringify({result:{workspaces:[],socket:process.env.HERDR_SOCKET_PATH}}));\n`, { mode: 0o755 });
    const socketPath = path.join(root, 'original.sock');
    fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ binary, socketPath, workspaces: [], panes: [], tabs: [] }));
    const r = spawnSync(process.execPath, [guard, 'workspace', 'list'], { encoding: 'utf8',
      env: { ...process.env, ACCEPTANCE_ROOT: root, HOME: path.join(root, 'isolated-home'), HERDR_SOCKET_PATH: '/wrong/caller.sock' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).result.socket, socketPath);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-boundary-')));
  const binary = path.join(root, 'fake-herdr');
  fs.writeFileSync(binary, `#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(path.join(root, 'calls'))},JSON.stringify(a)+'\\n');const modeFile=${JSON.stringify(path.join(root, 'mode.json'))};const mode=fs.existsSync(modeFile)?JSON.parse(fs.readFileSync(modeFile)):{};if(mode.fail&&mode.fail.every((v,i)=>a[i]===v)){console.error(JSON.stringify({error:{code:'herdr_unavailable',message:'injected native command failure'}}));process.exit(1)}let r={};if(a[0]==='pane'&&a[1]==='list')r={panes:[{pane_id:'new:p2',workspace_id:'new'}]};if(a[0]==='tab'&&a[1]==='list')r={tabs:[{tab_id:'new:t2',workspace_id:'new'}]};if(a[0]==='pane'&&a[1]==='get')r={pane:{pane_id:a[2],workspace_id:a[2].startsWith('late-own:')||a[2].startsWith('own:')?'own':a[2].startsWith('new:')?'new':'other',foreground_cwd:mode.missingCwd?undefined:fs.existsSync(${JSON.stringify(path.join(root, 'moved-cwd'))})?fs.readFileSync(${JSON.stringify(path.join(root, 'moved-cwd'))},'utf8'):${JSON.stringify(root)}}};if(a[0]==='workspace'&&a[1]==='create'){fs.mkdirSync(${JSON.stringify(path.join(root, 'shell'))},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(root, 'shell/ready-new:p1'))},'');}if(a[0]==='agent'&&a[1]==='get')r={agent:{pane_id:a[2]==='foreign'?'other:p1':'own:p1',agent_status:mode.registerTimeout?'working':'idle'}};if(a[0]==='workspace'&&a[1]==='create')r={workspace:{workspace_id:'new'},root_pane:{pane_id:'new:p1'},tab:{tab_id:'new:t1'}};console.log(JSON.stringify({result:r}));\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ binary, workspaces: ['own'], tabs: ['own:t1'], panes: ['own:p1'] }));
  const call = (...args) => spawnSync(process.execPath, [guard, ...args], { env: { ...process.env, ACCEPTANCE_ROOT: root }, encoding: 'utf8' });
  const calls = () => fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { root, call, calls, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}
test('foreign pane/workspace targets and symlink escapes never reach mutation APIs', () => {
  const f = fixture();
  try {
    for (const args of [['pane', 'run', 'other:p1', 'anything'], ['workspace', 'close', 'other'], ['agent', 'prompt', 'foreign', 'anything'], ['server', 'stop']]) {
      const denied = f.call(...args); assert.notEqual(denied.status, 0);
      assert.match(denied.stderr, /acceptance_product_boundary/);
    }
    fs.symlinkSync(os.tmpdir(), path.join(f.root, 'escape'));
    assert.notEqual(f.call('workspace', 'create', '--cwd', path.join(f.root, 'escape')).status, 0);
    assert.ok(f.calls().every((a) => (['agent','pane'].includes(a[0]) && a[1] === 'get')), 'only read-only identity lookup is allowed');
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
test('agent send-keys requires an owned target and checks its live cwd', () => {
  const f = fixture();
  try {
    assert.equal(f.call('agent', 'send-keys', 'own:p1', 'ctrl+u').status, 0);
    assert.notEqual(f.call('agent', 'send-keys', 'foreign', 'ctrl+u').status, 0);
    assert.ok(f.calls().some((a) => a[0] === 'pane' && a[1] === 'get' && a[2] === 'own:p1'));
    fs.writeFileSync(path.join(f.root, 'moved-cwd'), os.tmpdir());
    assert.notEqual(f.call('agent', 'send-keys', 'own:p1', 'ctrl+u').status, 0);
    assert.equal(f.calls().filter((a) => a[0] === 'agent' && a[1] === 'send-keys').length, 1);
  } finally { f.close(); }
});

test('late pane needs a live owned workspace and scratch cwd, then gets an atomic receipt', () => {
  const f = fixture();
  try {
    assert.equal(f.call('pane', 'process-info', '--pane', 'late-own:p2').status, 0);
    const state = JSON.parse(fs.readFileSync(path.join(f.root, 'ownership.json')));
    assert.ok(state.panes.includes('late-own:p2'));
    assert.deepEqual(state.latePanes, [{ pane_id: 'late-own:p2', workspace_id: 'own', cwd: f.root }]);
    assert.notEqual(f.call('pane', 'process-info', '--pane', 'foreign:p2').status, 0);
    fs.writeFileSync(path.join(f.root, 'moved-cwd'), os.tmpdir());
    assert.notEqual(f.call('pane', 'process-info', '--pane', 'late-own:p3').status, 0);
    assert.ok(!JSON.parse(fs.readFileSync(path.join(f.root, 'ownership.json'))).panes.includes('late-own:p3'));
    assert.equal(f.calls().filter((a) => a[1] === 'process-info').length, 1);
  } finally { f.close(); }
});

function classified(reply, options = {}) {
  assert.notEqual(reply.status, 0);
  return { id: '05', name: 'Configured boundary', ...classifyFailure(commandFailure(reply.stderr), options) };
}
function harnessReply(reply, options = {}) {
  const result = classified(reply, options);
  assert.equal(result.status, 'PENDING'); assert.equal(result.origin, 'harness');
  assert.match(reply.stderr, /acceptance_harness_limit/);
  assert.doesNotMatch(reply.stderr, /acceptance_product_boundary/);
  assert.match(resultLine(result), /HARNESS/); assert.doesNotMatch(resultLine(result), /SAFETY/);
  return result;
}

test('non-zero native Herdr replies are harness failures through both body and forwarding paths', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, 'script-panes'));
    fs.writeFileSync(path.join(f.root, 'script-panes/own:p1'), 'worker');
    const quoted = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
    const command = [process.execPath, path.join(f.root, 'worker.mjs'), f.root, 'worker'].map(quoted).join(' ');
    const cases = [
      { fail: ['pane', 'get'], args: ['agent', 'send-keys', 'own:p1', 'ctrl+u'] },
      { fail: ['agent', 'get'], args: ['agent', 'prompt', 'script', 'hello'] },
      { fail: ['pane', 'run'], args: ['pane', 'run', 'own:p1', command] },
      { fail: ['pane', 'send-text'], args: ['agent', 'prompt', 'script', 'hello'] },
      { fail: ['pane', 'send-keys'], args: ['agent', 'prompt', 'script', 'hello'] },
      { fail: ['workspace', 'close'], args: ['workspace', 'close', 'own'], cleanup: true },
    ];
    for (const example of cases) {
      fs.writeFileSync(path.join(f.root, 'mode.json'), JSON.stringify({ fail: example.fail }));
      const reply = f.call(...example.args);
      harnessReply(reply, { cleanup: example.cleanup });
      const wrapped = classifyFailure(new HarnessLimit(reply.stderr), { cleanup: example.cleanup });
      assert.equal(wrapped.origin, 'harness'); assert.doesNotMatch(resultLine({ id: '23', name: 'Cleanup', ...wrapped }), /SAFETY/);
    }
  } finally { f.close(); }
});

test('stand-in registration timeout is harness pending without a safety marker', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'mode.json'), JSON.stringify({ registerTimeout: true }));
    const reply = f.call('agent', 'start', 'script', '--pane', 'own:p1');
    assert.match(reply.stderr, /stand-in did not register/); harnessReply(reply);
  } finally { f.close(); }
});

test('scripted PTY acknowledgement timeout is harness pending without a safety marker', () => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, 'script-panes'));
    fs.writeFileSync(path.join(f.root, 'script-panes/own:p1'), 'worker');
    const reply = f.call('agent', 'prompt', 'script', 'hello');
    assert.match(reply.stderr, /script did not acknowledge PTY prompt/); harnessReply(reply);
    assert.ok(f.calls().some((args) => args[1] === 'send-text'));
    assert.ok(f.calls().some((args) => args[1] === 'send-keys'));
  } finally { f.close(); }
});

test('actual capability refusals stay product FAIL even when wrapped by cleanup', () => {
  const f = fixture();
  try {
    for (const args of [
      ['workspace', 'close', 'foreign'], ['workspace', 'create', '--cwd', os.tmpdir()],
      ['server', 'stop'], ['worktree', 'remove', '--cwd', f.root, '--force'],
      ['workspace', 'create', '--cwd', f.root, '--focus'], ['pane', 'run', 'own:p1', 'arbitrary command'],
    ]) {
      const reply = f.call(...args), result = classified(reply);
      assert.equal(result.status, 'FAIL'); assert.equal(result.origin, 'product');
      assert.match(resultLine(result), /SAFETY/); assert.doesNotMatch(resultLine(result), /HARNESS/);
      const wrapped = classifyFailure(new HarnessLimit(reply.stderr), { cleanup: true });
      assert.equal(wrapped.status, 'FAIL'); assert.equal(wrapped.origin, 'product');
    }
    fs.writeFileSync(path.join(f.root, 'moved-cwd'), os.tmpdir());
    const reply = f.call('agent', 'send-keys', 'own:p1', 'ctrl+u');
    assert.match(reply.stderr, /pane cwd left scratch/); assert.equal(classified(reply).status, 'FAIL');
  } finally { f.close(); }
});


test('missing live pane cwd receipt is a harness limit, not a candidate capability violation', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'mode.json'), JSON.stringify({ missingCwd: true }));
    const reply = f.call('pane', 'process-info', '--pane', 'late-own:p2');
    assert.match(reply.stderr, /receipt unavailable/); harnessReply(reply);
    assert.ok(!JSON.parse(fs.readFileSync(path.join(f.root, 'ownership.json'))).panes.includes('late-own:p2'));
  } finally { f.close(); }
});
