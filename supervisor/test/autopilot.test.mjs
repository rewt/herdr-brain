import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fixture } from '../../settle/test/fixture.mjs';
import { gitProject } from '../../lib/project.mjs';
import { receiptDirectory } from '../context.mjs';
import { liveNativeWorker } from '../../promote/native-context.mjs';
import { fold } from '../../lib/state.mjs';
import { loadEvents } from '../../lib/store.mjs';
import { fastPathTiming } from '../fast-path-timing.mjs';
import { queueFor, enqueue } from '../../promote/promote.mjs';
import { autopilotNotice, autopilotSettings } from '../autopilot.mjs';
import { promptSupervisor, readInbox } from '../prompt-supervisor.mjs';
import { noticeLock } from '../notice-lock.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';
import { RECORD_CHECK_CLAIM, LEGACY_RECORD_CHECK_CLAIM } from '../../settle/report-evidence.mjs';

function setup(t, results = [], { ingest = true } = {}) {
  const f = fixture(t);
  // The pilot maps Brain's digest area. Keep the scripted review's work.txt
  // claim in the base and make the actual candidate a digest-only change.
  fs.writeFileSync(path.join(f.repo, 'work.txt'), 'correct\n');
  fs.mkdirSync(path.join(f.repo, 'brain')); fs.writeFileSync(path.join(f.repo, 'brain/output.txt'), 'base\n');
  f.git(['add', 'work.txt', 'brain/output.txt']); f.git(['commit', '-qm', 'Seed mapped area']); f.git(['rebase', 'main'], f.workspace);
  const commit = text => { fs.writeFileSync(path.join(f.workspace, 'brain/output.txt'), text); f.git(['add', '.'], f.workspace); f.git(['commit', '--allow-empty', '-qm', 'Digest change'], f.workspace); };
  commit('correct\n');
  fs.appendFileSync(path.join(f.repo, '.git/info/exclude'), '\n.org/\n.lane/\n.supervisor.json\n.housekeeping.json\n');
  fs.writeFileSync(path.join(f.repo, '.supervisor.json'), '{"autopilot":{"enabled":true,"cohort":"clean-pass"}}');
  const run = f.start();
  f.report(run);
  if (ingest) f.record(['ingest', f.show(run).report_path]);
  const config = JSON.parse(fs.readFileSync(path.join(f.org, 'config.json')));
  config.approvals.categories.tooling = 'auto';
  fs.writeFileSync(path.join(f.org, 'config.json'), JSON.stringify(config));
  const p = gitProject(f.repo), item = f.show(run).item;
  const entry = { id: 'report-1', to: 'supervisor-test', message: `[org-report] run=${run} item=${item} outcome=done headline=Done`,
    project: { repo: f.repo, identity: p.identity, org: f.org } };
  const calls = [];
  const execute = (file, args, options) => {
    calls.push({ file, args, options });
    let next = results.shift();
    if (next instanceof Error) throw next;
    assert.notEqual(next, undefined, 'unexpected command');
    if (next?.result === 'promotable' && args[0] === 'handle') {
      const head = f.git(['rev-parse', 'HEAD'], f.workspace), mainHead = f.git(['rev-parse', 'main']);
      const text = '## Findings\nNone\n\n## Analysis\nScripted clean review.\n';
      const review = { ...next.review, text, sha256: createHash('sha256').update(text).digest('hex'), path: path.join(f.workspace, 'docs/reviews/offline.md') };
      next = { ...next, run, head, reviewed_commit: head, review };
      fs.mkdirSync(path.join(f.org, 'settle'), { recursive: true });
      fs.writeFileSync(path.join(f.org, 'settle', `${run}.json`), JSON.stringify({ common: p.identity, org: f.org, run,
        stage: 'complete', head, finalHead: head, mainHead, review, result: next }));
    }
    return typeof next === 'string' ? next : JSON.stringify(next);
  };
  return { ...f, commit, nativeWorker: () => ({ pid: 1 }), herdrCalls: f.calls, run, item, entry, calls, execute, apply: () => autopilotNotice(entry, { execute, nativeWorker: () => ({ pid: 1 }) }) };
}
async function existingWorker(t, f, { refuse = false } = {}) {
  const anchor = path.join(f.root, 'anchor'), release = path.join(f.root, 'release-worker'), started = path.join(f.root, 'worker-gate-started');
  f.git(['worktree', 'add', '-qb', 'lane/anchor', anchor]);
  fs.writeFileSync(path.join(anchor, 'anchor.txt'), 'anchor'); f.git(['add', '.'], anchor); f.git(['commit', '-qm', 'Anchor'], anchor);
  const checker = path.join(f.root, 'anchor-check.cjs');
  fs.writeFileSync(checker, `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'started');const deadline=Date.now()+${loadTimeout(60000)};while(!fs.existsSync(${JSON.stringify(release)})&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);console.log('gate complete');process.exitCode=${refuse ? 1 : 0};`);
  const queue = queueFor(f.repo);
  enqueue(queue, ['anchor'], { to: f.entry.to, herdr: path.join(f.root, 'bin/herdr'), attempts: 1, retry: 0,
    laneCLI: path.join(f.source, 'lanes/lane.mjs'), validate: `${process.execPath} ${checker}`, org: null });
  const pending = f.concurrent('--drain', path.join(f.source, 'promote/promote.mjs'), ['--repo', f.repo]);
  let stderr = ''; pending.child.stderr.on('data', data => { stderr += data; });
  t.after(() => { if (fs.existsSync(f.root)) fs.writeFileSync(release, 'release'); });
  const deadline = Date.now() + loadTimeout(10000);
  while (!fs.existsSync(started) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  if (!fs.existsSync(started)) {
    fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true }); fs.writeFileSync(path.join(f.repo, '.lane/supervisor/STOP'), 'Fixture startup failed');
    fs.writeFileSync(release, 'release');
  }
  assert.ok(fs.existsSync(started), JSON.stringify({ queue: queue.load(), stderr, logs: queue.load().results.map(job => job.log && fs.existsSync(job.log) ? fs.readFileSync(job.log, 'utf8') : null) }, null, 2)); assert.ok(liveNativeWorker(f.entry.project.identity));
  return () => fs.writeFileSync(release, 'release');
}
const pass = { result: 'promotable', review: { verdict: 'PASS' } };
const minor = '- [Minor] supervisor/x.mjs:1 - Improve text; Fix: clarify it';

test('done handles, PASS promotes with named policy, and duplicate notices do no work', t => {
  const f = setup(t, [pass, { phase: 'acknowledged' }]);
  assert.equal(f.apply().disposition, 'handled');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].args.slice(0, 2), ['handle', f.run]);
  assert.equal(f.calls[1].args[0], 'promote'); assert.ok(f.calls[1].args.includes('--existing-worker'));
  assert.match(f.calls[1].args[f.calls[1].args.indexOf('--why') + 1], /notice-autopilot\/v1.*PASS/);
  assert.equal(f.calls[0].options.cwd, f.repo);
  f.entry.id = 'another-delivery-id';
  assert.equal(f.apply().disposition, 'handled');
  assert.equal(f.calls.length, 2);
});
test('fix_round is left in flight', t => {
  const f = setup(t, [{ result: 'fix_round', review: { verdict: 'NEEDS-WORK' }, review_policy: { cap: 2, round: 1 } }]);
  assert.equal(f.apply().disposition, 'handled'); assert.equal(f.calls.length, 1);
});
test('base movement gets exactly one handle retry', t => {
  const f = setup(t, [{ result: 'escalate', reason: 'base branch moved; use --retry to recapture and rebase' }, pass, { phase: 'acknowledged' }]);
  assert.equal(f.apply().disposition, 'handled');
  assert.ok(f.calls[1].args.includes('--retry'));
  assert.ok(!f.calls[1].args.includes('--to'));
});
test('repeated base movement wakes and never repeats the retry', t => {
  const moved = { result: 'escalate', reason: 'base branch moved; use --retry to recapture and rebase' };
  const f = setup(t, [moved, moved]);
  assert.equal(f.apply().disposition, 'wake'); assert.equal(f.calls.length, 2);
  assert.equal(f.apply().disposition, 'wake'); assert.equal(f.calls.length, 2);
});
for (const kind of ['unknown', 'wrong-run', 'wrong-journal', 'wrong-receipt', 'wrong-exit', 'signal'])
  test(`exit-one ${kind} refusal retains evidence and never authorizes a retry`, t => {
    const f = setup(t), journal = path.join(f.org, 'settle', `${f.run}.json`);
    const reason = 'base branch moved; use --retry to recapture and rebase';
    const data = { result: 'escalate', run: f.run, journal, reason };
    if (kind === 'unknown') data.reason = 'some other refusal';
    if (kind === 'wrong-run') data.run = 'R-999';
    if (kind === 'wrong-journal') data.journal = path.join(f.root, 'foreign.json');
    let calls = 0;
    const call = () => {
      calls++;
      fs.mkdirSync(path.dirname(journal), { recursive: true });
      fs.writeFileSync(journal, JSON.stringify({ run: f.run, common: f.entry.project.identity, org: f.org,
        stage: 'commit-review', error: kind === 'wrong-receipt' ? 'unrelated' : data.reason }));
      return { status: kind === 'wrong-exit' ? 2 : 1, stdout: JSON.stringify(data), stderr: 'retained refusal', signal: kind === 'signal' ? 'SIGTERM' : null };
    };
    const result = autopilotNotice(f.entry, { execute: call, nativeWorker: f.nativeWorker });
    assert.equal(result.disposition, 'wake'); assert.equal(calls, 1);
    const saved = JSON.parse(fs.readFileSync(result.receipt));
    assert.equal(saved.retry_used, undefined); assert.equal(saved.actions[0].phase, 'started');
    assert.equal(saved.actions[0].stderr, 'retained refusal'); assert.deepEqual(saved.actions[0].result, data);
  });
