import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source = path.resolve(import.meta.dirname, '..');
const modules = [
  "bin/org.mjs",
  "brain/bin/brain.mjs",
  "contrib/settle-watch.mjs",
  "discovery/client.mjs",
  "dispatch/dispatch.mjs",
  "housekeeping/housekeeping.mjs",
  "lanes/lane.mjs",
  "promote/host-gate.mjs",
  "promote/promote.mjs",
  "promote/metrics.mjs",
  "settle/settle.mjs",
  "supervisor/prompt-supervisor.mjs",
  "supervisor/supervisor.mjs",
  "supervisor/request.mjs",
  "supervisor/tidy-tabs.mjs",
  "test-slot/test-slot.mjs",
  "watch/watch.mjs",
  "acceptance/run.mjs"
];
const launches = [...modules.map(module => ({ module, linked: false })),
  ...['lanes/lane.mjs', 'brain/bin/brain.mjs'].map(module => ({ module, linked: true }))];
for (const { module, linked } of launches) test(`${module}${linked ? ' via release symlinks' : ''} --help exits successfully before operational work`, t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'cli-help-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PATH: '/usr/bin:/bin', HOME: root, ZDOTDIR: root, CODEX_HOME: path.join(root, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), HERDR_MONITOR_HOME: path.join(root, 'monitor'),
    HERDR_MONITOR_FLEET: path.join(root, 'fleet'), HERDR_MONITOR_ENTRY_BIN: path.join(root, 'entry'),
    BRAIN_STATE: path.join(root, 'brain'), ORG_DIR: path.join(root, 'org'), ORG_ACTOR: 'cli-help-test',
    HERDR_SOCKET_PATH: path.join(root, 'absent.sock'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  let launcher = path.join(source, module);
  if (linked) {
    fs.symlinkSync(source, path.join(root, 'current'));
    launcher = path.join(root, 'launcher');
    fs.symlinkSync(path.join(root, 'current', module), launcher);
  }
  const result = spawnSync(process.execPath, [launcher, '--help'], { cwd: root, env, encoding: 'utf8', input: '', timeout: 10000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /usage|record: durable|monitor fleet/iu);
  assert.doesNotMatch(result.stdout + result.stderr, /ERR_PARSE_ARGS|unrecognized SessionStart|SyntaxError/u);
  if (linked) { fs.unlinkSync(launcher); fs.unlinkSync(path.join(root, 'current')); }
  assert.deepEqual(fs.readdirSync(root), [], 'help must leave the scratch home untouched');
});
