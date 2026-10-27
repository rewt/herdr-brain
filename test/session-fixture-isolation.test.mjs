import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { configHome } from '../lib/config-home.mjs';
import { fixture } from './helpers/session-live.mjs';

test('fake-native fixture isolates adopted home and fleet reads and restores its caller', async t => {
  const foreign = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-foreign-home-')));
  const before = { HOME: process.env.HOME, HERDR_MONITOR_FLEET: process.env.HERDR_MONITOR_FLEET };
  const inherited = { HOME: foreign, HERDR_MONITOR_FLEET: path.join(foreign, 'fleet') };
  Object.assign(process.env, inherited);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(foreign, { recursive: true, force: true });
  });
  const identity = path.join(foreign, '.herdr-monitor', 'foreign');
  fs.mkdirSync(identity, { recursive: true });
  fs.writeFileSync(path.join(identity, 'identity.json'), '{}');
  const reads = [], read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    const name = String(file);
    if (name.startsWith(foreign + path.sep)) {
      reads.push(name);
      throw Error('fixture escaped to inherited home');
    }
    return read.call(this, file, ...args);
  });
  await t.test('in-process planning and native children stay in scratch', async child => {
    const f = fixture(child);
    assert.equal(configHome(), path.join(f.scratch, 'home', '.herdr-monitor'));
    assert.equal(f.env.HOME, process.env.HOME);
    assert.equal(f.env.HERDR_MONITOR_FLEET, process.env.HERDR_MONITOR_FLEET);
    const env = JSON.parse(execFileSync(process.execPath, ['-e',
      'console.log(JSON.stringify({HOME:process.env.HOME,HERDR_MONITOR_FLEET:process.env.HERDR_MONITOR_FLEET}))'],
    { env: f.env, encoding: 'utf8' }));
    assert.deepEqual(env, { HOME: f.env.HOME, HERDR_MONITOR_FLEET: f.env.HERDR_MONITOR_FLEET });
    assert.equal((await f.apply()).apply.state, 'attempted');
    assert.equal((await f.apply()).apply.state, 'observed');
    assert.equal(f.read().calls.filter(a => a[0] === 'agent' && a[1] === 'start').length, 1);
    assert.deepEqual(reads, []);
    const sibling = fixture(child, 'supervisor');
    assert.notEqual(sibling.env.HOME, f.env.HOME);
    assert.equal(process.env.HOME, sibling.env.HOME);
    assert.deepEqual(reads, []);
  });
  for (const [key, value] of Object.entries(inherited)) assert.equal(process.env[key], value);
});