test('Moderate and Minor findings use the ordinary path without filing or accepting them', t => {
  const findings = minor + '\n- [Moderate] supervisor/y.mjs:2 - Missing detail; Fix: add detail';
  const f = setup(t, [{ result: 'promotable_with_findings', review: { verdict: 'NEEDS-WORK' }, findings, review_policy: { cap: 1, round: 1 } }, 'ENG-999\n', { phase: 'acknowledged' }]);
  assert.equal(f.apply().disposition, 'wake');
  assert.equal(f.calls.length, 1);
  assert.match(JSON.parse(fs.readFileSync(f.apply().receipt)).reason, /AUTOPILOT_FINDINGS/);
  assert.equal(f.apply().disposition, 'wake'); assert.equal(f.calls.length, 1);
});
for (const [name, value] of Object.entries({
  unknown: { result: 'new-result' }, uncertain: { result: 'incomplete' }, interrupted: { result: 'stopped' },
  refusal: { result: 'escalate', reason: 'refused' }, fail: { ...pass, review: { verdict: 'FAIL' } },
  cappedMajor: { result: 'fix_round', review: { verdict: 'NEEDS-WORK' }, findings: '- [Major] x.mjs:1 - Broken; Fix: repair', review_policy: { cap: 1, round: 1 } },
  unparsed: { result: 'promotable_with_findings', review: { verdict: 'NEEDS-WORK' }, findings: 'uncertain severity' },
  noPASS: { result: 'promotable' },
  cappedUnknown: { result: 'fix_round', review: { verdict: 'NEEDS-WORK' }, review_policy: { cap: 1, round: 1 } },
})) test(`${name} result wakes with the original notice, reason and receipt`, t => {
  const f = setup(t, [value]), result = f.apply();
  assert.equal(result.disposition, 'wake'); assert.ok(fs.existsSync(result.receipt));
  assert.ok(result.summary.startsWith(`${f.entry.message}\n[autopilot] `));
  assert.ok(result.summary.includes(result.receipt));
  assert.equal(f.calls.length, 1);
});
for (const kind of ['STOP', 'paused', 'kill', 'invalidConfig', 'nullConfig', 'nullPolicy', 'reserved', 'category', 'questions', 'blocked', 'foreign', 'torn', 'superseded', 'incomplete'])
  test(`${kind} disables automatic mutations and wakes`, t => {
    const f = setup(t);
    if (kind === 'STOP') { fs.mkdirSync(path.join(f.repo, '.lane/supervisor'), { recursive: true }); fs.writeFileSync(path.join(f.repo, '.lane/supervisor/STOP'), 'stop'); }
    if (kind === 'paused') fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
    if (kind === 'kill') fs.writeFileSync(path.join(f.repo, '.supervisor.json'), '{"autopilot":{"enabled":false}}');
    if (kind === 'invalidConfig') fs.writeFileSync(path.join(f.repo, '.supervisor.json'), '{');
    if (kind === 'nullConfig') fs.writeFileSync(path.join(f.repo, '.supervisor.json'), 'null');
    if (kind === 'nullPolicy') fs.writeFileSync(path.join(f.repo, '.supervisor.json'), '{"autopilot":null}');
    if (kind === 'reserved') f.record(['set', f.item, 'meta.operator_reserved=true']);
    if (kind === 'category') f.record(['set', f.item, 'meta.category=publish']);
    if (kind === 'blocked') f.entry.message = f.entry.message.replace('outcome=done', 'outcome=blocked');
    if (kind === 'questions') {
      const report = f.show(f.run).report_path, next = f.start(); f.report(next);
      fs.writeFileSync(f.show(next).report_path, fs.readFileSync(report, 'utf8').replace(`run: ${f.run}`, `run: ${next}`).replace('proposals: []', 'questions: [{question: "Proceed?", category: publish, recommend: no, why: "Operator decides"}]\nproposals: []'));
      f.record(['ingest', f.show(next).report_path]); f.entry.message = f.entry.message.replace(f.run, next);
    }
    if (kind === 'foreign') f.entry.project.identity = '/foreign/.git';
    if (kind === 'torn') fs.appendFileSync(path.join(f.org, 'events.jsonl'), '{');
    if (kind === 'superseded') f.start();
    if (kind === 'incomplete') { fs.mkdirSync(path.join(f.org, 'settle'), { recursive: true }); fs.writeFileSync(path.join(f.org, 'settle', `${f.run}.json`), JSON.stringify({ common: f.entry.project.identity, run: f.run, stage: 'reviewing' })); }
    assert.equal(f.apply().disposition, 'wake'); assert.equal(f.calls.length, 0);
  });
