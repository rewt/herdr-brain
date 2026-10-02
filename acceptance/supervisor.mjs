#!/usr/bin/env node
// Real entry/record/watch/settle/review/dispatch/promotion, scripted transport.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture } from '../settle/test/fixture.mjs';

export async function supervisorCase(candidate) {
  const cleanup = [], receipts = [];
  const f = fixture({ after: (fn) => cleanup.push(fn) }, { source: candidate, actor: 'supervisor-acceptance-worker' });
  const { createEntry } = await import(pathToFileURL(path.join(candidate, 'discovery/runtime.mjs')));
  const { entryPolicy } = await import(pathToFileURL(path.join(candidate, 'discovery/policy.mjs')));
  const previousActor = process.env.ORG_ACTOR;
  process.env.ORG_ACTOR = 'supervisor-acceptance-entry';
  const command = (args) => {
    const r = f.exec(process.execPath, [path.join(candidate, 'supervisor/supervisor.mjs'), ...args]);
    assert.equal(r.status, 0, r.stderr || r.stdout); return JSON.parse(r.stdout);
  };
  const entry = () => createEntry({ cwd: f.repo, role: 'supervisor', runtimeDir: path.join(f.root, 'entry'), worktreeRoot: path.join(f.root, 'workers') });
  const until = async (fn, label) => {
    const end = Date.now() + 10000;
    while (!fn() && Date.now() < end) await new Promise((r) => setTimeout(r, 40));
    assert.ok(fn(), label);
  };
  const watchNotice = (run) => f.calls().findLast((a) => a[0] === 'agent' && a[1] === 'prompt' && a[3]?.startsWith(`[org-report] run=${run} `))?.[3];
  try {
    // The shared fixture seeds a record for settle tests. Remove only this
    // owned scratch record so supervisor entry itself must bootstrap it.
    fs.rmSync(f.org, { recursive: true, force: true });
    assert.ok(!fs.existsSync(f.org));
    const fresh = entry();
    const freshPolicy = entryPolicy(fresh.context(), candidate); fresh.close();
    assert.match(freshPolicy, /Supervisor cold start/);
    assert.match(freshPolicy, /Running \(record; no live pane inference\) \(0\)/);
    assert.match(freshPolicy, /Waiting on operator \(1\)/);
    assert.equal(f.calls().length, 0, 'entry and cold start never address Herdr or a model');
    assert.ok(!fs.existsSync(path.join(f.repo, '.lane.json')));

    const item = f.record(['add', 'Produce correct work', '--role', 'engineer', '--accept', 'work.txt contains correct']).split(' ')[0];
    assert.equal(item, 'ENG-1');
    const run = f.start();
    f.record(['note', f.show(run).item, 'Finish this cycle before choosing more work.', '--decision', '--summary', 'Finish the running cycle first.']);
    const history = entry(), context = history.context();
    const historyPolicy = entryPolicy(context, candidate); history.close();
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
    await until(() => watchNotice(handled.fix.run), 'actual watch delivered correction notice');
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
    await until(() => queue().results.length === 1, 'finite queue completed');
    assert.equal(queue().results[0].outcome, 'promoted', JSON.stringify(queue().results));
    assert.equal(fs.readFileSync(path.join(f.repo, 'work.txt'), 'utf8'), 'correct\n');
    assert.ok(!fs.existsSync(f.workspace), 'promoted lane closed');
    assert.equal(f.git(['status', '--porcelain']), '');
    const finalNotice = queue().results[0].message;
    const closed = command(['handle', '--notice', finalNotice, '--role', 'supervisor']);
    assert.equal(closed.result, 'recorded_promotion');
    assert.equal(f.show(settled.item).status, 'done'); receipts.push(closed);
    assert.equal(command(['handle', '--notice', finalNotice, '--role', 'supervisor']).result, 'recorded_promotion');
    assert.deepEqual(command(['promote', handled.fix.run, '--role', 'supervisor', '--why', 'Duplicate notice']).queue, promoted.queue);
    assert.equal(queue().results.length, 1, 'duplicate promotion never repeats the gate');
    const restarted = entry();
    const finalPolicy = entryPolicy(restarted.context(), candidate); restarted.close();
    assert.match(finalPolicy, /Running \(record; no live pane inference\) \(0\)/);
    assert.match(finalPolicy, /Reports and settlement \(0\)/);
    return { receipts, calls: f.calls(), final_policy: finalPolicy,
      detail: `${run} -> ${handled.fix.run}: fresh/history/restarted supervisor entry; actual watch -> settle -> independent finding -> watched fix -> PASS -> supervisor judgment -> queue gate/FF/close -> guarded record completion; duplicates reuse receipts; no config or model` };
  } finally {
    if (previousActor === undefined) delete process.env.ORG_ACTOR; else process.env.ORG_ACTOR = previousActor;
    cleanup.forEach((fn) => fn());
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const candidate = path.resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url)));
  try { process.stdout.write(JSON.stringify(await supervisorCase(candidate), null, 2) + '\n'); }
  catch (e) { process.stderr.write(e.stack + '\n'); process.exitCode = 1; }
}
