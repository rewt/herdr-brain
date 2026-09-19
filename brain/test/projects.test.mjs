import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectForFolder } from '../lib/projects.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'brain/bin/brain.mjs');
const projects = [
  { name: 'alpha', cwd: '/work/alpha' },
  { name: 'herdr-brain', cwd: '/Users/me/code/herdr-brain' },
  { name: 'bch-cloak', cwd: '/Users/me/code/bch-cloak' },
];

test('a folder maps to its configured checkout, linked worktree, or other', () => {
  assert.equal(projectForFolder('/work/alpha/src', projects), 'alpha');
  assert.equal(projectForFolder('/Users/me/.worktrees/herdr-brain/lane-visible/lib', projects), 'herdr-brain');
  assert.equal(projectForFolder('/Users/me/.herdr/worktrees/bch-cloak/lane-keys', projects), 'bch-cloak');
  assert.equal(projectForFolder('/work/alphabet', projects), 'other', 'prefixes stop at path boundaries');
  assert.equal(projectForFolder('/tmp/unconfigured', projects), 'other');
});

test('queue JSON, queue text and show name the project on every result', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brain-projects-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'console.json');
  fs.writeFileSync(config, JSON.stringify({ projects }));
  const at = new Date(Date.now() - 60_000).toISOString();
  const entries = [
    { type: 'result', id: 'one', session: 'lane-alpha', state: 'done', where: '/work/alpha/src', headline: 'Alpha finished its work.', at },
    { type: 'result', id: 'two', session: 'lane-linked', state: 'done', where: '/Users/me/.worktrees/herdr-brain/lane-visible', headline: 'Linked work finished.', at },
    { type: 'result', id: 'three', session: 'lane-elsewhere', state: 'done', where: '/tmp/no-project', headline: 'Other work finished.', at },
  ];
  fs.writeFileSync(path.join(dir, 'queue.jsonl'), `${entries.map(JSON.stringify).join('\n')}\n`);
  const env = { ...process.env, BRAIN_STATE: dir, HERDR_ORG_CONSOLE_CONFIG: config };
  const run = (...args) => execFileSync(process.execPath, [BIN, ...args], { env, encoding: 'utf8' });

  assert.deepEqual(
    Object.fromEntries(JSON.parse(run('queue', '--json')).map((r) => [r.id, r.project])),
    { one: 'alpha', two: 'herdr-brain', three: 'other' },
  );
  const text = run('queue');
  assert.match(text, /alpha\s+\d+m\s+alpha\s+/);
  assert.match(text, /linked\s+\d+m\s+herdr-brain\s+/);
  assert.match(text, /elsewhere\s+\d+m\s+other\s+/);
  assert.match(run('show', 'one'), /^alpha  ·  lane-alpha  ·  done/m);
});