test('an unacknowledged action wakes on replay instead of running again', t => {
  const f = setup(t, [new Error('lost reply')]);
  assert.equal(f.apply().disposition, 'wake');
  assert.equal(f.apply().disposition, 'wake'); assert.equal(f.calls.length, 1);
});
test('a sequence interrupted after acknowledged actions wakes without repeating a follow-up', t => {
  const f = setup(t, [pass, { phase: 'acknowledged' }]), receipt = f.apply().receipt;
  const saved = JSON.parse(fs.readFileSync(receipt)); delete saved.disposition;
  fs.writeFileSync(receipt, JSON.stringify(saved));
  assert.equal(f.apply().disposition, 'wake'); assert.equal(f.calls.length, 2);
});
test('a corrupted action receipt wakes and preserves the evidence bytes', t => {
  const f = setup(t, [pass, { phase: 'acknowledged' }]), file = f.apply().receipt;
  fs.writeFileSync(file, '{broken');
  const result = f.apply();
  assert.equal(result.disposition, 'wake'); assert.equal(f.calls.length, 2);
  assert.equal(result.summary, f.entry.message); assert.match(result.reason, /unreadable action receipt/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('reserved report decisions wake even when the work item has no category', t => {
  const f = setup(t), run = f.start(); f.report(run);
  const file = f.show(run).report_path;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('proposals: []', 'decisions: [{text: "Change license", category: licensing, why: "New terms"}]\nproposals: []'));
  f.record(['ingest', file]); f.entry.message = f.entry.message.replace(f.run, run);
  assert.equal(f.apply().disposition, 'wake'); assert.equal(f.calls.length, 0);
});
for (const kind of ['missing', 'malformed', 'wrong-run', 'blocked', 'needs_human', 'failed', 'questions', 'blockers', 'reserved-decision', 'uncategorized-decision', 'category-evidence'])
  test(`un-ingested ${kind} report wakes before intake`, t => {
    const f = setup(t, [], { ingest: false }), file = f.show(f.run).report_path;
    const data = { run: f.run, outcome: 'done', summary: 'Work complete', headline: 'Work complete', blockers: [], proposals: [] };
    if (kind === 'wrong-run') data.run = 'R-999';
    if (['blocked', 'needs_human', 'failed'].includes(kind)) data.outcome = kind;
    if (kind === 'questions') data.questions = [{ question: 'Proceed?', category: 'tooling' }];
    if (kind === 'blockers') data.blockers = ['Need a scope decision'];
    if (kind === 'reserved-decision') data.decisions = [{ text: 'Change license', category: 'licensing' }];
    if (kind === 'uncategorized-decision') data.decisions = [{ text: 'Needs judgment' }];
    if (kind === 'category-evidence') data.decisions = [{ text: 'Deploy the change', category: 'tooling' }];
    fs.writeFileSync(file, kind === 'malformed' ? 'incomplete' : `---\n${JSON.stringify(data)}\n---\n`);
    if (kind === 'missing') fs.unlinkSync(file);
    const before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
    assert.equal(f.apply().disposition, 'wake'); assert.equal(f.calls.length, 0);
    assert.equal(f.show(f.run).report, null);
    assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
  });
test('a pending report cannot authorize promotion if handle did not perform intake', t => {
  const f = setup(t, [pass], { ingest: false });
  assert.equal(f.apply().disposition, 'wake'); assert.equal(f.calls.length, 1);
  assert.equal(f.show(f.run).report, null);
});
test('a pause appearing after handle prevents promotion', t => {
  const f = setup(t, [pass]);
  const call = (file, args, options) => {
    const result = f.execute(file, args, options);
    fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
    return result;
  };
  assert.equal(autopilotNotice(f.entry, { execute: call, nativeWorker: f.nativeWorker }).disposition, 'wake');
  assert.equal(f.calls.length, 1);
});
test('reopening after a handled notice wakes and retains the operator change', t => {
  const f = setup(t, [pass, { phase: 'acknowledged' }]); f.apply();
  f.record(['close', f.item]); f.record(['reopen', f.item]);
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  assert.equal(f.apply().disposition, 'wake'); assert.equal(f.calls.length, 2);
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
});
test('promotion refusal and every unknown notice wake without commands', t => {
  const f = setup(t);
  for (const message of ['[promote-queue] id=job lane=topic outcome=refused reason="red"', '[release-gate] PASS', '[org-watch] no-report', '[new-notice] unknown']) {
    f.entry.id = message; f.entry.message = message;
    assert.equal(f.apply().disposition, 'wake');
  }
  assert.equal(f.calls.length, 0);
});
for (const record of ['healthy', 'missing', 'unreadable', 'malformed'])
test(`intermediate notices pass through unchanged with a ${record} record`, t => {
  const f = setup(t), log = path.join(f.org, 'events.jsonl');
  if (record === 'missing') fs.unlinkSync(log);
  if (record === 'unreadable') { fs.unlinkSync(log); fs.mkdirSync(log); }
  if (record === 'malformed') fs.writeFileSync(log, 'invalid JSON\n');
  for (const kind of ['watch-long-running', 'watch-blocked', 'watch-no-report', 'watch-invalid-report', 'watch-unavailable', 'new-notice']) {
    f.entry.id = `watch:${f.run}:${kind}`;
    f.entry.message = `[${kind}] run=${f.run} item=${f.item} worker=lane-nine  still-running=2m\nDetail with trailing spaces.  `;
    const result = f.apply();
    assert.equal(result.disposition, 'wake');
    assert.equal(result.summary, f.entry.message);
    const saved = JSON.parse(fs.readFileSync(result.receipt));
    assert.equal(saved.notice, f.entry.message); assert.equal(saved.notice_id, f.entry.id);
    assert.match(saved.reason, /unrecognised notice/); assert.deepEqual(saved.actions, []);
  }
  assert.equal(f.calls.length, 0);
});
for (const record of ['missing', 'unreadable', 'malformed'])
test(`a ${record} record prevents classification without changing a report notice`, t => {
  const f = setup(t), log = path.join(f.org, 'events.jsonl');
  const before = fs.readFileSync(log);
  fs.unlinkSync(log);
  if (record === 'unreadable') fs.mkdirSync(log);
  if (record === 'malformed') fs.writeFileSync(log, 'invalid JSON\n');
  const result = f.apply(), saved = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal(result.disposition, 'wake'); assert.equal(result.summary, f.entry.message);
  assert.ok(saved.error); assert.ok(saved.reason); assert.deepEqual(saved.actions, []);
  if (record === 'unreadable') fs.rmdirSync(log);
  fs.writeFileSync(log, before);
  assert.equal(f.apply().summary, f.entry.message, 'replay after record recovery preserves the original payload');
  assert.equal(f.calls.length, 0);
});
test('promoted queue notice handles its bound run and a closed item is a no-op', t => {
  const f = setup(t, [{ result: 'recorded_promotion' }]), project = f.entry.project;
  const execute = (file, args, options) => { f.record(['close', f.item]); return f.execute(file, args, options); };
  fs.mkdirSync(path.join(project.identity, 'promote'), { recursive: true });
  fs.writeFileSync(path.join(project.identity, 'promote/queue.json'), JSON.stringify({ identity: project.identity, pending: [], current: null, results: [{ id: 'job', topic: 'topic', run: f.run, org: f.org, outcome: 'promoted' }] }));
  f.entry.message = '[promote-queue] id=job lane=topic outcome=promoted reason="landed"';
  assert.equal(autopilotNotice(f.entry, { execute }).disposition, 'handled'); assert.ok(f.calls[0].args.includes('--notice'));
  const saved = JSON.parse(fs.readFileSync(f.apply().receipt)); assert.equal(saved.actions.length, 1);
  f.record(['close', f.item]); f.entry.message = f.entry.message.replace('id=job', 'id=other');
  const q = JSON.parse(fs.readFileSync(path.join(project.identity, 'promote/queue.json'))); q.results[0].id = 'other';
  fs.writeFileSync(path.join(project.identity, 'promote/queue.json'), JSON.stringify(q));
  assert.equal(f.apply().disposition, 'handled'); assert.equal(f.calls.length, 1);
});
function promotionQueue(f, job) {
  const directory = path.join(f.entry.project.identity, 'promote');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'queue.json'), JSON.stringify({ identity: f.entry.project.identity, pending: [], current: null, results: [job] }));
}
for (const [id, topic] of [['7e203ad6-dca3-429b-9059-ac2c7f29e750', 'fleet-membership'], ['58c5c2da-a048-469f-bc44-8bbdce18a0a3', 'gate-profile']])
test(`runless completion ${topic} retains an explicit binding diagnostic`, t => {
  const f = setup(t);
  promotionQueue(f, { id, topic, org: f.org, outcome: 'promoted', reason: 'green batch fast-forward' });
  f.entry.id = `promote:${id}`;
  f.entry.message = `[promote-queue] id=${id} lane=${topic} outcome=promoted reason="green batch fast-forward"`;
  const result = f.apply(), saved = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal(result.disposition, 'wake'); assert.match(saved.reason, /promotion.*run binding/i);
  assert.doesNotMatch(saved.reason, /reading 'closed'/); assert.equal(f.calls.length, 0);
});
test('completion after an interrupted promotion has its own receipt and closes once', t => {
  const f = setup(t, [{ result: 'recorded_promotion' }]);
  f.entry.id = 'promote:job'; f.entry.message = '[promote-queue] id=job lane=topic outcome=interrupted';
  const interrupted = f.apply(); assert.equal(interrupted.disposition, 'wake');
  promotionQueue(f, { id: 'job', topic: 'topic', run: f.run, org: f.org, outcome: 'promoted' });
  f.entry.id = 'promote:job:complete'; f.entry.message = '[promote-queue] id=job lane=topic outcome=promoted';
  const execute = (file, args, options) => { f.record(['close', f.item]); return f.execute(file, args, options); };
  const completed = autopilotNotice(f.entry, { execute }); assert.equal(completed.disposition, 'handled');
  assert.notEqual(completed.receipt, interrupted.receipt); assert.equal(f.calls.length, 1);
  assert.equal(f.apply().disposition, 'handled'); assert.equal(f.calls.length, 1);
  assert.match(JSON.parse(fs.readFileSync(interrupted.receipt)).reason, /interrupted/);
});
for (const kind of ['watch-no-report', 'watch-long-running', 'watch-invalid-report', 'org-report'])
test(`abandoned ${kind} is journaled without waking or acting`, t => {
  const f = setup(t, [], { ingest: false }); f.record(['abandon', f.run, '--note', 'Replaced']);
  f.entry.id = `watch:${f.run}:${kind}`;
  if (kind !== 'org-report') f.entry.message = `[${kind}] run=${f.run} item=${f.item} worker=old`;
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  const result = f.apply(); assert.equal(result.disposition, 'handled');
  assert.match(JSON.parse(fs.readFileSync(result.receipt)).reason, /abandoned/);
  assert.equal(f.calls.length, 0); assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), before);
});
test('awaited promotion closes before waking with one short plan line and later notices stay silent', t => {
  const f = setup(t);
  f.record(['set', f.item, 'meta.notify=supervisor', 'meta.notify_step=Cut RC-11']);
  promotionQueue(f, { id: 'job', topic: 'topic', run: f.run, org: f.org, outcome: 'promoted' });
  f.entry.id = 'promote:job'; f.entry.message = '[promote-queue] id=job lane=topic outcome=promoted';
  let calls = 0;
  const execute = () => {
    calls++; f.record(['close', f.item, '--if-current-run', f.run, '--note', 'Verified promotion']);
    return JSON.stringify({ result: 'recorded_promotion', run: f.run, item: f.item });
  };
  const result = autopilotNotice(f.entry, { execute });
  assert.equal(f.show(f.item).closed.as, 'done'); assert.equal(result.disposition, 'wake');
  assert.equal(result.summary, `[autopilot] ${f.item} landed; unblocks: Cut RC-11`);
  assert.equal(autopilotNotice(f.entry, { execute }).summary, result.summary); assert.equal(calls, 1);
  f.entry.id = 'promote:job:late';
  assert.equal(autopilotNotice(f.entry, { execute }).disposition, 'handled'); assert.equal(calls, 1);
});
test('awaited PASS queued for promotion stays silent until closure', t => {
  const f = setup(t, [pass, { phase: 'acknowledged' }]);
  f.record(['set', f.item, 'meta.notify=supervisor']);
  assert.equal(f.apply().disposition, 'handled'); assert.equal(f.show(f.item).closed, null);
});
test('a delayed report can notify an awaited landing without a plan step and deduplicates the queue notice', t => {
  const f = setup(t); f.record(['set', f.item, 'meta.notify=supervisor']);
  let calls = 0;
  const execute = () => {
    calls++; f.record(['close', f.item, '--if-current-run', f.run]);
    return JSON.stringify({ result: 'recorded_promotion', run: f.run, item: f.item });
  };
  const result = autopilotNotice(f.entry, { execute });
  assert.equal(result.disposition, 'wake'); assert.equal(result.summary, `[autopilot] ${f.item} landed`);
  const saved = JSON.parse(fs.readFileSync(result.receipt)); delete saved.disposition;
  fs.writeFileSync(result.receipt, JSON.stringify(saved));
  assert.equal(autopilotNotice(f.entry, { execute }).summary, result.summary, 'interrupted notification keeps delivery text');
  promotionQueue(f, { id: 'job', topic: 'topic', run: f.run, org: f.org, outcome: 'promoted' });
  f.entry.id = 'promote:job'; f.entry.message = '[promote-queue] id=job lane=topic outcome=promoted';
  assert.equal(autopilotNotice(f.entry, { execute }).disposition, 'handled'); assert.equal(calls, 1);
});
test('abandoned watcher inbox entry is handled without Herdr delivery', async t => {
  const f = setup(t, [], { ingest: false }); f.record(['abandon', f.run]);
  f.entry.message = `[watch-no-report] run=${f.run} item=${f.item} worker=old`;
  const result = await promptSupervisor(f.entry.to, f.entry.message, { org: f.org, cwd: f.repo, id: `watch:${f.run}:no-report`, waitSeconds: 0 });
  assert.equal(result.handled, true); assert.deepEqual(f.herdrCalls(), []);
  const entry = readInbox(result.inbox)[0]; assert.equal(entry.state, 'handled');
  assert.equal(entry.message, f.entry.message); assert.match(entry.autopilot.summary, /watch-no-report/);
});
test('legacy uncertain promotion receipts still forbid command replay after the key upgrade', t => {
  const f = setup(t), key = 'promotion:job';
  const directory = path.join(receiptDirectory(f.org, f.entry.project.identity), 'autopilot');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  const notice = '[promote-queue] id=job lane=topic outcome=promoted';
  const bytes = JSON.stringify({ policy: 'notice-autopilot/v1', key, project: f.entry.project,
    notice, notice_id: 'promote:job', actions: [{ phase: 'started' }] });
  fs.writeFileSync(file, bytes);
  promotionQueue(f, { id: 'job', topic: 'topic', run: f.run, org: f.org, outcome: 'promoted' });
  f.entry.id = 'promote:job'; f.entry.message = notice;
  const result = f.apply(); assert.equal(result.disposition, 'wake');
  assert.match(JSON.parse(fs.readFileSync(result.receipt)).reason, /uncertain/);
  assert.equal(f.calls.length, 0); assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});
