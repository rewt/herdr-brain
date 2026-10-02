import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRAIN = fileURLToPath(new URL('../brain/bin/brain.mjs', import.meta.url));

function script(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

test('brain start tells org which session is acting (fake Herdr)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-start-'));
  const cwd = path.join(root, 'checkout');
  const log = path.join(root, 'herdr.log');
  fs.mkdirSync(cwd);

  script(path.join(root, 'herdr'), `printf '%s\\t%s\\n' "\${ORG_ACTOR:-}" "$*" >> "$BRAIN_TEST_LOG"
case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[{"workspace_id":"w1","worktree":{"is_linked_worktree":false,"checkout_path":"${cwd}"}}]}}' ;;
  "tab create") echo '{"result":{"root_pane":{"pane_id":"w1:p2"},"tab":{"tab_id":"w1:t2"}}}' ;;
  *) echo '{"result":{}}' ;;
esac`);
  script(path.join(root, 'launcher'), `echo CLAUDE_CONFIG_DIR=${root}/claude`);
  script(path.join(root, 'cmem'), 'exit 1');

  const env = {
    ...process.env,
    HERDR_BIN: path.join(root, 'herdr'),
    BRAIN_LAUNCHER: path.join(root, 'launcher'),
    BRAIN_CMEM: path.join(root, 'cmem'),
    BRAIN_STATE: path.join(root, 'state'),
    BRAIN_TEST_LOG: log,
  };
  env.ORG_ACTOR = ''; // This fixture deliberately starts without an actor.
  const r = spawnSync(process.execPath, [BRAIN, 'start', '--cwd', cwd, '--name', 'brain-test-agent', '--', 'Do the work.'], {
    encoding: 'utf8', env, timeout: 10_000,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
  const tab = calls.find((line) => line.includes('\ttab create '));
  const start = calls.find((line) => line.includes('\tagent start '));
  assert.match(tab, /--env ORG_ACTOR=brain-test-agent\b/);
  assert.match(start, /^brain-test-agent\tagent start brain-test-agent\b/);
});
