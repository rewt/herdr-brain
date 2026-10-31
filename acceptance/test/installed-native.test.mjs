import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scratchProductHomes } from '../environment.mjs';

test('native input receipts recover from missing bindings and follow the latest same-session rebind', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'installed-native-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'project'), session = 'scratch1-session';
  fs.mkdirSync(path.join(repo, '.org'), { recursive: true });
  fs.mkdirSync(path.join(root, 'evidence'));
  const processRow = { pid: 1_000_000_002, identity: '0:1000000002' };
  fs.writeFileSync(path.join(root, 'native.json'), JSON.stringify({ repo, workspaces: {
    scratch1: { workspace_id: 'scratch1', pane: { pane_id: 'scratch1:p1' }, agentProcess: processRow,
      agent: { name: 'worker', agent_session: { value: session } } }
  } }));
  const events = path.join(repo, '.org/events.jsonl');
  fs.writeFileSync(events, JSON.stringify({ type: 'run.started', seq: 1, run: 'R-1' }) + '\n');
  const append = event => fs.appendFileSync(events, JSON.stringify(event) + '\n');
  const prompt = () => {
    const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../installed-native.mjs'),
      'agent', 'prompt', 'worker', 'task'], {
      cwd: root, env: { ...scratchProductHomes(root), INSTALLED_CYCLE_ROOT: root }, encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return fs.readFileSync(path.join(root, 'evidence/native-input.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  };
  assert.equal(prompt().binding, null, 'no committed binding remains missing proof');
  const first = { type: 'run.session_bound', seq: 2, run: 'R-1', session,
    process: { pid: 1_000_000_001, identity: '0:1000000001' } };
  append(first);
  assert.equal(prompt().binding.seq, first.seq, 'a later commit recovers the missing receipt');
  const latest = { ...first, seq: 3, run: 'R-2', process: processRow };
  append(latest);
  append({ ...first, seq: 4, session: 'another-session' });
  append({ ...first, type: 'run.note', seq: 5 });
  const receipt = prompt();
  assert.deepEqual(receipt.binding, { seq: latest.seq, run: latest.run, process: processRow, session });
  assert.deepEqual(receipt.process, processRow);
  assert.equal(receipt.session, session);
});