test('inbox consumes routine results before any Herdr delivery and retains original notice', async t => {
  const f = setup(t, [pass, { phase: 'acknowledged' }]);
  const result = await promptSupervisor(f.entry.to, f.entry.message, { org: f.org, cwd: f.repo, id: 'routine',
    executeAutopilot: f.execute, nativeAutopilotWorker: f.nativeWorker, waitSeconds: 0 });
  assert.equal(result.delivered, true); assert.equal(result.handled, true);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.herdrCalls(), []);
  const entry = readInbox(result.inbox)[0];
  assert.equal(entry.message, f.entry.message); assert.equal(entry.state, 'handled');
  assert.ok(entry.autopilot.receipt.startsWith(receiptDirectory(f.org, f.entry.project.identity)));
});
for (const notice of ['report', 'promotion', 'unknown', 'missing-record-intermediate'])
test(`${notice} exception delivery preserves the exact original notice through the existing input gate`, async t => {
  const f = setup(t, [{ result: 'something-new', reason: 'Unrecognised result' }]);
  if (notice === 'report') f.entry.message += ' with  repeated spaces\nOriginal report detail.';
  if (notice === 'promotion') f.entry.message = '[promote-queue] id=job lane=topic outcome=promoted reason="landed; lane close: held lane-promote.lock"\nOriginal cleanup detail.';
  if (notice === 'unknown') f.entry.message = '[new-notice]  Original text\nDetails with trailing spaces.  ';
  if (notice === 'missing-record-intermediate') {
    f.entry.message = `[watch-long-running] run=${f.run} item=${f.item} worker=lane-nine still-running=2m`;
    fs.unlinkSync(path.join(f.org, 'events.jsonl'));
  }
  const herdr = path.join(f.root, 'delivery-herdr.mjs');
  fs.writeFileSync(herdr, `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(path.join(f.root, 'calls'))},JSON.stringify(args)+'\\n');
if(args[0]==='agent'&&args[1]==='get') console.log(JSON.stringify({result:{agent:{agent:'claude',pane_id:'fake:p1',agent_status:'idle'}}}));
else if(args[0]==='pane'&&args[1]==='read') console.log('────────────────────\\n❯ \\n────────────────────');
else console.log('{}');\n`, { mode: 0o755 });
  const id = notice === 'missing-record-intermediate' ? `watch:${f.run}:long-running` : 'exception';
  const result = await promptSupervisor(f.entry.to, f.entry.message, { org: f.org, cwd: f.repo, id,
    herdr, executeAutopilot: f.execute, nativeAutopilotWorker: f.nativeWorker, waitSeconds: 2, confirmSeconds: 0, pollSeconds: 0.01 });
  assert.equal(result.delivered, true);
  const entry = readInbox(result.inbox)[0], prompts = f.herdrCalls().filter(a => a[0] === 'agent' && a[1] === 'prompt');
  assert.ok(prompts.length >= 1);
  assert.equal(prompts[0][3], `${entry.autopilot.summary} notice-id=${id}`);
  const delivered = prompts[0][3];
  assert.equal(delivered.slice(0, f.entry.message.length), f.entry.message);
  if (notice !== 'report')
    assert.equal(delivered, `${f.entry.message} notice-id=${id}`);
  else assert.match(delivered.slice(f.entry.message.length), /^\n\[autopilot\] [^\n]+ receipt=\S+ notice-id=exception$/);
  if (notice === 'promotion') assert.match(JSON.parse(fs.readFileSync(entry.autopilot.receipt)).reason, /promotion queue binding/);
  assert.equal(entry.autopilot.disposition, 'wake');
  assert.equal(entry.message, f.entry.message);
});
test('a busy chat drain cannot prevent a routine policy action', async t => {
  const f = setup(t, [pass, { phase: 'acknowledged' }]);
  const inbox = path.join(f.org, 'supervisor/inbox.log'), release = noticeLock(`${inbox}.drain.lock`);
  try {
    const result = await promptSupervisor(f.entry.to, f.entry.message, { org: f.org, cwd: f.repo, id: 'routine-while-busy', executeAutopilot: f.execute, nativeAutopilotWorker: f.nativeWorker, waitSeconds: 0 });
    assert.equal(result.handled, true); assert.equal(f.calls.length, 2); assert.deepEqual(f.herdrCalls(), []);
  } finally { release(); }
});
for (const withFindings of [false, true]) test(`actual handle and promotion commands ${withFindings ? 'return findings to the supervisor' : 'settle PASS and enqueue'} offline`, t => {
  const f = setup(t, [], { ingest: false }); f.commit('correct\n');
  assert.equal(f.show(f.run).report, null, 'first notice arrives before report ingestion');
  if (withFindings) {
    fs.writeFileSync(path.join(f.repo, '.lane.json'), '{"settle":{"review_round_cap":1}}');
    f.git(['add', '.lane.json']); f.git(['commit', '-qm', 'Configure capped review']);
    fs.writeFileSync(path.join(f.root, 'review-result.json'), JSON.stringify({ verdict: 'NEEDS-WORK', findings: minor }));
  }
  const queueCLI = path.join(f.root, 'queue-cli.mjs');
  fs.writeFileSync(queueCLI, 'console.log(JSON.stringify({jobs:[{id:"offline-job"}]}));\n');
  const call = (file, args) => {
    const r = f.exec(process.execPath, [file, ...args, ...(args[0] === 'promote' ? ['--promote-cli', queueCLI] : [])]);
    if (r.status !== 0) throw Error(r.stderr || r.stdout);
    return r.stdout;
  };
  const result = autopilotNotice(f.entry, { execute: call, nativeWorker: f.nativeWorker });
  assert.equal(result.disposition, withFindings ? 'wake' : 'handled', fs.readFileSync(result.receipt, 'utf8'));
  const saved = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal(f.show(f.run).report.outcome, 'done', 'handle conditionally ingested the worker report');
  assert.equal(saved.actions[0]?.result?.result, withFindings ? 'promotable_with_findings' : 'promotable', JSON.stringify(saved, null, 2));
  if (withFindings) {
    assert.equal(saved.follow_up, undefined); assert.equal(saved.exception, 'AUTOPILOT_FINDINGS');
  }
  if (!withFindings) assert.ok(f.show(f.run).notes.some(n => n.text.includes('notice-autopilot/v1')));
  const events = fs.readFileSync(path.join(f.org, 'events.jsonl')), calls = f.herdrCalls();
  assert.equal(autopilotNotice(f.entry, { execute: call, nativeWorker: f.nativeWorker }).disposition, withFindings ? 'wake' : 'handled');
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), events);
  assert.deepEqual(f.herdrCalls(), calls);
});
test('real handle still wakes for a non-test claim alongside ingest proof and deferred tests', t => {
  const f = setup(t, [], { ingest: false }); f.commit('correct\n');
  fs.writeFileSync(path.join(f.root, 'review-result.json'), JSON.stringify({
    unverified: `- Test evidence not re-executed: brain/checks.test.mjs\n${RECORD_CHECK_CLAIM}\n- Deployment evidence remains unresolved.` }));
  const calls = [];
  const handled = autopilotNotice(f.entry, { execute: (file, args) => {
    calls.push(args);
    const r = f.exec(process.execPath, [file, ...args]); assert.equal(r.status, 0, r.stderr); return r.stdout;
  } });
  assert.equal(handled.disposition, 'wake'); assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'handle');
  const receipt = JSON.parse(fs.readFileSync(handled.receipt));
  assert.equal(receipt.actions[0].result.result, 'escalate');
  assert.match(receipt.actions[0].result.reason, /unverified claims/);
  assert.equal(f.show(f.item).closed, null);
});
for (const [awaited, scopedTests, recordClaim, withProposal] of [[false, false], [true, false], [false, true], [false, true, RECORD_CHECK_CLAIM], [false, true, LEGACY_RECORD_CHECK_CLAIM], [false, false, undefined, true]]) test(`automatic PASS reaches the real queue, lands and closes ${awaited ? 'with one awaited wake' : 'without waking the supervisor'}${scopedTests ? ' with deferred test evidence' : ''}${recordClaim ? ` and ingest proof: ${recordClaim}` : ''}${withProposal ? ' with a non-blocking engineer proposal' : ''}`, { timeout: 30000 }, async t => {
  const f = setup(t, [], { ingest: false }); f.commit('correct\n');
  const state = () => fold(loadEvents(f.org).events);
  if (withProposal) {
    const report = f.show(f.run).report_path;
    fs.writeFileSync(report, fs.readFileSync(report, 'utf8').replace('proposals: []', 'proposals:\n  - role: engineer\n    title: Optional improvement\n    why: Separate follow-up\n    blocking: false'));
  }
  if (scopedTests) {
    const marker = path.join(f.root, 'extra-test-runs');
    fs.writeFileSync(path.join(f.repo, 'planner.mjs'), `import {spawnSync} from 'node:child_process'; if(process.argv[2]==='--plan') console.log(JSON.stringify({files:['brain/checks.test.mjs']})); else process.exitCode=spawnSync(process.execPath,['--test',...JSON.parse(process.argv[3])],{stdio:'inherit'}).status??1;`);
    fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ promotion_tests: 'planner.mjs' }));
    f.git(['add', 'planner.mjs', '.lane.validation.json']); f.git(['commit', '-qm', 'Declare promotion test plan']);
    f.git(['rebase', 'main'], f.workspace);
    fs.writeFileSync(path.join(f.workspace, 'brain/checks.test.mjs'), `import test from 'node:test'; import fs from 'node:fs'; test('additional evidence',()=>fs.appendFileSync(${JSON.stringify(marker)},'run\\n'));`);
    f.git(['add', 'brain/checks.test.mjs'], f.workspace); f.git(['commit', '-qm', 'Add scoped release test'], f.workspace);
    fs.writeFileSync(path.join(f.root, 'review-result.json'), JSON.stringify({ unverified: '- Test evidence not re-executed: brain/checks.test.mjs' + (recordClaim ? `\n${recordClaim}` : '') }));
  }
  if (awaited) f.record(['set', f.item, 'meta.notify=supervisor', 'meta.notify_step=Cut RC-11']);
  const releaseWorker = await existingWorker(t, f);
  try {
  assert.equal(state().runs.get(f.run).report, null, 'first notice has no immutable report');
  const runner = path.join(f.root, 'first-notice.mjs');
  fs.writeFileSync(runner, `import {promptSupervisor} from ${JSON.stringify(path.join(f.source, 'supervisor/prompt-supervisor.mjs'))};\nconsole.log(JSON.stringify(await promptSupervisor(${JSON.stringify(f.entry.to)},${JSON.stringify(f.entry.message)},${JSON.stringify({ org: f.org, cwd: f.repo, id: 'automatic-cycle', waitSeconds: 0 })})));\n`);
  const r = f.exec(process.execPath, [runner]); assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  releaseWorker();
  assert.equal(result.handled, true, JSON.stringify(result));
  const directory = path.join(f.entry.project.identity, 'promote'), deadline = Date.now() + loadTimeout(20000);
  let closed = false;
  while (Date.now() < deadline) {
    closed = state().items.get(f.item).closed?.as === 'done';
    if (closed && !fs.existsSync(path.join(directory, 'worker.lock'))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(closed, `promotion notice closes the record without supervisor chat: ${JSON.stringify(queueFor(f.repo).load())}`);
  assert.ok(!fs.existsSync(path.join(directory, 'worker.lock')), 'finite promotion owner exited');
  if (!withProposal) assert.ok(!fs.existsSync(f.workspace));
  assert.equal(fs.readFileSync(path.join(f.repo, 'work.txt'), 'utf8'), 'correct\n');
  const queue = JSON.parse(fs.readFileSync(path.join(directory, 'queue.json')));
  const promoted = queue.results.filter(j => j.run === f.run);
  assert.equal(promoted.length, 1); assert.equal(promoted[0].outcome, 'promoted');
  if (withProposal) {
    const child = [...state().items.values()].find(item => item.created.run === f.run);
    assert.ok(child); assert.equal(child.role, 'engineer'); assert.equal(child.closed, null);
  }
  assert.match(fastPathTiming(f.entry.project, f.run, {}).clocks.queue_admission, /^20/);
  const timingNotes = state().runs.get(f.run).notes.filter(n => n.text.startsWith('Fast path timing: '));
  assert.equal(timingNotes.length, 1);
  const timing = JSON.parse(timingNotes[0].text.slice('Fast path timing: '.length));
  for (const clock of ['dispatch', 'report', 'ingest', 'review_start', 'review_end', 'queue_admission', 'gate_start', 'gate_end', 'main', 'reconcile']) assert.ok(timing.clocks[clock], clock);

  if (scopedTests) {
    assert.deepEqual(promoted[0].requiredTests, ['brain/checks.test.mjs']);
    const plan = JSON.parse(fs.readFileSync(promoted[0].receipt));
    assert.deepEqual(plan.attempts[0].test_plan.files, ['brain/checks.test.mjs']);
    assert.equal(fs.readFileSync(path.join(f.root, 'extra-test-runs'), 'utf8'), 'run\n');
    if (recordClaim) {
      const settled = JSON.parse(fs.readFileSync(path.join(f.org, 'settle', `${f.run}.json`)));
      assert.equal(settled.result.report_ingest.sha256, state().runs.get(f.run).report.sha256);
      assert.ok(settled.review.text.includes(recordClaim.replaceAll('`', '\\`')));
      assert.equal(settled.review.verdict, 'PASS');
    }
  }
  assert.equal(f.herdrCalls().filter(a => a[0] === 'agent' && a[1] === 'start').length, 1);
  t.diagnostic(`offline pilot: ${promoted.length} promotion, ${timingNotes.length} timing note; all ten clocks present`);
  const notices = readInbox(result.inbox).filter(n => !n.message.includes('lane=anchor')); assert.equal(notices.length, 2);
  assert.equal(notices[0].state, 'handled');
  assert.equal(notices[1].state, awaited ? 'sent' : 'handled');
  const wakes = f.herdrCalls().filter(a => a[0] === 'agent' && a[1] === 'prompt' && !a[3].includes('Private record file:') && !a[3].includes('lane=anchor'));
  assert.equal(wakes.length, awaited ? 1 : 0);
  if (awaited) {
    assert.equal(wakes[0][3], `[autopilot] ${f.item} landed; unblocks: Cut RC-11 notice-id=${notices[1].id}`);
    const again = await promptSupervisor(f.entry.to, notices[1].message, { org: f.org, cwd: f.repo, id: notices[1].id, herdr: path.join(f.root, 'bin/herdr'), waitSeconds: 0 });
    assert.equal(again.delivered, true);
    assert.equal(f.herdrCalls().filter(a => a[0] === 'agent' && a[1] === 'prompt' && a[3].startsWith('[autopilot]')).length, 1);
  }
  } finally { releaseWorker(); }
});
test('real CLIs retry an exit-one base-moved refusal with the saved request and land once', { timeout: 30000 }, async t => {
  const f = setup(t); f.commit('correct\n');
  const releaseWorker = await existingWorker(t, f);
  const state = () => fold(loadEvents(f.org).events);
  try {
  const herdr = path.join(f.root, 'bin/herdr'), original = `${herdr}-original`, marker = path.join(f.root, 'base-moved');
  fs.renameSync(herdr, original);
  // Only the offline reviewer transport moves main. All handle, intake, retry,
  // rebase and promotion responses below come from the actual product CLIs.
  fs.writeFileSync(herdr, `#!${process.execPath}
import fs from 'node:fs'; import {spawnSync,execFileSync} from 'node:child_process';
const args=process.argv.slice(2),r=spawnSync(${JSON.stringify(original)},args,{stdio:'inherit'});
if(r.status===0&&args[0]==='agent'&&args[1]==='prompt'&&args[3]?.includes('Private record file: ')&&!fs.existsSync(${JSON.stringify(marker)})){
 fs.writeFileSync(${JSON.stringify(path.join(f.repo, 'upstream'))},'new main\\n');
 execFileSync('git',['-C',${JSON.stringify(f.repo)},'add','upstream']);
 execFileSync('git',['-C',${JSON.stringify(f.repo)},'commit','-qm','Move main during review']);
 fs.writeFileSync(${JSON.stringify(marker)},'moved');
}
process.exit(r.status??1);`, { mode: 0o755 });
  const runner = path.join(f.root, 'autopilot.mjs');
  fs.writeFileSync(runner, `import {autopilotNotice} from ${JSON.stringify(path.join(f.source, 'supervisor/autopilot.mjs'))};\nconsole.log(JSON.stringify(autopilotNotice(${JSON.stringify(f.entry)})));\n`);
  const r = f.exec(process.execPath, [runner]); assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  releaseWorker();
  assert.equal(result.disposition, 'handled', fs.readFileSync(result.receipt, 'utf8'));
  const saved = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal(saved.retry_used, true); assert.equal(saved.actions.length, 3);
  const [first, retry] = saved.actions;
  assert.equal(first.exit_code, 1); assert.equal(first.phase, 'acknowledged');
  assert.equal(first.result.result, 'escalate'); assert.match(first.stderr, /base branch moved/);
  assert.equal(first.result.journal, path.join(f.org, 'settle', `${f.run}.json`));
  assert.ok(fs.existsSync(first.result.handoff));
  assert.equal(retry.exit_code, 0); assert.equal(retry.result.result, 'promotable');
  assert.ok(retry.args.includes('--retry')); assert.ok(!retry.args.includes('--to'));
  const settled = JSON.parse(fs.readFileSync(first.result.journal));
  assert.equal(settled.to, f.entry.to); assert.equal(settled.recaptures.length, 1);
  assert.equal(settled.review.verdict, 'PASS');
  assert.equal(f.herdrCalls().filter(a => a[0] === 'agent' && a[1] === 'start').length, 1, 'retry reuses independent review');
  const directory = path.join(f.entry.project.identity, 'promote'), deadline = Date.now() + loadTimeout(20000);
  while (Date.now() < deadline && (!state().items.get(f.item).closed || fs.existsSync(path.join(directory, 'worker.lock')))) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(state().items.get(f.item).closed?.as, 'done', JSON.stringify(JSON.parse(fs.readFileSync(path.join(directory, 'queue.json')))));
  assert.ok(!fs.existsSync(path.join(directory, 'worker.lock')));
  assert.equal(fs.readFileSync(path.join(f.repo, 'upstream'), 'utf8'), 'new main\n');
  assert.equal(fs.readFileSync(path.join(f.repo, 'work.txt'), 'utf8'), 'correct\n');
  const queue = JSON.parse(fs.readFileSync(path.join(directory, 'queue.json')));
  const promoted = queue.results.filter(j => j.run === f.run);
  assert.equal(promoted.length, 1); assert.equal(promoted[0].outcome, 'promoted');
  assert.match(fastPathTiming(f.entry.project, f.run, {}).clocks.queue_admission, /^20/);
  const timingNotes = state().runs.get(f.run).notes.filter(n => n.text.startsWith('Fast path timing: '));
  assert.equal(timingNotes.length, 1);
  const timing = JSON.parse(timingNotes[0].text.slice('Fast path timing: '.length));
  for (const clock of ['dispatch', 'report', 'ingest', 'review_start', 'review_end', 'queue_admission', 'gate_start', 'gate_end', 'main', 'reconcile']) assert.ok(timing.clocks[clock], clock);

  const events = fs.readFileSync(path.join(f.org, 'events.jsonl'));
  assert.equal(JSON.parse(f.exec(process.execPath, [runner]).stdout).disposition, 'handled');
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), events);
  } finally { releaseWorker(); }
});

