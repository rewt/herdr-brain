import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sessionEnv } from '../security.mjs';

test('native transport prioritizes bypass refusal and still blocks capability leaks before launch', t => {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/ant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'project'), temp = path.join(root, 'session');
  for (const directory of [repo, temp, path.join(root, 'live-jobs')]) fs.mkdirSync(directory);
  const marker = path.join(root, 'native-called'), binary = path.join(root, 'fake-native');
  fs.writeFileSync(binary, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'launched');`, { mode: 0o755 });
  const spec = { repo, temp, binary, runtimeHome: path.join(root, 'runtime'), path: '/usr/bin:/bin' };
  fs.writeFileSync(path.join(root, 'live-jobs/job.json'), JSON.stringify(spec));
  const transport = path.resolve(import.meta.dirname, '../native-transport.mjs');
  const env = { ...sessionEnv({}, spec), ACCEPTANCE_ROOT: root };
  const refuse = (args, message) => {
    const result = spawnSync(process.execPath, [transport, root, 'job', ...args], { cwd: repo, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.ok(!fs.existsSync(marker), 'native executable must not launch');
  };
  for (const flag of ['--yolo', '--dangerously-bypass-approvals-and-sandbox', '--sandbox=workspace-write', '--full-auto']) {
    refuse(['exec', flag], /cannot bypass the gate profile/);
  }
  refuse(['exec'], /product entry leaked capabilities/);
});
