import test from './helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORG = fileURLToPath(new URL('../bin/org.mjs', import.meta.url));
const COMMANDS = [
  'init', 'add', 'block', 'unblock', 'note', 'ask', 'answer', 'set', 'close', 'reopen',
  'start', 'check', 'ingest', 'sync', 'abandon', 'brief', 'status', 'snapshot', 'show',
  'log', 'today', 'recap', 'console',
];

function run(bin, argv, cwd, env = {}) {
  return spawnSync(process.execPath, [bin, ...argv], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ORG_ACTOR: '', ORG_NOW: '2026-10-01T12:00:00Z', TZ: 'UTC', ...env },
  });
}

function result(r) {
  return { status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

function commands(root) {
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const record = path.join(bin, 'record'), org = path.join(bin, 'org');
  fs.symlinkSync(ORG, record); fs.symlinkSync(ORG, org);
  return { record, org };
}

function normalized(r, root) {
  return {
    ...result(r),
    stdout: r.stdout.replaceAll(root, '<ROOT>'),
    stderr: r.stderr.replaceAll(root, '<ROOT>'),
  };
}

test('record and org are the same CLI for every command', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'record-alias-'));
  try {
    const { record, org } = commands(cwd);
    assert.deepEqual(result(run(record, ['help'], cwd)), result(run(org, ['help'], cwd)));
    for (const command of COMMANDS) {
      const argv = [command, '--alias-parity-invalid-option'];
      assert.deepEqual(result(run(record, argv, cwd)), result(run(org, argv, cwd)), command);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('help presents record and documents every retained compatibility name', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'record-help-'));
  try {
    const help = run(commands(cwd).record, ['help'], cwd);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /^record: durable organizational state/m);
    for (const command of COMMANDS) assert.match(help.stdout, new RegExp(`\\brecord ${command}\\b`), command);
    assert.match(help.stdout, /org command is a permanent alias/);
    for (const name of ['.org/', 'ORG_DIR', 'ORG_ACTOR']) assert.match(help.stdout, new RegExp(name.replace('.', '\\.')));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('record and org complete the same real workflow', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'record-workflow-'));
  try {
    const aliases = commands(root);
    const exercise = (bin, name) => {
      const cwd = path.join(root, name), dir = path.join(cwd, '.org');
      fs.mkdirSync(cwd);
      const env = { ORG_DIR: dir };
      const steps = [
        ['init'],
        ['add', '--goal', 'Ship the record name'],
        ['add', 'Exercise the public command', '--parent', 'G-1', '--role', 'engineer'],
        ['status', '--json'],
        ['show', 'ENG-1', '--json'],
      ];
      const results = steps.map(argv => normalized(run(bin, argv, cwd, env), cwd));
      for (const r of results) assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      return { results, events: fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8') };
    };
    assert.deepEqual(exercise(aliases.record, 'record'), exercise(aliases.org, 'org'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the package installs record and the permanent org alias', () => {
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.deepEqual(pkg.bin, { record: './bin/org.mjs', org: './bin/org.mjs' });
});
