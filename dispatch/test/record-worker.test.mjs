import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const record = path.resolve('bin/org.mjs'), capture = path.resolve('dispatch/record-worker.mjs');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-launch-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'), org = path.join(root, '.org'); fs.mkdirSync(bin);
  const env = { ...process.env, ORG_DIR: org, ORG_ACTOR: 'launch-test', PATH: bin + ':' + process.env.PATH };
  const rec = args => spawnSync(process.execPath, [record, ...args], { cwd: root, env, encoding: 'utf8' });
  assert.equal(rec(['init', org]).status, 0);
  const item = rec(['add', 'worker launch']).stdout.match(/^(\S+)/)[1];
  const start = () => rec(['start', item, '--workspace', root]).stdout.match(/^(R-\d+)/)[1];
  const run = start(), file = path.join(root, 'agent.json');
  const agent = { name: 'worker', pane_id: 'pane', workspace_id: 'workspace', cwd: root,
    terminal_id: 'terminal', agent_session: { value: 'session' } };
  fs.writeFileSync(path.join(bin, 'herdr'), `#!${process.execPath}\nimport fs from 'node:fs';console.log(JSON.stringify({result:{agent:JSON.parse(fs.readFileSync(${JSON.stringify(file)}))}}));\n`, { mode: 0o755 });
  const save = a => fs.writeFileSync(file, JSON.stringify(a)); save(agent);
  const launch = (id = run, extra = []) => spawnSync(process.execPath, [capture, id, '--agent', agent.name,
    '--pane', agent.pane_id, '--cwd', root, ...extra], { env, encoding: 'utf8' });
  const show = () => JSON.parse(rec(['show', run, '--json']).stdout).meta;
  return { root, agent, run, start, save, launch, show, rec, org };
}
test('external launch records the Monitor identity, retries exactly and refuses occupant changes', t => {
  const f = fixture(t);
  assert.equal(f.launch(f.run, ['--terminal-id', 'wrong']).status, 1);
  assert.equal(f.launch().status, 0);
  assert.deepEqual(f.show(), { agent: 'worker', pane: 'pane', worker_workspace: 'workspace', terminal_id: 'terminal', agent_session_id: 'session' });
  const events = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8');
  assert.equal(f.launch().status, 0);
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), events);
  for (const replacement of [{ name: 'wrong' }, { pane_id: 'wrong' }, { workspace_id: 'wrong' },
    { cwd: path.dirname(f.root) }, { terminal_id: 'wrong' }, { agent_session: { value: 'wrong' } },
    { terminal_id: null, agent_session: null }]) {
    f.save({ ...f.agent, ...replacement });
    assert.notEqual(f.launch().status, 0, JSON.stringify(replacement));
    assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), events);
  }
});
test('missing identities, settled runs and worker names owned by newer runs cannot be backfilled', t => {
  const f = fixture(t);
  f.save({ ...f.agent, terminal_id: null, agent_session: null }); assert.equal(f.launch().status, 1);
  f.save(f.agent);
  assert.equal(f.rec(['abandon', f.run]).status, 0); assert.equal(f.launch().status, 1);
  const older = f.start(), newer = f.start();
  assert.equal(f.launch(newer).status, 0); assert.equal(f.launch(older).status, 1);
});
test('one launch occupant identity suffices but a retry cannot enrich it later', t => {
  const f = fixture(t);
  f.save({ ...f.agent, agent_session: null }); assert.equal(f.launch().status, 0);
  assert.equal(f.show().agent_session_id, undefined);
  f.save(f.agent); assert.equal(f.launch().status, 1);
});