for (const stdout of ['', '{broken']) test(`stderr-only failed action preserves refusal instead of JSON parsing: ${stdout}`, t => {
  const f = setup(t);
  const result = autopilotNotice(f.entry, { execute: () => ({ status: 1, stdout, stderr: 'promotion requires saved readiness', signal: null }) });
  assert.equal(result.disposition, 'wake');
  const saved = JSON.parse(fs.readFileSync(result.receipt));
  assert.match(saved.error, /promotion requires saved readiness/);
  assert.equal(saved.actions[0].output, stdout);
  assert.equal(saved.actions[0].phase, 'started');
  assert.equal(saved.actions[0].exit_code, 1);
});

for (const config of [null, { autopilot: { enabled: false } }, { autopilot: { enabled: false, cohort: 'clean-pass' } }]) test(`disabled autopilot preserves the original notice for ${JSON.stringify(config)}`, t => {
  const f = setup(t, [pass]);
  if (config === null) fs.unlinkSync(path.join(f.repo, '.supervisor.json'));
  else fs.writeFileSync(path.join(f.repo, '.supervisor.json'), JSON.stringify(config));
  assert.equal(autopilotSettings(f.repo).enabled, false);
  const result = f.apply();
  assert.equal(result.disposition, 'wake'); assert.equal(f.calls.length, 0);
  assert.equal(result.summary, f.entry.message);
  const saved = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal(saved.exception, 'AUTOPILOT_DISABLED');
  assert.equal(saved.reason, 'AUTOPILOT_DISABLED: autopilot disabled in project config');
  assert.equal(f.apply().summary, f.entry.message); assert.equal(f.calls.length, 0);
  saved.delivery_summary = '[autopilot] previous landing text';
  fs.writeFileSync(result.receipt, JSON.stringify(saved));
  assert.equal(f.apply().summary, f.entry.message, 'disabled policy also preserves delayed notices with cached delivery text');
});
for (const cohort of [undefined, 'unknown']) test(`enabled pilot rejects cohort ${cohort}`, t => {
  const f = setup(t, [pass]);
  fs.writeFileSync(path.join(f.repo, '.supervisor.json'), JSON.stringify({ autopilot: { enabled: true, cohort } }));
  const result = f.apply(); assert.equal(result.disposition, 'wake'); assert.equal(f.calls.length, 0);
  const reason = JSON.parse(fs.readFileSync(result.receipt)).reason;
  assert.match(reason, /^AUTOPILOT_COHORT_UNKNOWN: select/);
  assert.equal(reason.match(/AUTOPILOT_COHORT_UNKNOWN/g).length, 1);
});
for (const [file, code] of [
  ['supervisor/autopilot.mjs', 'AUTOPILOT_SCOPE_EXCLUDED'], ['lib/store.mjs', 'AUTOPILOT_SCOPE_EXCLUDED'],
  ['lib/state.mjs', 'AUTOPILOT_SCOPE_EXCLUDED'], ['lib/report.mjs', 'AUTOPILOT_SCOPE_EXCLUDED'],
  ['lib/cli-help.mjs', 'AUTOPILOT_SCOPE_EXCLUDED'], ['contrib/settle-watch.mjs', 'AUTOPILOT_SCOPE_EXCLUDED'],
  ['supervisor/reconcile.mjs', 'AUTOPILOT_SCOPE_EXCLUDED'], ['herdr/release.sh', 'AUTOPILOT_SCOPE_EXCLUDED'],
  ['acceptance/run.mjs', 'AUTOPILOT_SCOPE_EXCLUDED'], ['lanes/validation.mjs', 'AUTOPILOT_SCOPE_EXCLUDED'],
  ['promote/train.mjs', 'AUTOPILOT_SCOPE_EXCLUDED'], ['settle/settle.mjs', 'AUTOPILOT_SCOPE_EXCLUDED'],
  ['lib/retire.mjs', 'AUTOPILOT_SCOPE_EXCLUDED'], ['lib/sessions.mjs', 'AUTOPILOT_SCOPE_EXCLUDED'],
  ['watch/notice.mjs', 'AUTOPILOT_SCOPE_EXCLUDED'], ['.codex/hooks.json', 'AUTOPILOT_SCOPE_EXCLUDED'],
  ['unknown/new.mjs', 'AUTOPILOT_SCOPE_UNKNOWN'],
  ['brain/.codex/hooks.json', 'AUTOPILOT_SCOPE_EXCLUDED'], ['brain/vectors/pin.json', 'AUTOPILOT_SCOPE_EXCLUDED'],
]) test(`pilot scope routes ${file} to the ordinary path before review`, t => {
  const f = setup(t, [pass]);
  fs.mkdirSync(path.dirname(path.join(f.workspace, file)), { recursive: true });
  fs.writeFileSync(path.join(f.workspace, file), 'changed\n'); f.git(['add', '.'], f.workspace); f.git(['commit', '-qm', 'Change scope'], f.workspace);
  const result = f.apply(), saved = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal(result.disposition, 'wake'); assert.equal(saved.exception, code); assert.equal(f.calls.length, 0);
  assert.equal(f.show(f.run).notes.filter(n => n.text.startsWith('Fast path timing: ')).length, 1);
  assert.equal(f.apply().disposition, 'wake'); assert.equal(f.calls.length, 0);
});
for (const operation of ['delete', 'rename-away', 'rename-into']) test(`complete scope includes protected ${operation}`, t => {
  const f = setup(t, [pass]), protectedFile = 'lib/store.mjs';
  fs.mkdirSync(path.join(f.repo, 'lib')); fs.writeFileSync(path.join(f.repo, protectedFile), 'protected\n');
  f.git(['add', protectedFile]); f.git(['commit', '-qm', 'Seed protected source']); f.git(['rebase', 'main'], f.workspace);
  if (operation === 'delete') f.git(['rm', protectedFile], f.workspace);
  if (operation === 'rename-away') f.git(['mv', protectedFile, 'brain/innocent.mjs'], f.workspace);
  if (operation === 'rename-into') { fs.mkdirSync(path.join(f.workspace, 'supervisor')); f.git(['mv', 'brain/output.txt', 'supervisor/new.mjs'], f.workspace); }
  f.git(['commit', '-qm', operation], f.workspace);
  const result = f.apply(); assert.equal(result.disposition, 'wake'); assert.equal(f.calls.length, 0);
  assert.match(JSON.parse(fs.readFileSync(result.receipt)).reason, /AUTOPILOT_SCOPE_(EXCLUDED|UNKNOWN)/);
});
for (const mode of ['findings', 'stale-head', 'stale-run', 'stale-PASS']) test(`clean PASS refuses ${mode} after settlement`, t => {
  const f = setup(t, [pass]);
  const execute = (file, args, options) => {
    const result = JSON.parse(f.execute(file, args, options));
    if (mode === 'findings') {
      const file = path.join(f.org, 'settle', `${f.run}.json`), saved = JSON.parse(fs.readFileSync(file));
      saved.review.text = saved.review.text.replace('None', minor);
      saved.review.sha256 = createHash('sha256').update(saved.review.text).digest('hex');
      saved.result.review.sha256 = saved.review.sha256; result.review.sha256 = saved.review.sha256;
      fs.writeFileSync(file, JSON.stringify(saved));
    }
    if (mode === 'stale-head') result.head = '0'.repeat(40);
    if (mode === 'stale-run') result.run = 'R-999';
    if (mode === 'stale-PASS') result.review.sha256 = '0'.repeat(64);
    return JSON.stringify(result);
  };
  const result = autopilotNotice(f.entry, { execute, nativeWorker: f.nativeWorker });
  assert.equal(result.disposition, 'wake'); assert.equal(f.calls.length, 1);
  assert.match(JSON.parse(fs.readFileSync(result.receipt)).reason, /AUTOPILOT_(FINDINGS|PASS_STALE)/);
});
test('no live native worker records one named exception and never starts or enqueues a worker', t => {
  const f = setup(t, [pass]);
  const result = autopilotNotice(f.entry, { execute: f.execute });
  assert.equal(result.disposition, 'wake'); assert.equal(f.calls.length, 1);
  const saved = JSON.parse(fs.readFileSync(result.receipt)); assert.equal(saved.exception, 'AUTOPILOT_NO_NATIVE_WORKER');
  assert.equal(fs.existsSync(path.join(f.entry.project.identity, 'promote/queue.json')), false);
  assert.equal(fs.existsSync(path.join(f.entry.project.identity, 'promote/worker.log')), false);
  f.entry.id = 'delayed'; assert.equal(autopilotNotice(f.entry, { execute: f.execute }).disposition, 'wake'); assert.equal(f.calls.length, 1);
  assert.equal(f.show(f.run).notes.filter(n => n.text.startsWith('Fast path timing: ')).length, 1);
});

