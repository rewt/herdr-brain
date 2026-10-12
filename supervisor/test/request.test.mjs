import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { request } from '../request.mjs';

function fixture(t, existing = false, status = 'idle') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-request-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'calls'), herdr = path.join(root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
const fs=require('node:fs');
const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
const shapes={
  'agent list':['agent','list'],
  'agent get':['agent','get','desk-bastian'],
  'agent prompt':['agent','prompt','desk-bastian',a[3]],
  'workspace create':['workspace','create','--label','bastian','--cwd',${JSON.stringify(path.join(root, 'development/bastian'))},'--no-focus'],
  'pane list':['pane','list','--workspace','w1'],
  'agent start':['agent','start','desk-bastian','--kind','codex','--pane','p1','--timeout','30000'],
};
if(JSON.stringify(shapes[a.slice(0,2).join(' ')])!==JSON.stringify(a)){console.error('unknown command or options');process.exit(2);}
const agent={name:'desk-bastian',agent:'codex',agent_status:${JSON.stringify(status)},pane_id:'p1',workspace_id:'w1'};
let result;
switch(a.slice(0,2).join(' ')) {
case 'agent list': result={agents:${existing ? '[agent]' : '[]'}};break;
case 'workspace create':result={workspace:{workspace_id:'w1'}};break;
case 'pane list':result={panes:[{pane_id:'p1'}]};break;
case 'agent get':result={agent};break;
default:result={};
}console.log(JSON.stringify({result}));`, { mode: 0o755 });
  return { env: { ...process.env, HOME: root, HERDR_BIN_PATH: herdr }, root,
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) };
}
test('identity requests reuse a live desk and deliver literal request text', async t => {
  const f = fixture(t, true), text = 'What: review. Why: unblock. Done: reply. Evidence: /tmp/ask; $(touch bad)';
  const sent = await request(['bastian', text], f);
  assert.equal(sent.desk, 'desk-bastian');
  assert.deepEqual(f.calls().map(a => a.slice(0, 2).join(' ')), ['agent list', 'agent get', 'agent prompt']);
  assert.deepEqual(f.calls().at(-1), ['agent', 'prompt', 'desk-bastian', text]);
  assert.equal(fs.existsSync(path.join(f.root, 'bad')), false);
});
test('a missing desk creates an unfocused identity workspace and starts native Codex before prompting', async t => {
  const f = fixture(t);
  await request(['bastian', 'Please review the evidence'], f);
  const calls = f.calls();
  assert.deepEqual(calls.map(a => a.slice(0, 2).join(' ')), ['agent list', 'workspace create', 'pane list', 'agent start', 'agent get', 'agent prompt']);
  assert.deepEqual(calls[1], ['workspace', 'create', '--label', 'bastian', '--cwd', path.join(f.root, 'development/bastian'), '--no-focus']);
  assert.deepEqual(calls[3], ['agent', 'start', 'desk-bastian', '--kind', 'codex', '--pane', 'p1', '--timeout', '30000']);
  assert.ok(!calls[3].includes('--'), 'native identity configuration owns harness settings');
});
test('blocked desks retain their workspace and receive no request', async t => {
  const f = fixture(t, true, 'blocked');
  await assert.rejects(request(['bastian', 'Request'], f), /blocked.*operator/);
  assert.equal(f.calls().some(a => a[1] === 'prompt' || a[1] === 'create'), false);
});
test('startup and readiness each get their own budget after slow provisioning', async t => {
  const f = fixture(t, false, 'starting');
  let clock = 0, readyAt;
  const calls = [];
  const execute = (bin, args, options) => {
    calls.push({ args, timeout: options.timeout });
    const result = spawnSync(bin, args, options);
    if (args[1] === 'start') { clock += 29500; readyAt = clock + 29900; }
    else if (args[1] === 'get') {
      if (clock >= readyAt) result.stdout = result.stdout.replace('starting', 'idle');
    } else if (args[1] !== 'prompt') clock += 8000;
    return result;
  };
  await request(['bastian', 'Request'], { ...f, execute, now: () => clock,
    sleep: async () => { clock += Math.min(10000, readyAt - clock); } });
  assert.equal(calls.find(c => c.args[1] === 'start').timeout, 40000);
  assert.equal(calls.filter(c => c.args[1] === 'get').at(-1).timeout, 100);
  assert.equal(calls.at(-1).args[1], 'prompt');
  assert.equal(calls.at(-1).timeout, 10000);
});
test('a desk that never becomes ready retains its workspace without delivery', async t => {
  const f = fixture(t, true, 'starting');
  let clock = 0;
  await assert.rejects(request(['bastian', 'Request'], {
    ...f, now: () => clock, sleep: async () => { clock += 10000; },
  }), /did not become ready.*retained.*not sent/);
  assert.equal(f.calls().filter(a => a[1] === 'get').length, 3);
  assert.equal(f.calls().some(a => a[1] === 'prompt'), false);
});
test('the fake Herdr rejects undeclared options', t => {
  const f = fixture(t, true);
  const r = spawnSync(f.env.HERDR_BIN_PATH, ['agent', 'list', '--json'], { env: f.env, encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /unknown command or options/);
});
test('identity traversal and empty requests fail before contacting Herdr', async t => {
  const f = fixture(t);
  for (const args of [['../bastian', 'request'], ['bastian', ' '], ['bastian', 'text', 'extra']])
    await assert.rejects(request(args, f), /usage/);
  assert.throws(() => f.calls(), /ENOENT/);
});
