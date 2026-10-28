// Separate from npm test: verifies the acceptance capability boundary offline.
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { loadTimeout } from '../../lib/deadline.mjs';
import { commandAllowance } from '../../test/helpers/command-allowance.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commandFailure, classifyFailure, HarnessLimit } from '../limits.mjs';
import { resultLine } from '../results.mjs';
import { assertFocus } from '../focus.mjs';
import { cases, runCase } from '../cases.mjs';
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
  fs.mkdirSync(path.join(root, 'evidence'));
  const binary = path.join(root, 'fake-herdr');
  fs.writeFileSync(binary, `#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(path.join(root, 'calls'))},JSON.stringify(a)+'\\n');const modeFile=${JSON.stringify(path.join(root, 'mode.json'))};const mode=fs.existsSync(modeFile)?JSON.parse(fs.readFileSync(modeFile)):{};if(mode.fail&&mode.fail.every((v,i)=>a[i]===v)){console.error(JSON.stringify({error:{code:'herdr_unavailable',message:'injected native command failure'}}));process.exit(1)}if(mode.registerFailure&&a[0]==='agent'&&a[1]==='get'){console.error(JSON.stringify({error:{code:'herdr_unavailable',message:'injected registration native failure'}}));process.exit(1)}if(mode.newlineAck&&a[0]==='pane'&&a[1]==='send-text'&&a[3].endsWith('\\n'))fs.appendFileSync(${JSON.stringify(path.join(root, 'worker-input.jsonl'))},JSON.stringify({line:a[3]})+'\\n');let r={};if(a[0]==='workspace'&&a[1]==='list')r={workspaces:[{workspace_id:'own',cwd:${JSON.stringify(root)}}]};if(a[0]==='pane'&&a[1]==='list')r={panes:[{pane_id:'new:p2',workspace_id:'new'}]};if(a[0]==='tab'&&a[1]==='list')r={tabs:[{tab_id:'new:t2',workspace_id:'new'}]};if(a[0]==='pane'&&a[1]==='get')r={pane:{pane_id:a[2],workspace_id:a[2].startsWith('late-own:')||a[2].startsWith('own:')?'own':a[2].startsWith('new:')?'new':'other',foreground_cwd:mode.missingCwd?undefined:fs.existsSync(${JSON.stringify(path.join(root, 'moved-cwd'))})?fs.readFileSync(${JSON.stringify(path.join(root, 'moved-cwd'))},'utf8'):${JSON.stringify(root)}}};if(a[0]==='workspace'&&a[1]==='create'){fs.mkdirSync(${JSON.stringify(path.join(root, 'shell'))},{recursive:true});fs.writeFileSync(${JSON.stringify(path.join(root, 'shell/ready-new:p1'))},'');}if(a[0]==='agent'&&a[1]==='list'){const countFile=${JSON.stringify(path.join(root, 'registration-count'))};const count=fs.existsSync(countFile)?Number(fs.readFileSync(countFile))+1:1;fs.writeFileSync(countFile,String(count));r={agents:mode.registerDelay&&count<3?[]:[{pane_id:'own:p1',agent_status:mode.registerTimeout?'working':'idle'}]};}if(a[0]==='agent'&&a[1]==='get'){if(mode.registerDelay&&(!fs.existsSync(${JSON.stringify(path.join(root, 'registration-count'))})||Number(fs.readFileSync(${JSON.stringify(path.join(root, 'registration-count'))}))<3)){console.error(JSON.stringify({error:{code:'agent_not_found',message:'script has not reported idle yet'}}));process.exit(1);}r={agent:{pane_id:a[2]==='foreign'?'other:p1':'own:p1',agent_status:mode.registerTimeout?'working':'idle'}};}if(a[0]==='workspace'&&a[1]==='create')r={workspace:{workspace_id:'new'},root_pane:{pane_id:'new:p1'},tab:{tab_id:'new:t1'}};console.log(JSON.stringify({result:r}));\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'ownership.json'), JSON.stringify({ binary, workspaces: ['own'], tabs: ['own:t1'], panes: ['own:p1'] }));
  const call = (...args) => spawnSync(process.execPath, [guard, ...args], { [commandAllowance]: loadTimeout(45_000), env: { ...process.env, ACCEPTANCE_ROOT: root }, encoding: 'utf8' });
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
    const trace = fs.readFileSync(path.join(f.root, 'evidence/focus-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const call = trace.find((row) => row.type === 'start' && row.args[0] === 'pane' && row.args[1] === 'run');
    assert.deepEqual(call.args, transported);
    assert.deepEqual(call.requested.slice(0, 3), ['agent', 'start', 'script']);
    assert.ok(trace.some((row) => row.id === call.id && row.type === 'end'));
  } finally { f.close(); }
});
test('entry canary launch is confined to its fixed worker path and owned pane', () => {
  const f = fixture();
  try {
    const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
    const command = [process.execPath, path.join(f.root, 'entry-session.mjs'), f.root, 'lessons-codex'].map(quote).join(' ');
    assert.equal(f.call('pane', 'run', 'own:p1', command).status, 0);
    assert.notEqual(f.call('pane', 'run', 'other:p1', command).status, 0);
    assert.notEqual(f.call('pane', 'run', 'own:p1', command.replace('entry-session.mjs', 'arbitrary.mjs')).status, 0);
    assert.equal(f.calls().filter(a => a[0] === 'pane' && a[1] === 'run').length, 1);
  } finally { f.close(); }
});
test('parent-focusing worktree removal is refused before any native mutation', () => {
  const f = fixture();
  try {
    const reply = f.call('worktree', 'remove', '--workspace', 'own');
    assert.notEqual(reply.status, 0);
    assert.match(reply.stderr, /acceptance_product_boundary.*worktree remove changes focus/);
    assert.deepEqual(f.calls(), []);
  } finally { f.close(); }
});
test('the focus gate fails when a lane-close caller swallows unsafe removal and succeeds via Git', async () => {
  const f = fixture();
  try {
    const repo = path.join(f.root, 'repo'), worktree = path.join(f.root, 'lane');
    const git = (...args) => {
      const reply = spawnSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      assert.equal(reply.status, 0, reply.stderr);
    };
    git('init', '-q', '-b', 'main', repo);
    git('-C', repo, '-c', 'user.name=Acceptance', '-c', 'user.email=acceptance@example.invalid', 'commit', '--allow-empty', '-qm', 'Initial scratch project');
    git('-C', repo, 'worktree', 'add', '-qb', 'lane/control', worktree);
    // Reproduce the old lane-close fallback: capture and ignore the native
    // refusal, successfully remove through Git, and return success to the gate.
    const caller = spawnSync(process.execPath, ['-e', `
      const {spawnSync}=require('node:child_process');
      spawnSync(process.execPath, [${JSON.stringify(guard)}, 'worktree', 'remove', '--workspace', 'own'], {encoding:'utf8'});
      const removed=spawnSync('git', ['-C', ${JSON.stringify(repo)}, 'worktree', 'remove', ${JSON.stringify(worktree)}], {encoding:'utf8'});
      process.exit(removed.status);
    `], { encoding: 'utf8', env: { ...process.env, ACCEPTANCE_ROOT: f.root } });
    assert.equal(caller.status, 0, caller.stderr);
    assert.ok(!fs.existsSync(worktree));
    assert.deepEqual(f.calls(), [], 'forbidden native mutation never executes');
    const receipts = fs.readFileSync(path.join(f.root, 'evidence/focus-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(receipts[0].type, 'forbidden-focus');
    assert.deepEqual(receipts[0].requested, ['worktree', 'remove', '--workspace', 'own']);
    const unchanged = { baseline: 'operator:p7', samples: 20, changes: [], errors: [] };
    const results = [];
    await runCase(results, cases.focus, () => assertFocus(unchanged, { evidence: path.join(f.root, 'evidence') }));
    assert.equal(results[0].status, 'FAIL');
    assert.equal(results[0].origin, 'product');
    assert.match(results[0].detail, /forbidden focus attempt.*worktree remove --workspace own/);
    assert.match(resultLine(results[0]), /SAFETY/);
    // A broken monitor must not downgrade a witnessed product refusal.
    assert.throws(() => assertFocus(undefined, { evidence: path.join(f.root, 'evidence'), error: new HarnessLimit('broken monitor') }), /forbidden focus attempt/);
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
    assert.ok(f.calls().find((a) => a[0] === 'workspace' && a[1] === 'create').includes('--no-focus'));
    const receipts = fs.readFileSync(path.join(f.root, 'evidence/focus-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const creation = receipts.find((row) => row.type === 'end' && row.args[0] === 'workspace' && row.args[1] === 'create');
    assert.deepEqual(creation.created, { panes: ['new:p1'], workspaces: ['new'] });
    assert.equal(f.call('workspace', 'close', 'new').status, 0);
    assert.notEqual(f.call('workspace', 'close', 'newer').status, 0);
  } finally { f.close(); }
});

test('explicit focus, attach, zoom and creation focus flags leave typed refusal receipts', () => {
  const f = fixture();
  try {
    const requests = [
      ['agent', 'focus', 'own:p1'], ['agent', 'attach', 'own:p1'],
      ['pane', 'zoom', 'own:p1'], ['workspace', 'create', '--cwd', f.root, '--focus'],
    ];
    for (const args of requests) assert.notEqual(f.call(...args).status, 0);
    assert.deepEqual(f.calls(), []);
    const receipts = fs.readFileSync(path.join(f.root, 'evidence/focus-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(receipts.every((row) => row.type === 'forbidden-focus'));
    assert.deepEqual(receipts.map((row) => row.requested), requests);
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

test('named-agent mutation receipts retain the pane resolved by native identity lookup', () => {
  const f = fixture();
  try {
    const reply = f.call('agent', 'send-keys', 'worker', 'Enter');
    assert.equal(reply.status, 0, reply.stderr);
    const receipts = fs.readFileSync(path.join(f.root, 'evidence/focus-calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((row) => row.targets.panes[0] === 'own:p1'));
    assert.ok(f.calls().some((args) => args[0] === 'agent' && args[1] === 'get' && args[2] === 'worker'));
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

test('stand-in registration waits for an idle inventory receipt before its first direct lookup', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'mode.json'), JSON.stringify({ registerDelay: true }));
    const reply = f.call('agent', 'start', 'script', '--pane', 'own:p1');
    assert.equal(reply.status, 0, reply.stderr);
    const calls = f.calls();
    assert.equal(calls.filter(a => a[0] === 'agent' && a[1] === 'list').length, 3);
    assert.equal(calls.filter(a => a[0] === 'agent' && a[1] === 'get').length, 1);
    assert.equal(calls.filter(a => a[0] === 'pane' && a[1] === 'run').length, 1);
    assert.ok(calls.findIndex(a => a[0] === 'agent' && a[1] === 'get') >
      calls.findLastIndex(a => a[0] === 'agent' && a[1] === 'list'));
    assert.equal(calls.at(-1)[1], 'rename');
  } finally { f.close(); }
});

test('stand-in registration preserves an inventory refusal without retrying or renaming', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'mode.json'), JSON.stringify({ fail: ['agent', 'list'] }));
    const reply = f.call('agent', 'start', 'script', '--pane', 'own:p1');
    assert.match(reply.stderr, /stand-in did not register.*injected native command failure/s); harnessReply(reply);
    const calls = f.calls();
    assert.equal(calls.filter(a => a[0] === 'agent' && a[1] === 'list').length, 1);
    assert.ok(!calls.some(a => a[0] === 'agent' && ['get', 'rename'].includes(a[1])));
  } finally { f.close(); }
});

test('stand-in registration preserves a real native failure without a safety marker', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'mode.json'), JSON.stringify({ registerFailure: true }));
    const reply = f.call('agent', 'start', 'script', '--pane', 'own:p1');
    assert.match(reply.stderr, /stand-in did not register.*injected registration native failure/s); harnessReply(reply);
    assert.equal(f.calls().filter(a => a[0] === 'agent' && a[1] === 'get').length, 1, 'a real native refusal is never polled or replayed');
  } finally { f.close(); }
});

test('scripted PTY prompts delimit input before acknowledgement without relying on Enter encoding', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'mode.json'), JSON.stringify({ newlineAck: true }));
    fs.mkdirSync(path.join(f.root, 'script-panes'));
    fs.writeFileSync(path.join(f.root, 'script-panes/own:p1'), 'worker');
    const reply = f.call('agent', 'prompt', 'script', 'hello');
    assert.equal(reply.status, 0, reply.stderr);
    assert.equal(f.calls().find(a => a[0] === 'pane' && a[1] === 'send-text')[3], 'hello\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'worker-input.jsonl'))).line, 'hello\n');
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

test('native transport pins the original socket when copied HOME changes', () => {
  const f = fixture();
  try {
    const ledger = path.join(f.root, 'ownership.json');
    const state = JSON.parse(fs.readFileSync(ledger));
    state.socketPath = path.join(f.root, 'original.sock'); fs.writeFileSync(ledger, JSON.stringify(state));
    const binary = state.binary;
    const source = fs.readFileSync(binary, 'utf8');
    fs.writeFileSync(binary, source.replace("const a=process.argv.slice(2);", `fs.writeFileSync(${JSON.stringify(path.join(f.root, 'socket-receipt'))}, process.env.HERDR_SOCKET_PATH ?? 'missing');const a=process.argv.slice(2);`));
    const result = spawnSync(process.execPath, [guard, 'pane', 'get', 'own:p1'], {
      env: { ...process.env, HOME: f.root, ACCEPTANCE_ROOT: f.root, HERDR_SOCKET_PATH: '/wrong.sock' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(f.root, 'socket-receipt'), 'utf8'), state.socketPath);
  } finally { f.close(); }
});

test('final tab rename is allowed only for receipt-owned tabs', () => {
  const f = fixture();
  try {
    const reply = f.call('tab', 'rename', 'own:t1', 'agent:topic');
    assert.equal(reply.status, 0, reply.stderr);
    assert.notEqual(f.call('tab', 'rename', 'foreign:t1', 'agent:topic').status, 0);
    assert.equal(f.calls().filter(args => args[0] === 'tab' && args[1] === 'rename').length, 1);
  } finally { f.close(); }
});

test('private lane environment preparation reaches only an owned pane with a live scratch cwd', () => {
  const f = fixture();
  try {
    const dir = fs.mkdtempSync(path.join(f.root, 'herdr-lane-env-'));
    const file = path.join(dir, 'prepare.sh'), verifier = path.join(dir, 'verify.sh');
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(file, `set +x\nexport 'ROUTE_TEST_FLAG=1' || return\ncommand /bin/sh ${quote(verifier)}\n`, { mode: 0o600 });
    fs.writeFileSync(verifier, `[ "\${ROUTE_TEST_FLAG+x}" = x ] && [ "$ROUTE_TEST_FLAG" = '1' ] && printf '\\n%s\\n' 'lane-env-${'a'.repeat(48)}'\n`, { mode: 0o600 });
    const command = ` . ${quote(file)} 2>/dev/null; command rm -f -- ${quote(file)} ${quote(verifier)}`;
    const reply = f.call('pane', 'run', 'own:p1', command);
    assert.equal(reply.status, 0, reply.stderr);
    assert.notEqual(f.call('pane', 'run', 'foreign:p1', command).status, 0);
    fs.writeFileSync(path.join(f.root, 'moved-cwd'), os.tmpdir());
    assert.notEqual(f.call('pane', 'run', 'own:p1', command).status, 0);
    assert.equal(f.calls().filter(args => args[1] === 'run').length, 1);
  } finally { f.close(); }
});