test('a worker exiting after autopilot precheck leaves a confirmed no-op that bare promotion can recover', { timeout: 45000 }, async t => {
  const f = setup(t, [], { ingest: false }), release = await existingWorker(t, f, { refuse: true });
  const queue = queueFor(f.repo);
  try {
    const result = autopilotNotice(f.entry, { execute: (file, args) => {
      if (args[0] === 'promote') {
        assert.ok(liveNativeWorker(f.entry.project.identity), 'worker was live at precheck');
        release();
        const wait = f.exec(process.execPath, ['-e', `const fs=require('fs');const end=Date.now()+${loadTimeout(20000)};while(fs.existsSync(${JSON.stringify(path.join(queue.directory, 'worker.lock'))})&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);`]);
        assert.equal(wait.status, 0, wait.stderr);
        assert.equal(liveNativeWorker(f.entry.project.identity), null);
      }
      return f.exec(process.execPath, [file, ...args]);
    } });
    assert.equal(result.disposition, 'wake');
    assert.equal(JSON.parse(fs.readFileSync(result.receipt)).exception, 'AUTOPILOT_NO_NATIVE_WORKER');
    const journal = path.join(receiptDirectory(f.org, f.entry.project.identity), `${f.run}.json`);
    const refused = JSON.parse(fs.readFileSync(journal));
    assert.equal(refused.phase, 'not-queued'); assert.equal(refused.refusal.code, 'AUTOPILOT_NO_NATIVE_WORKER');
    assert.equal(refused.queue, undefined);
    assert.equal(queue.load().pending.length, 0);
    assert.equal(queue.load().results.filter(job => job.run === f.run).length, 0);
    assert.ok(f.show(f.run).notes.every(note => !note.summary?.startsWith('Promotion authorized:')));
    const recovered = f.exec(process.execPath, [path.join(f.source, 'supervisor/supervisor.mjs'), 'promote', f.run,
      '--repo', f.repo, '--org', f.org, '--role', 'supervisor', '--why', 'Bare native recovery after confirmed no-op']);
    assert.equal(recovered.status, 0, recovered.stderr);
    const acknowledged = JSON.parse(recovered.stdout);
    assert.equal(acknowledged.phase, 'acknowledged');
    assert.equal(acknowledged.prior_attempts.length, 1); assert.equal(acknowledged.prior_attempts[0].phase, 'not-queued');
    const deadline = Date.now() + loadTimeout(20000);
    while (fs.existsSync(path.join(queue.directory, 'worker.lock')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(queue.load().results.filter(job => job.run === f.run).length, 1);
    assert.equal(queue.load().results.find(job => job.run === f.run).outcome, 'promoted');
  } finally { release(); }
});

for (const fromReport of [false, true]) test(`automatic queue ${fromReport ? 'promotes its own non-blocking report proposal' : 'refuses an engineer child filed during handle after report intake'}`, { timeout: 30000 }, async t => {
  const f = setup(t, [], { ingest: false }), queue = queueFor(f.repo);
  f.commit('correct\n');
  if (fromReport) {
    const report = f.show(f.run).report_path;
    fs.writeFileSync(report, fs.readFileSync(report, 'utf8').replace('proposals: []', 'proposals:\n  - role: engineer\n    title: Optional improvement\n    why: Separate follow-up\n    blocking: false'));
  } else {
    // The scripted reviewer files this while real handle is settling the
    // ingested report, before autopilot requests queue admission.
    fs.writeFileSync(path.join(f.root, 'review-record-action.json'), JSON.stringify([
      'add', 'New engineering scope', '--role', 'engineer', '--parent', f.item,
    ]));
  }
  const release = await existingWorker(t, f);
  try {
    assert.equal(f.show(f.run).report, null);
    const result = autopilotNotice(f.entry, { execute: (file, args) => {
      const r = f.exec(process.execPath, [file, ...args]);
      assert.equal(r.status, 0, r.stderr); return r.stdout;
    } });
    const receipt = JSON.parse(fs.readFileSync(result.receipt));
    assert.equal(result.disposition, 'handled', JSON.stringify(receipt));
    assert.equal(receipt.actions[0].result.result, 'promotable');
    const admitted = queue.load().pending.find(job => job.run === f.run);
    assert.ok(admitted); assert.equal(admitted.existingWorker, true);
    const state = fold(loadEvents(f.org).events);
    const child = [...state.items.values()].find(item => item.parent === f.item);
    assert.ok(child); assert.equal(child.role, 'engineer'); assert.equal(child.closed, null);
    assert.equal(child.created.run, fromReport ? f.run : null);
    assert.ok(child.created.seq > state.runs.get(f.run).report.seq, 'child was filed after intake');
    assert.ok(child.created.seq <= admitted.admittedSeq, 'child was already present at admission');
    release();
    const deadline = Date.now() + loadTimeout(20000);
    while (Date.now() < deadline && fs.existsSync(path.join(queue.directory, 'worker.lock'))) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(path.join(queue.directory, 'worker.lock')), false, 'finite promotion owner exited');
    const job = queue.load().results.find(job => job.run === f.run);
    assert.ok(job); assert.equal(job.outcome, fromReport ? 'promoted' : 'refused', job.reason);
    if (!fromReport) {
      assert.match(job.reason, /open engineer children/);
      assert.ok(job.reason.includes(child.id));
      assert.ok(fs.existsSync(f.workspace));
      assert.equal(loadEvents(f.org).events.some(event => event.type === 'promotion.reconciled'), false);
    }
    assert.equal(f.show(f.item).closed?.as ?? null, fromReport ? 'done' : null);
    assert.equal(f.show(child.id).closed, null);
    assert.equal(fs.readFileSync(path.join(f.repo, 'brain/output.txt'), 'utf8'), fromReport ? 'correct\n' : 'base\n');
  } finally { release(); }
});

for (const change of ['stale-PASS', 'kill-switch', 'pause']) test(`automatic queue rechecks ${change} at final integration`, { timeout: 30000 }, async t => {
  const f = setup(t, [], { ingest: false }), gate = path.join(f.root, 'change-at-gate.cjs');
  const mutation = change === 'stale-PASS'
    ? `const file=${JSON.stringify(path.join(f.org, 'settle', `${f.run}.json`))};const settled=JSON.parse(fs.readFileSync(file));settled.review.verdict='NEEDS-WORK';fs.writeFileSync(file,JSON.stringify(settled));`
    : `fs.writeFileSync(${JSON.stringify(path.join(f.repo, change === 'pause' ? '.housekeeping.json' : '.supervisor.json'))},JSON.stringify(${change === 'pause' ? '{enabled:false}' : '{autopilot:{enabled:false}}'}));`;
  fs.writeFileSync(gate, `const fs=require('fs');${mutation}console.log('green');`);
  fs.writeFileSync(path.join(f.repo, '.lane.validation.json'), JSON.stringify({ promotion: `${process.execPath} ${gate}` }));
  f.git(['add', '.lane.validation.json']); f.git(['commit', '-qm', 'Gate fixture']); f.git(['rebase', 'main'], f.workspace);
  const base = f.git(['rev-parse', 'main']), release = await existingWorker(t, f);
  try {
  const result = autopilotNotice(f.entry, { execute: (file, args) => {
    const r = f.exec(process.execPath, [file, ...args]); assert.equal(r.status, 0, r.stderr); return r.stdout;
  } });
  release(); assert.equal(result.disposition, 'handled', fs.readFileSync(result.receipt, 'utf8'));
  const queue = queueFor(f.repo), deadline = Date.now() + loadTimeout(20000);
  while (Date.now() < deadline && fs.existsSync(path.join(queue.directory, 'worker.lock'))) await new Promise(resolve => setTimeout(resolve, 50));
  const job = queue.load().results.find(j => j.run === f.run);
  assert.equal(job.outcome, 'refused'); assert.match(job.reason, change === 'stale-PASS' ? /AUTOPILOT_PASS_STALE/ : change === 'pause' ? /AUTOPILOT_PAUSED/ : /AUTOPILOT_DISABLED/);
  assert.equal(f.show(f.item).closed, null);
  assert.equal(fs.readFileSync(path.join(f.repo, 'brain/output.txt'), 'utf8'), 'base\n');
  assert.notEqual(f.git(['rev-parse', 'main']), base, 'only the preexisting anchor integrated');
  } finally { release(); }
});

for (const mode of ['symlink', 'executable', 'cross-area']) test(`pilot rejects ${mode} scope`, t => {
  const f = setup(t, [pass]);
  if (mode === 'symlink') fs.symlinkSync('../work.txt', path.join(f.workspace, 'brain/link'));
  if (mode === 'cross-area') fs.writeFileSync(path.join(f.workspace, 'README.md'), 'Another mapped area\n');
  f.git(['add', '.'], f.workspace);
  if (mode === 'executable') f.git(['update-index', '--chmod=+x', 'brain/output.txt'], f.workspace);
  f.git(['commit', '-qm', mode], f.workspace);
  const result = f.apply(); assert.equal(result.disposition, 'wake'); assert.equal(f.calls.length, 0);
  assert.match(JSON.parse(fs.readFileSync(result.receipt)).reason, /AUTOPILOT_SCOPE_(UNKNOWN|EXCLUDED)/);
});
