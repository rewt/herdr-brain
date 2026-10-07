import { nativeEnvironment } from '../../test/helpers/native-environment.mjs';
import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { command, createEntry } from '../runtime.mjs';
import { entryLessons } from '../lessons.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { runPTY, PTY_SKIP_REASON } from '../../test/helpers/pty.mjs';

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

test('both installed adapters deliver shared lessons for nested entry to native arguments offline', t => {
  const f = fixture(t), bin = path.join(f.scratch, 'bin'), receipt = path.join(f.scratch, 'receipt.json');
  f.lesson('Entry canary project lesson'); f.lesson('Entry canary area lesson', ['--path', 'area']);
  f.lesson('Excluded sibling', ['--path', 'other']);
  const native = path.join(f.scratch, 'native');
  fs.writeFileSync(native, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  command(process.execPath, [path.join(product, 'discovery/install.mjs'), '--bin', bin, '--codex', native, '--claude', native], f.repo);
  const env = { ...nativeEnvironment(f.scratch, { codex: native, claude: native }), MONITOR_RUNTIME_DIR: path.join(f.scratch, 'runtime'), MONITOR_WORKTREE_ROOT: path.join(f.scratch, 'worktrees') };
  const policies = [];
  for (const kind of ['codex', 'claude']) {
    command(path.join(bin, `monitor-${kind}`), ['--repo', path.join(f.repo, 'area/deep'), '--'], f.repo, env);
    const args = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    const policy = kind === 'codex' ? JSON.parse(args.find(a => a.startsWith('developer_instructions=')).slice('developer_instructions='.length))
      : args[args.indexOf('--append-system-prompt') + 1];
    assert.match(policy, /Active lessons.*\(area\/deep\)/);
    assert.match(policy, /Entry canary project lesson/); assert.match(policy, /Entry canary area lesson/);
    assert.ok(!policy.includes('Excluded sibling'));
    policies.push(policy.slice(policy.indexOf('Active lessons'), policy.indexOf('\n\n', policy.indexOf('Active lessons'))));
  }
  assert.equal(policies[0], policies[1]);
  const linked = path.join(f.scratch, 'linked'); f.git(['worktree', 'add', '-qb', 'linked', linked]);
  const entry = createEntry({ cwd: path.join(linked, 'area/deep'), runtimeDir: env.MONITOR_RUNTIME_DIR, worktreeRoot: env.MONITOR_WORKTREE_ROOT });
  try {
    assert.equal(entry.context().enteredPath, 'area/deep');
    assert.equal(entry.context().org, f.org);
  } finally { entry.close(); }
});

for (const populated of [false, true]) test(`installed adapters launch from literal bracket directories with ${populated ? 'matching lessons' : 'an empty lesson record'}`, { skip: PTY_SKIP_REASON }, t => {
  const f = fixture(t), enteredPath = 'area/[slug]/deep', cwd = path.join(f.repo, enteredPath);
  fs.mkdirSync(cwd, { recursive: true });
  if (populated) {
    f.lesson('Broad project lesson');
    f.lesson('Tree lesson', ['--path', '.']);
    f.lesson('Matching ancestor lesson', ['--path', 'area']);
    f.lesson('Excluded sibling lesson', ['--path', 'areas']);
    f.lesson('Excluded module lesson', ['--module', 'area']);
  }
  const bin = path.join(f.scratch, 'bin'), receipt = path.join(f.scratch, 'receipt.json'), native = path.join(f.scratch, 'native');
  fs.writeFileSync(native, `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.argv.slice(2)));\n`, { mode: 0o755 });
  command(process.execPath, [path.join(product, 'discovery/install.mjs'), '--bin', bin, '--codex', native, '--claude', native], f.repo);
  const env = { ...nativeEnvironment(f.scratch, { codex: native, claude: native }), MONITOR_RUNTIME_DIR: path.join(f.scratch, 'runtime'), MONITOR_WORKTREE_ROOT: path.join(f.scratch, 'worktrees') };
  const lessonEvents = () => fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(event => event.type.startsWith('lesson.'));
  const before = lessonEvents();
  for (const kind of ['codex', 'claude']) {
    // A fresh PTY ensures the automatic installed command enters the project.
    fs.rmSync(receipt, { force: true });
    const result = runPTY(path.join(bin, kind), [], { cwd, env: { ...process.env, ...env,
      MONITOR_ENTRY_BYPASS: '', MONITOR_REQUEST_DIR: '', HERDR_INTEGRATION_ID: '' } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const args = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    const policy = kind === 'codex' ? JSON.parse(args.find(a => a.startsWith('developer_instructions=')).slice('developer_instructions='.length))
      : args[args.indexOf('--append-system-prompt') + 1];
    assert.equal(typeof policy, 'string', 'native launch received the entry policy');
    if (populated) {
      assert.ok(policy.includes(`entered area (${enteredPath})`));
      for (const text of ['Broad project lesson', 'Tree lesson', 'Matching ancestor lesson']) assert.ok(policy.includes(text));
      for (const text of ['Excluded sibling lesson', 'Excluded module lesson']) assert.ok(!policy.includes(text));
      assert.ok(policy.indexOf('Matching ancestor lesson') < policy.indexOf('Tree lesson'));
      assert.ok(policy.indexOf('Tree lesson') < policy.indexOf('Broad project lesson'));
    } else assert.ok(!policy.includes('Active lessons'));
  }
  assert.deepEqual(lessonEvents(), before);
});
