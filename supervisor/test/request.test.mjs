import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from '../request.mjs';

function fixture(t, existing = false, status = 'idle') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-request-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'calls'), herdr = path.join(root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
const fs=require('node:fs');
const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');
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
  assert.deepEqual(f.calls().at(-1), ['agent', 'prompt', 'desk-bastian', text, '--json']);
  assert.equal(fs.existsSync(path.join(f.root, 'bad')), false);
});
test('a missing desk creates an unfocused identity workspace and starts native Codex before prompting', async t => {
  const f = fixture(t);
  await request(['bastian', 'Please review the evidence'], f);
  const calls = f.calls();
  assert.deepEqual(calls.map(a => a.slice(0, 2).join(' ')), ['agent list', 'workspace create', 'pane list', 'agent start', 'agent get', 'agent prompt']);
  assert.deepEqual(calls[1], ['workspace', 'create', '--label', 'bastian', '--cwd', path.join(f.root, 'development/bastian'), '--no-focus', '--json']);
  assert.deepEqual(calls[3].slice(0, 8), ['agent', 'start', 'desk-bastian', '--kind', 'codex', '--pane', 'p1', '--timeout']);
  assert.ok(!calls[3].includes('--'), 'native identity configuration owns harness settings');
});
test('blocked desks retain their workspace and receive no request', async t => {
  const f = fixture(t, true, 'blocked');
  await assert.rejects(request(['bastian', 'Request'], f), /blocked.*operator/);
  assert.equal(f.calls().some(a => a[1] === 'prompt' || a[1] === 'create'), false);
});
test('identity traversal and empty requests fail before contacting Herdr', async t => {
  const f = fixture(t);
  for (const args of [['../bastian', 'request'], ['bastian', ' '], ['bastian', 'text', 'extra']])
    await assert.rejects(request(args, f), /usage/);
  assert.throws(() => f.calls(), /ENOENT/);
});
