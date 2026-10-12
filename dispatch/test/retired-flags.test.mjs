import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('dispatch rejects --serves before discovering a project or starting an agent', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-dispatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../dispatch.mjs'), 'ENG-1', '--serves', 'other'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root, ORG_DIR: path.join(root, '.org'), HERDR_SOCKET_PATH: path.join(root, 'absent.sock') }, timeout: 10000,
  });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Unknown option '--serves'/);
  assert.deepEqual(fs.readdirSync(root), []);
});
