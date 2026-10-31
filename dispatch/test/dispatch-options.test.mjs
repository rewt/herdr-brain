import test from '../../test/helpers/bounded-test.mjs';
import { createReceiptTracker } from '../../test/helpers/receipts.mjs';
import { createProcessTracker } from '../../test/helpers/processes.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hookReviewDialog, codexProfile } from '../hook-review.mjs';
import { BRAIN_CONTROLLER } from '../../lib/run-owner.mjs';
import { rememberProcesses, hooksTableScreen, startupHookReviewScreen } from './dispatch-fixture.mjs';

const WATCH = fileURLToPath(new URL('../../watch/watch.mjs', import.meta.url));
for (const source of ['fake watcher receipt', 'real watcher journal']) {
  test(`${source} refuses PID reuse before registration and retains ownership across retries`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-receipt-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const org = path.join(root, 'org'), dir = path.join(org, 'dispatch');
    fs.mkdirSync(dir, { recursive: true });
    const real = source === 'real watcher journal';
    if (real) fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ run: 'R-1', to: 'supervisor', repo: root, watcher: { pid: 101 } }));
    else fs.writeFileSync(path.join(root, 'pids'), '101\n');
    const command = real ? [process.execPath, WATCH, 'R-1', '--controller', BRAIN_CONTROLLER, '--org', org, '--to', 'supervisor', '--cwd', root,
      '--log', path.join(dir, 'R-1.watch.log')].join(' ') : [process.execPath, '-e', 'setInterval(()=>{},1000)', '--', root].join(' ');
    const suite = { pid: 700, ppid: 1, pgid: 700, state: 'S', identity: 'suite birth', command: 'suite worker' };
    const signals = [], rows = new Map([[700, suite]]);
    const receipts = createReceiptTracker({ suitePid: 700, tracker: createProcessTracker({
      readIdentity: pid => ({ ok: true, value: rows.get(pid) ?? null }),
      sendSignal: pid => signals.push(pid), report: () => {},
    }) });
    // Same command outside the suite, and an unrelated command inside it, both
    // represent replacement processes before the first receipt registration.
    for (const replacement of [{ command, pgid: 900 }, { command: 'operator session', pgid: 700 }]) {
      rows.set(101, { ...suite, pid: 101, identity: 'replacement birth', ...replacement });
      rememberProcesses(root, org, real, receipts); receipts.cleanup();
      assert.deepEqual(signals, []);
    }
    rows.set(101, { ...suite, pid: 101, command, identity: 'fixture birth' });
    rememberProcesses(root, org, real, receipts);
    const original = receipts.remember(101, command);
    rows.set(101, { ...suite, pid: 101, command, identity: 'reused birth' });
    rememberProcesses(root, org, real, receipts); receipts.cleanup();
    assert.equal(receipts.remember(101, command), original);
    assert.deepEqual(signals, [], 'retry must not refresh an owned birth tuple');
    rows.set(101, { ...suite, pid: 101, command, identity: 'fixture birth' });
    receipts.cleanup(); assert.deepEqual(signals, [101]);
  });
}
test('captured Codex hooks event table detects the warning count while quoted task text stays safe', () => {
  assert.equal(hookReviewDialog(hooksTableScreen), '1 hook needs review before it can run.');
  assert.equal(hookReviewDialog(hooksTableScreen.replace('⚠ 1 hook needs review before it', '⚠️ 2 hooks need review before they')),
    '2 hooks need review before they can run.');
  assert.equal(hookReviewDialog(`\u001b[33m${hooksTableScreen}\u001b[0m`), '1 hook needs review before it can run.');
  for (const screen of [
    '⚠ 1 hook needs review before it can run.',
    '› ⚠ 1 hook needs review before it can run.',
    hooksTableScreen.replace('  Hooks\n', '› Hooks\n'),
    hooksTableScreen.replace('  ⚠', '› ⚠'),
    hooksTableScreen.replace('  t trust all', '› t trust all'),
    hooksTableScreen.split('\n').map(line => `> ${line}`).join('\n'),
    hooksTableScreen.split('\n').map(line => `› ${line}`).join('\n'),
  ]) assert.equal(hookReviewDialog(screen), undefined, screen);
});
test('hook dialog detection handles ANSI, borders, plural counts and wrapping without matching task prose', () => {
  for (const [screen, name] of [
    [startupHookReviewScreen, '1 hook is new or changed.'],
    [startupHookReviewScreen.replace('1 hook is', '3 hooks are'), '3 hooks are new or changed.'],
    [startupHookReviewScreen.replace('1 hook is new or changed.', ''), 'Hooks need review'],
    ['Hooks need review\n1 hook is new or changed.', '1 hook is new or changed.'],
    ['│ Hooks need review │\n│ 2 hooks are new or │\n│ changed. │', '2 hooks are new or changed.'],
    ['1 hook needs review before it can run.', '1 hook needs review before it can run.'],
    ['│ 2 hooks need review before they can run. │', '2 hooks need review before they can run.'],
    ['1 hook needs review', '1 hook needs review'],
    ['\u001b[1m│ 2 hooks need review │\u001b[0m', '2 hooks need review'],
    ['╭──╮\n  1 hook needs\n  review\n╰──╯', '1 hook needs review'],
  ]) {
    assert.equal(hookReviewDialog(screen), name);
  }
  for (const screen of [
    '› Ready', '0 hooks pending', 'Explain why 1 hook needs review', '› Fix "1 hook needs review"',
    '› 1 hook needs review', '› 1 hook needs review before it can run.',
    'Explain why Hooks need review\n1 hook is new or changed.',
    '› Hooks need review\n1 hook is new or changed.',
    'Hooks need review\n› 1 hook is new or changed.',
    '› Trust all and continue', 'Hooks need review', '1 hook is new or changed.',
    'Hooks need review\nExplain Trust all and continue',
  ]) assert.equal(hookReviewDialog(screen), undefined, screen);
  for (const args of [['-p', 'worker'], ['--profile', 'worker'], ['--profile=worker'], ['-pworker']]) assert.equal(codexProfile(args), 'worker');
  assert.equal(codexProfile(['-p', 'old', '--profile=new']), 'new');
  assert.equal(codexProfile([]), undefined);
});

import {fixture} from './dispatch-fixture.mjs';
test('shared watcher selection is saved only for a new dispatch and retained on its original retry',t=>{
  const f=fixture(t),r=f.start(['--watch-mode','shared']);assert.equal(r.status,0,r.stderr);
  const job=JSON.parse(fs.readFileSync(f.jobs()[0]));assert.equal(job.watchMode,'shared');
  const arms=f.calls().filter(c=>c.type==='watch');assert.equal(arms.length,1);assert.ok(arms[0].a.includes('--shared'));assert.ok(!arms[0].a.includes('--detach'));
  const retry=f.dispatch(['--retry',job.run,'--watch-mode','process']);assert.equal(retry.status,1);assert.match(retry.stderr,/retain saved watcher mode/);
  assert.equal(JSON.parse(fs.readFileSync(f.jobs()[0])).watchMode,'shared');
});
