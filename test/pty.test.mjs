import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ptyCommand } from './helpers/pty.mjs';

test('PTY transport uses native BSD arguments and shell-safe util-linux arguments', () => {
  const values = ['two words', "apostrophe'", '$(must-not-execute)', '--model', 'literal'];
  const bsd = ptyCommand(process.execPath, values, { platform: 'darwin', executable: 'selected-script' });
  assert.deepEqual(bsd, { file: 'selected-script', args: ['-q', '/dev/null', process.execPath, ...values] });
  const linux = ptyCommand(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...values], { platform: 'linux', executable: 'selected-script' });
  assert.deepEqual(linux.args.slice(0, 3), ['-q', '-e', '-c']);
  assert.equal(linux.args.at(-1), '/dev/null');
  const result = spawnSync('sh', ['-c', linux.args[3]], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), values);
  assert.throws(() => ptyCommand('native', [], { platform: 'unsupported', executable: 'script' }), /unsupported/u);
});
