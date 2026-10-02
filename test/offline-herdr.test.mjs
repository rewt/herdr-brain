import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('offline boundary shields an inherited operator CLI, socket and pane IDs, but permits fixture fakes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-herdr-control-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const touched = path.join(root, 'operator-touched');
  fs.writeFileSync(path.join(root, 'herdr'), `#!/bin/sh\ntouch '${touched}'\nexit 0\n`, { mode: 0o755 });
  const module = path.resolve(import.meta.dirname, 'helpers/offline-herdr.mjs');
  const code = `import {offlineHerdr} from ${JSON.stringify(module)};import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';import fs from 'node:fs';
    delete process.env.HERDR_TEST_OFFLINE_ROOT;offlineHerdr();assert.ok(!process.env.HERDR_PANE_ID);assert.ok(!process.env.HERDR_WORKSPACE_ID);assert.ok(!process.env.HERDR_ENV);
    assert.notEqual(process.env.HERDR_SOCKET_PATH,'/operator.sock');assert.match(process.env.ORG_ACTOR,/offline-test/);
    for(const args of [['workspace','create'],['workspace','close','operator'],['agent','prompt','operator','bad']])assert.equal(spawnSync('herdr',args).status,1);
    assert.equal(spawnSync('sh',['-c','herdr workspace create']).status,1);
    assert.ok(!fs.existsSync(${JSON.stringify(touched)}),'inherited operator CLI was touched');
    assert.equal(spawnSync('herdr',['workspace','create'],{env:{...process.env,PATH:${JSON.stringify(root)}+':'+process.env.PATH}}).status,0);`;
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, HERDR_ENV: '1', HERDR_PANE_ID: 'operator', HERDR_WORKSPACE_ID: 'operator', HERDR_SOCKET_PATH: '/operator.sock' };
  delete env.HERDR_TEST_OFFLINE_ROOT;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(touched), 'explicit fixture fake was invoked');
});
