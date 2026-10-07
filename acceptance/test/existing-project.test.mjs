import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inventory } from './cutover-fixture.mjs';
import { copyExistingProject, existingProjectFiles } from '../existing-project.mjs';
import { callers } from '../cutover.mjs';

function setup(t) {
  const { root, copy: live } = inventory(t);
  const copy = path.join(root, 'rehearsal'), backup = path.join(root, 'backup');
  const write = (rel, text, mode = 0o640) => {
    const file = path.join(live, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode });
    return file;
  };
  return { live, copy, backup, write };
}

test('existing-project copy follows new untracked supervisor scripts and required documents', t => {
  const f = setup(t);
  // No Git inventory or per-filename copier update: this dispatch acquires two
  // new dependencies after the original project snapshot was taken.
  f.write('.lane/supervisor/dispatch.sh', '#!/bin/sh\nset -eu\ncat .lane/supervisor/no-poll-waiting.md\n.lane/supervisor/support/new-reader.sh\n', 0o751);
  f.write('.lane/supervisor/no-poll-waiting.md', 'Required waiting instructions\n', 0o640);
  f.write('.lane/supervisor/support/new-reader.sh', '#!/bin/sh\nset -eu\ncat .lane/supervisor/support/new-guidance.txt\n', 0o750);
  f.write('.lane/supervisor/support/new-guidance.txt', 'Nested guidance\n');
  const sourceBefore = fs.readFileSync(path.join(f.live, '.lane/supervisor/dispatch.sh'));
  const copied = copyExistingProject(f);
  const result = spawnSync('/bin/sh', ['.lane/supervisor/dispatch.sh'], { cwd: f.copy, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'Required waiting instructions\nNested guidance\n');
  assert.deepEqual(fs.readFileSync(path.join(f.live, '.lane/supervisor/dispatch.sh')), sourceBefore);
  for (const rel of ['dispatch.sh', 'no-poll-waiting.md', 'support/new-reader.sh', 'support/new-guidance.txt']) {
    const file = `.lane/supervisor/${rel}`, original = fs.readFileSync(path.join(f.live, file));
    const entry = copied.files.find(v => v.file === file);
    assert.ok(entry, file);
    assert.equal(entry.sha256, crypto.createHash('sha256').update(original).digest('hex'));
    for (const destination of [f.copy, f.backup]) {
      assert.deepEqual(fs.readFileSync(path.join(destination, file)), original);
      assert.equal(fs.statSync(path.join(destination, file)).mode & 0o777, entry.mode);
    }
  }
  // A missing required document must still fail; copying is not a stubbed read.
  fs.unlinkSync(path.join(f.copy, '.lane/supervisor/no-poll-waiting.md'));
  assert.notEqual(spawnSync('/bin/sh', ['.lane/supervisor/dispatch.sh'], { cwd: f.copy }).status, 0);
});

test('existing-project copy excludes logs, queues, runtime state and unreferenced backups', t => {
  const f = setup(t);
  const runtime = ['inbox.log', 'notify-log.tsv', 'sessions-20261007.log', 'slot-queue.tsv', 'promote-queue.txt',
    'watch-logs/R-1.log', 'outbox/R-1.msg', 'outbox/accidental-helper.sh', 'logs/trace.json', 'state/receipt.json',
    'runtime/current.json', 'cache/data.md', '__pycache__/helper.pyc', 'worker.pid', 'dispatch.flock',
    'OPEN-STATE.md', 'TODAY.md', 'GAPS.md', 'file-woken.txt', 'engineer-gates-off', 'checkpoint-20261007.html'];
  for (const rel of runtime) f.write(`.lane/supervisor/${rel}`, 'runtime');
  // Ignored runtime directories may contain links; they must never be followed.
  fs.symlinkSync(f.live, path.join(f.live, '.lane/supervisor/outbox/link'));
  f.write('.lane/supervisor/old.sh.bak-20261007-unused', 'node contrib/settle-watch.mjs\n');
  f.write('.lane/supervisor/new-queue.sh', '#!/bin/sh\necho queue helper\n');
  f.write('.lane/supervisor/new-log-reader.sh', '#!/bin/sh\necho log helper\n');
  const copied = copyExistingProject(f);
  assert.ok(copied.files.some(v => v.file === '.lane/supervisor/new-queue.sh'));
  assert.ok(copied.files.some(v => v.file === '.lane/supervisor/new-log-reader.sh'));
  for (const rel of runtime) {
    assert.ok(!copied.files.some(v => v.file === `.lane/supervisor/${rel}`), rel);
    assert.ok(!fs.existsSync(path.join(f.copy, '.lane/supervisor', rel)), rel);
    assert.ok(!fs.existsSync(path.join(f.backup, '.lane/supervisor', rel)), rel);
  }
  assert.ok(!fs.existsSync(path.join(f.copy, '.lane/supervisor/old.sh.bak-20261007-unused')));
  assert.ok(copied.historical.some(v => v.file.endsWith('old.sh.bak-20261007-unused')));
  assert.equal(fs.readFileSync(path.join(f.backup, 'historical-callers/.lane/supervisor/old.sh.bak-20261007-unused'), 'utf8'), 'node contrib/settle-watch.mjs\n');
});

test('existing-project copy retains transitive referenced readable script backups for retirement', t => {
  const f = setup(t);
  f.write('.lane/supervisor/new.sh', 'python3 .lane/supervisor/helper.py.bak-20261007-first\n');
  f.write('.lane/supervisor/helper.py.bak-20261007-first', 'exec(open("helper.py.bak-20261007-second").read())\n');
  f.write('.lane/supervisor/helper.py.bak-20261007-second', 'run("node contrib/settle-watch.mjs")\n');
  f.write('.lane/supervisor/new-reader.cjs', 'require("./helper.js.bak-20261007-required");\n');
  f.write('.lane/supervisor/helper.js.bak-20261007-required', 'run("node contrib/settle-watch.mjs");\n');
  const copied = copyExistingProject(f);
  for (const suffix of ['first', 'second']) {
    const rel = `.lane/supervisor/helper.py.bak-20261007-${suffix}`;
    assert.ok(copied.files.some(v => v.file === rel));
    assert.ok(!copied.historical.some(v => v.file === rel));
  }
  assert.ok(callers(f.copy, 'contrib/settle-watch.mjs').some(v => v.file.endsWith('-second')));
  assert.ok(callers(f.copy, 'contrib/settle-watch.mjs').some(v => v.file.endsWith('helper.js.bak-20261007-required')));
});

test('existing-project copy refuses support symlinks and missing required regular inputs', t => {
  const f = setup(t);
  const doc = f.write('.lane/supervisor/new.md', 'guidance');
  fs.symlinkSync(doc, path.join(f.live, '.lane/supervisor/alias.md'));
  assert.throws(() => existingProjectFiles(f.live), /refuses symlink/);
  fs.unlinkSync(path.join(f.live, '.lane/supervisor/alias.md'));
  const route = path.join(f.live, 'scripts/lane/routing.json');
  fs.unlinkSync(route); fs.symlinkSync(doc, route);
  assert.throws(() => copyExistingProject(f), /refuses symlink/);
  fs.unlinkSync(route); fs.mkdirSync(route);
  assert.throws(() => copyExistingProject(f), /regular support files only/);
});
