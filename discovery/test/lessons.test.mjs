import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const command = (binary, args, cwd, env = {}) => execFileSync(binary, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' }).trim();
import { entryLessons } from '../lessons.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';

const product = path.resolve(import.meta.dirname, '../..');
function fixture(t) {
  const scratch = fs.realpathSync(fs.mkdtempSync('/tmp/entry-lessons-'));
  fixtureFleet(t, scratch);
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const repo = path.join(scratch, 'project'); fs.mkdirSync(repo);
  const git = args => command('git', args, repo);
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Lessons test']); git(['config', 'user.email', 'test@example.invalid']);
  fs.mkdirSync(path.join(repo, 'area/deep'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'area/deep/seed'), 'seed');
  git(['add', '.']); git(['commit', '-qm', 'Seed']);
  const org = path.join(repo, '.org');
  const record = args => command(process.execPath, [path.join(product, 'bin/org.mjs'), ...args], repo, { ORG_DIR: org });
  record(['init']); record(['add', 'Evidence', '--role', 'engineer']);
  function lesson(text, selectors = [], state = 'active') {
    const id = record(['lesson', 'add', text, '--evidence', 'ENG-1', ...selectors]).split('\n')[0];
    if (state !== 'proposed') record(['lesson', 'activate', id]);
    if (state === 'retired') record(['lesson', 'retire', id, '--reason', 'Obsolete']);
    return id;
  }
  return { scratch, repo, org, record, lesson, git };
}

test('entry lessons are active, area-matched, deterministic, bounded and read-only', t => {
  const f = fixture(t);
  assert.equal(entryLessons({ org: f.org }), '');
  f.lesson('Project-wide lesson');
  f.lesson('Area lesson', ['--path', 'area']);
  f.lesson('Exact lesson', ['--path', 'area/deep']);
  f.lesson('Other area', ['--path', 'areas']);
  f.lesson('Module only', ['--module', 'unselected']);
  f.lesson('Proposal', [], 'proposed'); f.lesson('Retired', [], 'retired');
  const old = f.lesson('Superseded'); const next = f.lesson('Replacement');
  f.record(['lesson', 'activate', next, '--supersedes', old]);
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8');
  const section = entryLessons({ org: f.org, enteredPath: 'area/deep' });
  assert.ok(section.indexOf('Exact lesson') < section.indexOf('Area lesson'));
  assert.ok(section.indexOf('Area lesson') < section.indexOf('Project-wide lesson'));
  for (const excluded of ['Other area', 'Module only', 'Proposal', 'Retired', 'Superseded']) assert.ok(!section.includes(excluded));
  assert.equal(entryLessons({ org: f.org, enteredPath: 'area/deep' }), section);
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), before);
  for (let i = 0; i < 8; i++) f.lesson(`Bounded ${i} ${'x'.repeat(380)}`);
  const bounded = entryLessons({ org: f.org, enteredPath: 'area/deep' });
  assert.equal(bounded.match(/^L-\d+ /gm).length, 5);
  assert.match(bounded, /7 more/);
  assert.ok(bounded.length < 4000);
  const root = entryLessons({ org: f.org });
  assert.ok(!root.includes('Area lesson'), 'root entry excludes unrelated targeted areas');
});

test('lesson area selectors keep brackets and whitespace literal', t => {
  const f = fixture(t);
  f.lesson('Tree lesson', ['--path', '.']);
  f.lesson('Area lesson', ['--path', 'area']);
  f.lesson('Sibling lesson', ['--path', 'areas']);
  const section = entryLessons({ org: f.org, enteredPath: 'area/[slug]/deep space' });
  assert.match(section, /Area lesson/); assert.match(section, /Tree lesson/);
  assert.doesNotMatch(section, /Sibling lesson/);
});
