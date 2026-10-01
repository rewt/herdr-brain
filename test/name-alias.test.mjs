import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORG = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
const RECORD = fileURLToPath(new URL('../bin/record.mjs', import.meta.url));
const COMMANDS = [
  'init', 'add', 'block', 'unblock', 'note', 'ask', 'answer', 'set', 'close', 'reopen',
  'start', 'check', 'ingest', 'sync', 'abandon', 'brief', 'status', 'snapshot', 'show',
  'log', 'today', 'recap', 'console',
];

function run(bin, argv, cwd) {
  return spawnSync(process.execPath, [bin, ...argv], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ORG_NOW: '2026-10-01T12:00:00Z', TZ: 'UTC' },
  });
}

function result(r) {
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

test('record and org are the same CLI for every command', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'record-alias-'));
  try {
    assert.deepEqual(result(run(RECORD, ['help'], cwd)), result(run(ORG, ['help'], cwd)));
    for (const command of COMMANDS) {
      const argv = [command, '--alias-parity-invalid-option'];
      assert.deepEqual(result(run(RECORD, argv, cwd)), result(run(ORG, argv, cwd)), command);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('help presents record and documents every retained compatibility name', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'record-help-'));
  try {
    const help = run(RECORD, ['help'], cwd);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^record: durable organizational state/m);
    for (const command of COMMANDS) assert.match(help.stdout, new RegExp(`\\brecord ${command}\\b`), command);
    assert.match(help.stdout, /org command is a permanent alias/);
    for (const name of ['.org/', 'ORG_DIR', 'ORG_ACTOR']) assert.match(help.stdout, new RegExp(name.replace('.', '\\.')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('the package installs record and the permanent org alias', () => {
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.deepEqual(pkg.bin, { record: './bin/record.mjs', org: './bin/org.mjs' });
});
