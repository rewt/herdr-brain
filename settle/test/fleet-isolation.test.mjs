// Deliberately use node:test, with no bounded runner or offlineHerdr defaults.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import '../../test/helpers/fleet-guard.mjs';
import { fleetPath, joinFleet } from '../../lib/fleet.mjs';
import { createEntry } from '../../discovery/runtime.mjs';
import { fixture } from './fixture.mjs';

test('settle fixture isolates in-process entry and children without the bounded runner', async t => {
  const keys = ['HERDR_MONITOR_FLEET', 'HERDR_TEST_OFFLINE_ROOT', 'NODE_OPTIONS'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  });
  delete process.env.HERDR_MONITOR_FLEET;
  delete process.env.HERDR_TEST_OFFLINE_ROOT;
  // The refusal guard supplies no fleet isolation or other runner defaults.
  const guard = fileURLToPath(new URL('../../test/helpers/fleet-guard.mjs', import.meta.url));
  process.env.NODE_OPTIONS = `--import=${JSON.stringify(guard)}`;
  assert.throws(() => fleetPath({ HERDR_MONITOR_FLEET: path.join(os.userInfo().homedir, '.herdr-monitor') }),
    /test resolved fleetPath\(\) under the operator's real home/);

  const probe = `import {fleetPath,joinFleet} from ${JSON.stringify(new URL('../../lib/fleet.mjs', import.meta.url).href)};
console.log(JSON.stringify({file:fleetPath(),joined:joinFleet({cwd:process.cwd()}).file}));`;
  for (const inherited of [undefined, path.join(os.userInfo().homedir, '.herdr-monitor')]) {
    if (inherited === undefined) delete process.env.HERDR_MONITOR_FLEET;
    else process.env.HERDR_MONITOR_FLEET = inherited;
    await t.test(inherited === undefined ? 'unset fleet' : 'operator fleet override', async t => {
      // Match the harness's command hook and in-process supervisor entry.
      const f = fixture(t, { execute: (...args) => spawnSync(...args) });
      const entry = createEntry({ cwd: f.repo, role: 'supervisor',
        runtimeDir: path.join(f.root, 'entry'), worktreeRoot: path.join(f.root, 'workers') });
      const enteredFleet = entry.context().fleet.file;
      entry.close();
      const parentFleet = fleetPath(); // Fails before any real-home read or write.
      assert.equal(enteredFleet, parentFleet);
      assert.equal(fleetPath(f.env), parentFleet);
      assert.equal(joinFleet({ cwd: f.repo }).file, parentFleet);
      const args = ['--input-type=module', '-e', probe];
      for (const [label, result] of [
        ['fixture environment', f.exec(process.execPath, args)],
        ['inherited environment', spawnSync(process.execPath, args, { cwd: f.repo, encoding: 'utf8', timeout: 15000 })],
      ]) {
        assert.equal(result.status, 0, `${label}: ${result.stderr}`);
        assert.deepEqual(JSON.parse(result.stdout), { file: parentFleet, joined: parentFleet });
      }
      const run = f.start(); f.commit('correct\n'); f.report(run);
      const settled = f.settle(run);
      assert.equal(settled.status, 0, settled.stderr);
      assert.equal(JSON.parse(settled.stdout).result, 'promotable');
    });
    assert.equal(process.env.HERDR_MONITOR_FLEET, inherited, 'fixture restores the caller fleet');
  }
});
