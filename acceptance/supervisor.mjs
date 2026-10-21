#!/usr/bin/env node
// Real policy/record/watch/settle/review/dispatch/promotion, scripted transport.
import fs from 'node:fs';
import { isMain } from '../lib/cli-help.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture } from '../settle/test/fixture.mjs';
import { loadAwareCommand } from './commands.mjs';
import { waitUntil } from './load.mjs';
import { scratchFixtureCommand, scratchProductHomes, enterScratchHomes } from './environment.mjs';

// ENG-512: the native/concurrent-suite phase envelope is 1.044 s train,
// 0.347 s record closeout, 7.999 s guarded cleanup and 0.496 s delivery.
// Add a 150 ms observation cadence and 50% I/O margin, rounded up to 16 s.
// Cleanup includes the host scratch scan (ENG-511); waitUntil still applies
// the shared load factor once, independently of heavy-load classification.
export function waitForPromotionQueue(queue, until = waitUntil) {
  return until(() => queue().results.length === 1, 'finite queue completed', 16_000);
}

export async function supervisorCase(candidate, { load, execute = spawnSync,
  until = (fn, label, ms) => waitUntil(fn, label, ms, { load }) } = {}) {
  const cleanup = [], receipts = [];
  const previousActor = process.env.ORG_ACTOR;
  let restoreHomes;
  process.env.ORG_ACTOR = 'supervisor-acceptance-entry';
  try {
    const f = fixture({ after: (fn) => cleanup.push(fn) }, { source: candidate,
      actor: 'supervisor-acceptance-worker', execute: scratchFixtureCommand(loadAwareCommand(execute, load)) });
    restoreHomes = enterScratchHomes(scratchProductHomes(f.root, f.env.HOME), [f.root]);
    const command = (args) => {
      const r = f.exec(process.execPath, [path.join(candidate, 'supervisor/supervisor.mjs'), ...args]);
      assert.equal(r.status, 0, r.stderr || r.stdout); return JSON.parse(r.stdout);
    };
    const { entryPolicy } = await import(pathToFileURL(path.join(candidate, 'discovery/policy.mjs')));
    const policy = () => entryPolicy({ canonical: f.repo, org: f.org, role: 'supervisor' }, candidate);
    const watchNotice = (run) => f.calls().findLast((a) => a[0] === 'agent' && a[1] === 'prompt' && a[3]?.startsWith(`[org-report] run=${run} `))?.[3];
    // The shared fixture seeds a record for settle tests. Remove only this
    // owned scratch record so supervisor record CLI must initialize it.
    fs.rmSync(f.org, { recursive: true, force: true });
    assert.ok(!fs.existsSync(f.org));
    f.record(['init', f.org]);
    const freshPolicy = policy();
    assert.match(freshPolicy, /Supervisor cold start/);
    assert.match(freshPolicy, /Running \(record; no live pane inference\) \(0\)/);
    assert.match(freshPolicy, /Waiting on operator \(0\)/);
    assert.equal(f.calls().length, 0, 'entry and cold start never address Herdr or a model');
    assert.ok(!fs.existsSync(path.join(f.repo, '.lane.json')));

    const item = f.record(['add', 'Produce correct work', '--role', 'engineer', '--accept', 'work.txt contains correct']).split(' ')[0];
    assert.equal(item, 'ENG-1');
    const run = f.start();
    f.record(['note', f.show(run).item, 'Finish this cycle before choosing more work.', '--decision', '--summary', 'Finish the running cycle first.']);
    const historyPolicy = policy();
    assert.match(historyPolicy, new RegExp(`${run} .*engineer / codex`));
    assert.match(historyPolicy, /Finish the running cycle first/);
    assert.equal(f.calls().length, 0, 'history entry still makes no model/Herdr calls');
    receipts.push({ fresh_policy: freshPolicy, history_policy: historyPolicy });

    f.commit('wrong\n'); f.report(run);
    const watched = f.exec(process.execPath, [path.join(candidate, 'watch/watch.mjs'), run, '--org', f.org, '--to', 'supervisor-test', '--start-grace', '0']);
    assert.equal(watched.status, 0, watched.stderr);
    assert.ok(watchNotice(run), 'actual watch delivered the original final notice');
    const handled = command(['handle', '--notice', watchNotice(run), '--role', 'supervisor', '--brief', path.join(f.root, 'ask with spaces.md'), '--to', 'supervisor-test']);
    assert.equal(handled.result, 'fix_round'); receipts.push(handled);
    await until(() => watchNotice(handled.fix.run), 'actual watch delivered correction notice', 10000);
    const settled = command(['handle', '--notice', watchNotice(handled.fix.run), '--role', 'supervisor']);
    assert.equal(settled.result, 'promotable'); receipts.push(settled);
    const reviews = f.calls().filter((a) => a[1] === 'prompt' && a[3]?.includes('Private record file:')).length;
    assert.equal(command(['handle', '--notice', watchNotice(handled.fix.run), '--role', 'supervisor']).result, 'promotable');
    assert.equal(f.calls().filter((a) => a[1] === 'prompt' && a[3]?.includes('Private record file:')).length, reviews, 'duplicate notice launches no second review');

    // This explicit reason is the supervisor's promotion judgment. Everything
    // after it is mechanical and uses the actual queue and its gate/FF/close.
    const promoted = command(['promote', handled.fix.run, '--role', 'supervisor', '--why', 'Scratch project authorizes local integration after independent PASS and green validation.', '--to', 'supervisor-test']);
    receipts.push(promoted);
    const queueFile = path.join(f.repo, '.git/promote/queue.json');
    const queue = () => JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    await waitForPromotionQueue(queue, until);
    assert.equal(queue().results[0].outcome, 'promoted', JSON.stringify(queue().results));
    assert.equal(fs.readFileSync(path.join(f.repo, 'work.txt'), 'utf8'), 'correct\n');
    assert.ok(!fs.existsSync(f.workspace), 'promoted lane closed');
    assert.equal(f.git(['status', '--porcelain']), '');
    const finalNotice = queue().results[0].message;
    const closed = command(['handle', '--notice', finalNotice, '--role', 'supervisor']);
    assert.equal(closed.result, 'recorded_promotion');
    assert.equal(f.show(settled.item).status, 'done'); receipts.push(closed);
    const events = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), calls = f.calls();
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(command(['handle', '--notice', finalNotice, '--role', 'supervisor']).result, 'recorded_promotion');
      assert.equal(command(['handle', '--notice', watchNotice(handled.fix.run), '--role', 'supervisor']).result, 'recorded_promotion', 'late correction report reuses completed promotion after lane closure');
      const original = command(['handle', '--notice', watchNotice(run), '--role', 'supervisor']);
      assert.equal(original.result, 'superseded', 'late original report never settles a deleted checkout');
      assert.equal(original.run, run); assert.equal(original.current_run, handled.fix.run);
      receipts.push(original);
    }
    assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), events, 'both runs duplicate notices write no events');
    assert.deepEqual(f.calls(), calls, 'both runs duplicate notices call no model or transport');
    assert.equal(f.calls().filter((a) => a[1] === 'prompt' && a[3]?.includes('Private record file:')).length, reviews, 'late final report launches no review');
    assert.deepEqual(command(['promote', handled.fix.run, '--role', 'supervisor', '--why', 'Duplicate notice']).queue, promoted.queue);
    assert.equal(queue().results.length, 1, 'duplicate promotion never repeats the gate');
    const finalPolicy = policy();
    assert.match(finalPolicy, /Running \(record; no live pane inference\) \(0\)/);
    assert.match(finalPolicy, /Reports and settlement \(0\)/);
    f.record(['reopen', settled.item, '--note', 'Reconsider the completed work']);
    const reopenedEvents = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8');
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const notice of [finalNotice, watchNotice(handled.fix.run)]) {
        const replay = f.exec(process.execPath, [path.join(candidate, 'supervisor/supervisor.mjs'),
          'handle', '--notice', notice, '--role', 'supervisor']);
        assert.equal(replay.status, 1, replay.stdout);
        assert.match(replay.stderr, /reopened after completion/);
        assert.equal(f.show(settled.item).closed, null);
        assert.equal(f.show(settled.item).status, 'ready');
      }
      assert.equal(command(['handle', '--notice', watchNotice(run), '--role', 'supervisor']).result, 'superseded');
    }
    assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), reopenedEvents, 'replays preserve the explicit reopening');
    assert.deepEqual(f.calls(), calls, 'replays after reopening launch no model or transport');
    assert.equal(queue().results.length, 1, 'reopening never replays promotion');
    return { receipts, calls: f.calls(), final_policy: finalPolicy,
      detail: `${run} -> ${handled.fix.run}: fresh/history/restarted supervisor entry; actual watch -> settle -> independent finding -> watched fix -> PASS -> supervisor judgment -> queue gate/FF/close -> guarded record completion; duplicate original reports return supersession, correction reports reuse receipts; queue and final-report replays preserve explicit reopening; no config or model` };
  } finally {
    restoreHomes?.();
    if (previousActor === undefined) delete process.env.ORG_ACTOR; else process.env.ORG_ACTOR = previousActor;
    for (const fn of cleanup) await fn();
  }
}
if (isMain(import.meta.url)) {
  const candidate = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)));
  try { process.stdout.write(JSON.stringify(await supervisorCase(candidate), null, 2) + '\n'); }
  catch (e) { process.stderr.write(e.stack + '\n'); process.exitCode = 1; }
}
