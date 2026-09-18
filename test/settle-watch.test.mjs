import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WATCH = fileURLToPath(new URL('../contrib/settle-watch.mjs', import.meta.url));

function script(file, body) {
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

test('settle-watch tells org which session is acting (dry run, fake Herdr)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-watch-'));
  const bin = path.join(root, 'bin');
  const cwd = path.join(root, 'checkout');
  const supervisor = path.join(root, 'supervisor');
  for (const d of [bin, cwd, supervisor]) fs.mkdirSync(d);
  const checklist = path.join(supervisor, 'SETTLE.md');
  const laneConfig = path.join(root, 'lane.json');
  fs.writeFileSync(checklist, '# checklist\n');
  fs.writeFileSync(laneConfig, '{}');
  script(path.join(bin, 'herdr'), `case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[{"workspace_id":"w1","worktree":{"is_linked_worktree":false,"checkout_path":"${cwd}"}}]}}' ;;
  "tab list") echo '{"result":{"tabs":[]}}' ;;
  "pane list") echo '{"result":{"panes":[]}}' ;;
  "agent list") echo '{"result":{"agents":[]}}' ;;
  *) echo '{"result":{}}' ;;
esac`);
  script(path.join(root, 'launcher'), `echo CLAUDE_CONFIG_DIR=${root}/claude`);
  script(path.join(root, 'cmem'), 'exit 1');

  const r = spawnSync(process.execPath, [WATCH, '--open', '--dry-run', '--org', path.join(root, '.org'), '--cwd', cwd,
    '--lane-config', laneConfig, '--checklist', checklist, '--launcher', path.join(root, 'launcher'), '--cmem-domain', path.join(root, 'cmem')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const openTab = r.stdout.split('\n').find((l) => l.includes('[dry-run] open tab:'));
  assert.ok(openTab, r.stdout);
  assert.match(openTab, /--env ORG_DIR=\S+/);
  assert.match(openTab, /--env ORG_ACTOR=exec-\d{4}\b/);

  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'STOP'), 'stop\n');
  const stopped = spawnSync(process.execPath, [WATCH, '--open', '--dry-run', '--org', path.join(root, '.org'), '--cwd', cwd,
    '--lane-config', laneConfig, '--checklist', checklist, '--ledger-dir', runtime,
    '--launcher', path.join(root, 'launcher'), '--cmem-domain', path.join(root, 'cmem')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(stopped.status, 1, stopped.stdout + stopped.stderr);
  assert.match(stopped.stdout, new RegExp(`${runtime.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/STOP exists`));

  const defaultStop = path.join(supervisor, 'STOP');
  fs.writeFileSync(defaultStop, 'stop\n');
  const defaultStopped = spawnSync(process.execPath, [WATCH, '--open', '--dry-run', '--org', path.join(root, '.org'), '--cwd', cwd,
    '--lane-config', laneConfig, '--checklist', checklist,
    '--launcher', path.join(root, 'launcher'), '--cmem-domain', path.join(root, 'cmem')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(defaultStopped.status, 1, defaultStopped.stdout + defaultStopped.stderr);
  assert.match(defaultStopped.stdout, new RegExp(`${defaultStop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} exists`));
  fs.unlinkSync(defaultStop);

  const missingRuntime = path.join(root, 'missing-runtime');
  assert.equal(fs.existsSync(missingRuntime), false);
  const prepared = spawnSync(process.execPath, [WATCH, '--open', '--org', path.join(root, '.org'),
    '--cwd', path.join(root, 'not-the-checkout'), '--lane-config', laneConfig, '--checklist', checklist,
    '--ledger-dir', missingRuntime, '--launcher', path.join(root, 'launcher'), '--cmem-domain', path.join(root, 'cmem')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    timeout: 2_000,
  });
  assert.equal(prepared.status, 1, prepared.stdout + prepared.stderr);
  assert.equal(prepared.error, undefined);
  assert.equal(fs.statSync(missingRuntime).isDirectory(), true);
  assert.match(prepared.stdout, /no Herdr workspace has .*not-the-checkout/);
});
