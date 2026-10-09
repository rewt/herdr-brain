// Offline counterexample to scoping terminal input by its target pane alone.
// No live Herdr, sockets, models, host test slot, or native sandbox involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r364-scoped-input-'));
const stateFile = path.join(root, 'state.json');
const native = path.join(root, 'fake-herdr.cjs');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const own = 'chats:p1', sibling = 'chats:p2';
const targets = ['project:p1', 'chats:p3'];
const initial = {
  panes: [
    { pane_id: own, workspace_id: 'chats', tab_id: 'chats:t1' },
    { pane_id: sibling, workspace_id: 'chats', tab_id: 'chats:t1' },
    { pane_id: targets[0], workspace_id: 'project', tab_id: 'project:t1' },
    { pane_id: targets[1], workspace_id: 'chats', tab_id: 'chats:t2' },
  ],
  closed: [], input: '',
};
const read = () => JSON.parse(fs.readFileSync(stateFile));
const reset = () => fs.writeFileSync(stateFile, JSON.stringify(initial));
try {
  // Model the documented pane run/input semantics: execute text in the
  // destination's existing shell, which has its own process permissions.
  // Pin every path and remove caller environment from the fake CLI entirely.
  fs.writeFileSync(native, `
const fs = require('node:fs'), cp = require('node:child_process');
const file = ${JSON.stringify(stateFile)}, args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(file));
const save = () => fs.writeFileSync(file, JSON.stringify(state));
if (args[0] !== 'pane') throw Error('unexpected command');
switch (args[1]) {
  case 'get': console.log(JSON.stringify({pane: state.panes.find(p => p.pane_id === args[2])})); break;
  case 'close': state.closed.push(args[2]); save(); break;
  case 'send-text': state.input += args[3]; save(); break;
  case 'run':
  case 'send-keys': {
    if (args[1] === 'send-keys' && args[3] !== 'enter') throw Error('unexpected key');
    const command = args[1] === 'run' ? args[3] : state.input;
    state.input = ''; save();
    const result = cp.spawnSync('/bin/sh', ['-c', command], {encoding: 'utf8', timeout: 5000, env: {}});
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    process.exitCode = result.status ?? 1;
    break;
  }
  default: throw Error('unexpected operation');
}
`);
  const call = args => {
    const result = spawnSync(process.execPath, [native, ...args], { encoding: 'utf8', timeout: 10000, env: {} });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const scoped = args => {
    assert.ok(['close', 'run', 'send-text', 'send-keys'].includes(args[1]));
    const target = JSON.parse(call(['pane', 'get', args[2]])).pane;
    // Assume the caller and launcher-owned scope have already been verified.
    // The caller cannot override the executable, scope, socket or topology.
    if (!target || target.workspace_id !== 'chats' || target.tab_id !== 'chats:t1' || target.pane_id === own)
      throw Error('outside scoped input boundary');
    return call(args);
  };
  const results = [];
  for (const target of targets) {
    for (const route of ['run', 'send-text + send-keys']) {
      reset();
      const command = [process.execPath, native, 'pane', 'close', target].map(quote).join(' ');
      for (const operation of ['close', 'run', 'send-text', 'send-keys'])
        assert.throws(() => scoped(['pane', operation, target, command]), /outside scoped input boundary/);
      assert.deepEqual(read().closed, []);
      if (route === 'run') scoped(['pane', 'run', sibling, command]);
      else {
        scoped(['pane', 'send-text', sibling, command]);
        scoped(['pane', 'send-keys', sibling, 'enter']);
      }
      assert.deepEqual(read().closed, [target]);
      results.push({ target, route, direct: 'refused', throughSiblingShell: 'closed' });
    }
  }
  reset();
  for (const operation of ['close', 'run', 'send-text', 'send-keys'])
    assert.throws(() => scoped(['pane', operation, own, 'x']), /outside scoped input boundary/);
  console.log(JSON.stringify({ offline: true, ownPane: 'refused', counterexamples: results }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
