import fs from 'node:fs';
import path from 'node:path';
import { installScratchTracking } from './scratch.mjs';
import { isolateGateHistory } from './gate-history.mjs';
import { ownFixtureLifetime } from './fixture-lifetime.mjs';

// Disposable projects must not inherit stale mappings from earlier fixtures.
export function fixtureFleet(t, scratch) {
  ownFixtureLifetime();
  const before = process.env.HERDR_MONITOR_FLEET;
  const fleet = path.join(fs.realpathSync(scratch), 'fleet');
  process.env.HERDR_MONITOR_FLEET = fleet;
  t.after(() => {
    if (before === undefined) delete process.env.HERDR_MONITOR_FLEET;
    else process.env.HERDR_MONITOR_FLEET = before;
  });
}

// Shared by the bounded runner and direct test-file execution. Fixtures may
// put their own fake before this refusal adapter, but never inherit live IDs.
export function offlineHerdr() {
  installScratchTracking();
  isolateGateHistory();
  // Even a fixture that forgets its own override cannot scan host scratch.
  process.env.HERDR_TEST_SCRATCH_ROOTS = '[]';
  if (process.env.HERDR_TEST_OFFLINE_ROOT) {
    // Each test file gets its own machine registry; product children inherit it.
    process.env.HERDR_MONITOR_FLEET = path.join(process.env.HERDR_TEST_OFFLINE_ROOT, `f${process.pid}`);
    process.env.BRAIN_SHADOW_ROOT ||= path.join(process.env.HERDR_TEST_OFFLINE_ROOT, 'shadow');
    return () => {};
  }
  const root = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'oh-'));
  fs.writeFileSync(path.join(root, 'herdr'), '#!/bin/sh\necho "offline tests: provide a fake Herdr CLI" >&2\nexit 1\n', { mode: 0o755 });
  for (const name of Object.keys(process.env)) if (name.startsWith('HERDR_') && !name.startsWith('HERDR_TEST_')) delete process.env[name];
  process.env.HERDR_TEST_OFFLINE_ROOT = root;
  // All test files and their product children must keep fixture observations
  // out of the operator's per-user journal, including linked Git worktrees.
  process.env.BRAIN_SHADOW_ROOT ||= path.join(root, 'shadow');
  process.env.HERDR_MONITOR_FLEET = path.join(root, `f${process.pid}`);
  process.env.HERDR_SOCKET_PATH = path.join(root, 'absent.sock');
  process.env.PATH = `${root}:${process.env.PATH ?? ''}`;
  process.env.ORG_ACTOR = `offline-test-${process.pid}`;
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true });
  process.once('exit', cleanup);
  return cleanup;
}
