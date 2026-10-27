import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonicalProject } from '../../sessions/project.mjs';

export async function checkSessionIsolation(t, create, extra = {}) {
  const foreign = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'session-inherited-')));
  const keys = ['HOME', 'HERDR_MONITOR_FLEET', ...Object.keys(extra)];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const inherited = { ...extra, HOME: foreign, HERDR_MONITOR_FLEET: path.join(foreign, 'fleet') };
  fs.mkdirSync(path.join(foreign, '.herdr-monitor', 'foreign'), { recursive: true });
  fs.writeFileSync(path.join(foreign, '.herdr-monitor', 'foreign', 'identity.json'), '{}');
  const reads = [], originals = {};
  // Avoid a retaining mock of every read result: the regression needs only the
  // forbidden path attempts, including discovery before identity.json is read.
  for (const method of ['readFileSync', 'readdirSync']) {
    originals[method] = fs[method];
    fs[method] = function(file, ...args) {
      if (String(file).startsWith(foreign + path.sep)) {
        reads.push(String(file));
        throw Error('offline fixture reached inherited home');
      }
      return originals[method].call(this, file, ...args);
    };
  }
  try {
    for (const values of [inherited, Object.fromEntries(keys.map(key => [key, undefined]))]) {
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      const scratches = [];
      await t.test(values.HOME ? 'inherited home' : 'absent environment', async child => {
        for (let i = 0; i < 2; i++) {
          const f = await create(child), cwd = f.cwd ?? f.lane;
          scratches.push(f.scratch);
          if (Object.hasOwn(f, 'realHome')) assert.equal(f.realHome, values.HOME, 'original caller home across fixtures');
          const expected = { HOME: path.join(f.scratch, 'home'), HERDR_MONITOR_FLEET: path.join(f.scratch, 'fleet') };
          for (const [key, value] of Object.entries(expected)) {
            assert.equal(process.env[key], value); assert.equal(f.env[key], value);
          }
          for (const key of Object.keys(extra)) assert.equal(process.env[key], f.env[key], key);
          const project = canonicalProject(cwd);
          const actual = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
            `import { canonicalProject } from ${JSON.stringify(new URL('../../sessions/project.mjs', import.meta.url).href)};
             console.log(JSON.stringify({ HOME: process.env.HOME, HERDR_MONITOR_FLEET: process.env.HERDR_MONITOR_FLEET, project: canonicalProject(process.cwd()) }));`],
          { cwd, env: { ...process.env, ...f.env }, encoding: 'utf8' }));
          assert.deepEqual(actual, { ...expected, project });
        }
      });
      for (const [key, value] of Object.entries(values)) assert.equal(process.env[key], value, `restored ${key}`);
      for (const scratch of scratches) assert.equal(fs.existsSync(scratch), false);
      assert.deepEqual(reads, []);
    }
  } finally {
    Object.assign(fs, originals);
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(foreign, { recursive: true, force: true });
  }
}
