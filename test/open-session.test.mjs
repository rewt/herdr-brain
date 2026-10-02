import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OPEN_SESSION = fileURLToPath(new URL('../supervisor/open-session.mjs', import.meta.url));

function script(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

test('open-session tells org which session is acting (dry run, fake Herdr)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-watch-'));
  const bin = path.join(root, 'bin');
  const cwd = path.join(root, 'checkout');
  const supervisor = path.join(root, 'supervisor');
  for (const d of [bin, cwd, supervisor]) fs.mkdirSync(d);
  assert.equal(spawnSync('git', ['init', '-q', cwd]).status, 0);
  const checklist = path.join(supervisor, 'SETTLE.md');
  const laneConfig = path.join(root, 'lane.json');
  fs.writeFileSync(checklist, '# checklist\n');
  fs.writeFileSync(laneConfig, '{}');
  script(path.join(bin, 'herdr'), `case "$1 $2" in
  "worktree list") echo '{"result":{"source":{"repo_key":"${fs.realpathSync(cwd)}/.git","repo_root":"${fs.realpathSync(cwd)}","source_checkout_path":"${fs.realpathSync(cwd)}"},"worktrees":[{"path":"${fs.realpathSync(cwd)}","is_linked_worktree":false,"open_workspace_id":"w1"}]}}' ;;
  "workspace list") echo '{"result":{"workspaces":[{"workspace_id":"w1","worktree":{"is_linked_worktree":false,"checkout_path":"${cwd}","repo_root":"${cwd}","repo_key":"${cwd}/.git"}}]}}' ;;
  "tab list") echo '{"result":{"tabs":[]}}' ;;
  "pane list") echo '{"result":{"panes":[]}}' ;;
  "agent list") echo '{"result":{"agents":[]}}' ;;
  *) echo '{"result":{}}' ;;
esac`);
  script(path.join(root, 'launcher'), `echo CLAUDE_CONFIG_DIR=${root}/claude`);
  script(path.join(root, 'cmem'), 'exit 1');

  const r = spawnSync(process.execPath, [OPEN_SESSION, '--open', '--dry-run', '--org', path.join(root, '.org'), '--cwd', cwd,
    '--lane-config', laneConfig, '--checklist', checklist, '--launcher', path.join(root, 'launcher'), '--cmem-domain', path.join(root, 'cmem')], {
    encoding: 'utf8',
    env: { ...process.env, ORG_ACTOR: 'supervisor-test-agent', PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const openTab = r.stdout.split('\n').find((l) => l.includes('[dry-run] open tab:'));
  assert.ok(openTab, r.stdout);
  assert.match(openTab, /--env ORG_DIR=\S+/);
  assert.match(openTab, /--env ORG_ACTOR=exec-\d{4}\b/);
  assert.match(openTab, /--env MONITOR_ENTRY_BYPASS=1\b/);

  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'STOP'), 'stop\n');
  const stopped = spawnSync(process.execPath, [OPEN_SESSION, '--open', '--dry-run', '--org', path.join(root, '.org'), '--cwd', cwd,
    '--lane-config', laneConfig, '--checklist', checklist, '--ledger-dir', runtime,
    '--launcher', path.join(root, 'launcher'), '--cmem-domain', path.join(root, 'cmem')], {
    encoding: 'utf8',
    env: { ...process.env, ORG_ACTOR: 'supervisor-test-agent', PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(stopped.status, 1, stopped.stdout + stopped.stderr);
  assert.match(stopped.stdout, new RegExp(`${runtime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/STOP exists`));

  const defaultStop = path.join(supervisor, 'STOP');
  fs.writeFileSync(defaultStop, 'stop\n');
  const defaultStopped = spawnSync(process.execPath, [OPEN_SESSION, '--open', '--dry-run', '--org', path.join(root, '.org'), '--cwd', cwd,
    '--lane-config', laneConfig, '--checklist', checklist,
    '--launcher', path.join(root, 'launcher'), '--cmem-domain', path.join(root, 'cmem')], {
    encoding: 'utf8',
    env: { ...process.env, ORG_ACTOR: 'supervisor-test-agent', PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(defaultStopped.status, 1, defaultStopped.stdout + defaultStopped.stderr);
  assert.match(defaultStopped.stdout, new RegExp(`${defaultStop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} exists`));
  fs.unlinkSync(defaultStop);

  const missingRuntime = path.join(root, 'missing-runtime');
  assert.equal(fs.existsSync(missingRuntime), false);
  const prepared = spawnSync(process.execPath, [OPEN_SESSION, '--open', '--org', path.join(root, '.org'),
    '--cwd', path.join(root, 'not-the-checkout'), '--lane-config', laneConfig, '--checklist', checklist,
    '--ledger-dir', missingRuntime, '--launcher', path.join(root, 'launcher'), '--cmem-domain', path.join(root, 'cmem')], {
    encoding: 'utf8',
    env: { ...process.env, ORG_ACTOR: 'supervisor-test-agent', PATH: `${bin}:${process.env.PATH}` },
    timeout: 2_000,
  });
  assert.equal(prepared.status, 1, prepared.stdout + prepared.stderr);
  assert.equal(prepared.error, undefined);
  assert.equal(fs.statSync(missingRuntime).isDirectory(), true);
  assert.match(prepared.stdout, /not-the-checkout|cannot change to/);
});

test('a codex route starts a codex session with its model, effort, route args and always_args (dry run)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-session-codex-'));
  const bin = path.join(root, 'bin'), cwd = path.join(root, 'checkout'), supervisor = path.join(root, 'supervisor');
  for (const d of [bin, cwd, supervisor]) fs.mkdirSync(d);
  assert.equal(spawnSync('git', ['init', '-q', cwd]).status, 0);
  const checklist = path.join(supervisor, 'SETTLE.md'), laneConfig = path.join(root, 'lane.json');
  fs.writeFileSync(checklist, '# checklist\n');
  fs.writeFileSync(laneConfig, JSON.stringify({
    routes: { executive: { kind: 'codex', model: 'gpt-x', effort: 'high', args: ['-c', 'model_reasoning_effort=xhigh'] } },
    always_args: { codex: ['-p', 'prof', '-c', 'model_reasoning_effort=low'] },
  }));
  script(path.join(bin, 'herdr'), `case "$1 $2" in
  "worktree list") echo '{"result":{"source":{"repo_key":"${fs.realpathSync(cwd)}/.git","repo_root":"${fs.realpathSync(cwd)}","source_checkout_path":"${fs.realpathSync(cwd)}"},"worktrees":[{"path":"${fs.realpathSync(cwd)}","is_linked_worktree":false,"open_workspace_id":"w1"}]}}' ;;
  "workspace list") echo '{"result":{"workspaces":[{"workspace_id":"w1"}]}}' ;;
  *) echo '{"result":{"tabs":[],"panes":[],"agents":[]}}' ;;
esac`);
  script(path.join(root, 'launcher'), `echo CLAUDE_CONFIG_DIR=${root}/claude`);
  script(path.join(root, 'cmem'), 'exit 1');
  const r = spawnSync(process.execPath, [OPEN_SESSION, '--open', '--dry-run', '--org', path.join(root, '.org'), '--cwd', cwd,
    '--lane-config', laneConfig, '--checklist', checklist, '--launcher', path.join(root, 'launcher'), '--cmem-domain', path.join(root, 'cmem')], {
    encoding: 'utf8', env: { ...process.env, ORG_ACTOR: 'supervisor-test-agent', PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const start = r.stdout.split('\n').find((l) => l.includes('[dry-run] start agent:'));
  assert.ok(start, r.stdout);
  assert.match(start, /--kind codex .* -- -m gpt-x -c model_reasoning_effort=high -c model_reasoning_effort=xhigh -p prof$/,
    'route args follow the effort; always_args are added only for options the route did not set');
  assert.doesNotMatch(start, /--permission-mode|--add-dir|--effort/);
});

test('open-session refuses a concurrent supervisor session instead of waiting', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-session-busy-'));
  const bin = path.join(root, 'bin'), cwd = path.join(root, 'checkout'), supervisor = path.join(root, 'supervisor');
  for (const directory of [bin, cwd, supervisor]) fs.mkdirSync(directory);
  const checklist = path.join(supervisor, 'SETTLE.md'), laneConfig = path.join(root, 'lane.json');
  const calls = path.join(root, 'herdr-calls');
  fs.writeFileSync(checklist, '# checklist\n');
  fs.writeFileSync(laneConfig, '{}');
  script(path.join(bin, 'herdr'), `printf '%s\\n' "$*" >> "${calls}"
case "$1 $2" in
  "agent list") echo '{"result":{"agents":[{"name":"settle-r-8-1200","agent_status":"working"}]}}' ;;
  *) echo '{"result":{}}' ;;
esac`);

  const result = spawnSync(process.execPath, [OPEN_SESSION, '--open', '--org', path.join(root, '.org'), '--cwd', cwd,
    '--lane-config', laneConfig, '--checklist', checklist, '--ledger-dir', supervisor], {
    encoding: 'utf8', env: { ...process.env, ORG_ACTOR: 'supervisor-test-agent', PATH: `${bin}:${process.env.PATH}` }, timeout: 10_000,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.error, undefined, 'the launcher refuses promptly rather than waiting');
  assert.match(result.stdout, /settle-r-8-1200 is already working; refusing .* retry this launch after it stops/);
  assert.doesNotMatch(fs.readFileSync(calls, 'utf8'), /tab create|agent start/);
});

test('a run with a recorded report never opens a duplicate settle session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-session-reported-'));
  const bin = path.join(root, 'bin'), cwd = path.join(root, 'checkout'), supervisor = path.join(root, 'supervisor');
  for (const directory of [bin, cwd, supervisor]) fs.mkdirSync(directory);
  const checklist = path.join(supervisor, 'SETTLE.md'), laneConfig = path.join(root, 'lane.json');
  const herdrCalls = path.join(root, 'herdr-calls');
  fs.writeFileSync(checklist, '# checklist\n');
  fs.writeFileSync(laneConfig, '{}');
  script(path.join(bin, 'org'), `echo '{"id":"R-8","item":"ENG-8","report":{"outcome":"done"},"meta":{"agent":"lane-eight"},"report_path":"${root}/report.md"}'`);
  script(path.join(bin, 'herdr'), `printf '%s\\n' "$*" >> "${herdrCalls}"`);

  const result = spawnSync(process.execPath, [OPEN_SESSION, 'R-8', '--dry-run', '--org', path.join(root, '.org'), '--cwd', cwd,
    '--lane-config', laneConfig, '--checklist', checklist], {
    encoding: 'utf8', env: { ...process.env, ORG_ACTOR: 'supervisor-test-agent', PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /R-8 already has a recorded report; refusing to open another settle session/);
  assert.equal(fs.existsSync(herdrCalls), false, 'no Herdr action is attempted for an already recorded run');
});
