import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('both shipped plugin pane actions explicitly preserve focus at the CLI boundary', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-focus-actions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'calls.jsonl'), binary = path.join(root, 'herdr');
  fs.writeFileSync(binary, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o755 });
  const manifest = fs.readFileSync(new URL('../herdr-plugin.toml', import.meta.url), 'utf8');
  const commands = [...manifest.matchAll(/^command = (\[.*plugin pane open.*\])$/gm)].map((match) => JSON.parse(match[1]));
  assert.equal(commands.length, 2);
  for (const [shell, ...args] of commands) {
    const result = spawnSync(shell, args, { env: { ...process.env, HERDR_BIN_PATH: binary }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map((args) => args.at(-1)), ['--no-focus', '--no-focus']);
  assert.deepEqual(calls.map((args) => args[args.indexOf('--entrypoint') + 1]), ['console', 'supervisor']);
});
