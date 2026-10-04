import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from '../../settle/test/fixture.mjs';
import { gitProject } from '../../lib/project.mjs';
import { receiptDirectory } from '../context.mjs';
import { autopilotNotice } from '../autopilot.mjs';
import { promptSupervisor, readInbox } from '../prompt-supervisor.mjs';
import { noticeLock } from '../notice-lock.mjs';
import { loadTimeout } from '../../lib/deadline.mjs';

function setup(t, results = []) {
  const f = fixture(t), run = f.start();
  f.report(run); f.record(['ingest', f.show(run).report_path]);
  const config = JSON.parse(fs.readFileSync(path.join(f.org, 'config.json')));
  config.approvals.categories.tooling = 'auto';
  fs.writeFileSync(path.join(f.org, 'config.json'), JSON.stringify(config));
  const p = gitProject(f.repo), item = f.show(run).item;
  const entry = { id: 'report-1', to: 'supervisor-test', message: `[org-report] run=${run} item=${item} outcome=done headline=Done`,
    project: { repo: f.repo, identity: p.identity, org: f.org } };
  const calls = [];
  const execute = (file, args, options) => {
    calls.push({ file, args, options });
    const next = results.shift();
    if (next instanceof Error) throw next;
    assert.notEqual(next, undefined, 'unexpected command');
    return typeof next === 'string' ? next : JSON.stringify(next);
  };
  return { ...f, herdrCalls: f.calls, run, item, entry, calls, execute, apply: () => autopilotNotice(entry, { execute }) };
}
const pass = { result: 'promotable', review: { verdict: 'PASS' } };
const minor = '- [Minor] supervisor/x.mjs:1 - Improve text; Fix: clarify it';

test('done handles, PASS promotes with named policy, and duplicate notices do no work', t => {
  const f = setup(t, [pass, { phase: 'acknowledged' }]);
  assert.equal(f.apply().disposition, 'handled');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].args.slice(0, 2), ['handle', f.run]);
  assert.equal(f.calls[1].args[0], 'promote');
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
});
test('repeated base movement wakes and never repeats the retry', t => {
  const moved = { result: 'escalate', reason: 'base branch moved; use --retry to recapture and rebase' };
  const f = setup(t, [moved, moved]);
  assert.equal(f.apply().disposition, 'wake'); assert.equal(f.calls.length, 2);
  assert.equal(f.apply().disposition, 'wake'); assert.equal(f.calls.length, 2);
});
test('Moderate and Minor findings file one follow-up before accepting promotion', t => {
  const findings = minor + '\n- [Moderate] supervisor/y.mjs:2 - Missing detail; Fix: add detail';
  const f = setup(t, [{ result: 'promotable_with_findings', review: { verdict: 'NEEDS-WORK' }, findings, review_policy: { cap: 1, round: 1 } }, 'ENG-999\n', { phase: 'acknowledged' }]);
  assert.equal(f.apply().disposition, 'handled');
  assert.equal(f.calls[1].args[0], 'add');
  assert.ok(f.calls[1].args.includes(`--accept=${findings}`));
  assert.ok(f.calls[2].args.includes('--accept-findings'));
  assert.equal(f.apply().disposition, 'handled'); assert.equal(f.calls.length, 3);
});
for (const [name, value] of Object.entries({
  unknown: { result: 'new-result' }, uncertain: { result: 'incomplete' }, interrupted: { result: 'stopped' },
  refusal: { result: 'escalate', reason: 'refused' }, fail: { ...pass, review: { verdict: 'FAIL' } },
  cappedMajor: { result: 'fix_round', review: { verdict: 'NEEDS-WORK' }, findings: '- [Major] x.mjs:1 - Broken; Fix: repair', review_policy: { cap: 1, round: 1 } },
  unparsed: { result: 'promotable_with_findings', review: { verdict: 'NEEDS-WORK' }, findings: 'uncertain severity' },
  noPASS: { result: 'promotable' },
  cappedUnknown: { result: 'fix_round', review: { verdict: 'NEEDS-WORK' }, review_policy: { cap: 1, round: 1 } },
})) test(`${name} result wakes with a compact summary and receipt`, t => {
  const f = setup(t, [value]), result = f.apply();
  assert.equal(result.disposition, 'wake'); assert.ok(fs.existsSync(result.receipt));
  assert.ok(!result.summary.includes('\n')); assert.ok(result.summary.includes(result.receipt));
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
  assert.equal(f.apply().disposition, 'wake'); assert.equal(f.calls.length, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('reserved report decisions wake even when the work item has no category', t => {
  const f = setup(t), run = f.start(); f.report(run);
  const file = f.show(run).report_path;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('proposals: []', 'decisions: [{text: "Change license", category: licensing, why: "New terms"}]\nproposals: []'));
  f.record(['ingest', file]); f.entry.message = f.entry.message.replace(f.run, run);
  assert.equal(f.apply().disposition, 'wake'); assert.equal(f.calls.length, 0);
});
test('a pause appearing after handle prevents promotion', t => {
  const f = setup(t, [pass]);
  const call = (file, args, options) => {
    const result = f.execute(file, args, options);
    fs.writeFileSync(path.join(f.repo, '.housekeeping.json'), '{"enabled":false}');
    return result;
  };
  assert.equal(autopilotNotice(f.entry, { execute: call }).disposition, 'wake');
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
test('promoted queue notice handles its bound run and a closed item is a no-op', t => {
  const f = setup(t, [{ result: 'recorded_promotion' }]), project = f.entry.project;
  fs.mkdirSync(path.join(project.identity, 'promote'), { recursive: true });
  fs.writeFileSync(path.join(project.identity, 'promote/queue.json'), JSON.stringify({ identity: project.identity, pending: [], current: null, results: [{ id: 'job', topic: 'topic', run: f.run, org: f.org, outcome: 'promoted' }] }));
  f.entry.message = '[promote-queue] id=job lane=topic outcome=promoted reason="landed"';
  assert.equal(f.apply().disposition, 'handled'); assert.ok(f.calls[0].args.includes('--notice'));
  const saved = JSON.parse(fs.readFileSync(f.apply().receipt)); assert.equal(saved.actions.length, 1);
  f.record(['close', f.item]); f.entry.message = f.entry.message.replace('id=job', 'id=other');
  const q = JSON.parse(fs.readFileSync(path.join(project.identity, 'promote/queue.json'))); q.results[0].id = 'other';
  fs.writeFileSync(path.join(project.identity, 'promote/queue.json'), JSON.stringify(q));
  assert.equal(f.apply().disposition, 'handled'); assert.equal(f.calls.length, 1);
});
test('inbox consumes routine results before any Herdr delivery and retains original notice', async t => {
  const f = setup(t, [pass, { phase: 'acknowledged' }]);
  const result = await promptSupervisor(f.entry.to, f.entry.message, { org: f.org, cwd: f.repo, id: 'routine',
    executeAutopilot: f.execute, waitSeconds: 0 });
  assert.equal(result.delivered, true); assert.equal(result.handled, true);
  assert.equal(f.calls.length, 2); assert.deepEqual(f.herdrCalls(), []);
  const entry = readInbox(result.inbox)[0];
  assert.equal(entry.message, f.entry.message); assert.equal(entry.state, 'handled');
  assert.ok(entry.autopilot.receipt.startsWith(receiptDirectory(f.org, f.entry.project.identity)));
});
test('exception delivery uses the compact summary and receipt through the existing input gate', async t => {
  const f = setup(t, [{ result: 'something-new', reason: 'Unrecognised result' }]);
  const herdr = path.join(f.root, 'delivery-herdr.mjs');
  fs.writeFileSync(herdr, `#!${process.execPath}\nimport fs from 'node:fs';
const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(path.join(f.root, 'calls'))},JSON.stringify(args)+'\\n');
if(args[0]==='agent'&&args[1]==='get') console.log(JSON.stringify({result:{agent:{agent:'claude',pane_id:'fake:p1',agent_status:'idle'}}}));
else if(args[0]==='pane'&&args[1]==='read') console.log('────────────────────\\n❯ \\n────────────────────');
else console.log('{}');\n`, { mode: 0o755 });
  const result = await promptSupervisor(f.entry.to, f.entry.message, { org: f.org, cwd: f.repo, id: 'exception',
    herdr, executeAutopilot: f.execute, waitSeconds: 2, confirmSeconds: 0, pollSeconds: 0.01 });
  assert.equal(result.delivered, true);
  const entry = readInbox(result.inbox)[0], prompts = f.herdrCalls().filter(a => a[0] === 'agent' && a[1] === 'prompt');
  assert.ok(prompts.length >= 1);
  assert.equal(prompts[0][3], `${entry.autopilot.summary} notice-id=exception`);
  assert.ok(prompts[0][3].includes('receipt='));
  assert.ok(prompts[0][3].startsWith(`[org-report] run=${f.run} `));
  assert.equal(entry.message, f.entry.message);
});
test('a busy chat drain cannot prevent a routine policy action', async t => {
  const f = setup(t, [pass, { phase: 'acknowledged' }]);
  const inbox = path.join(f.org, 'supervisor/inbox.log'), release = noticeLock(`${inbox}.drain.lock`);
  try {
    const result = await promptSupervisor(f.entry.to, f.entry.message, { org: f.org, cwd: f.repo, id: 'routine-while-busy', executeAutopilot: f.execute, waitSeconds: 0 });
    assert.equal(result.handled, true); assert.equal(f.calls.length, 2); assert.deepEqual(f.herdrCalls(), []);
  } finally { release(); }
});
for (const withFindings of [false, true]) test(`actual handle and promotion commands ${withFindings ? 'file findings and accept them' : 'settle PASS and enqueue'} offline`, t => {
  const f = setup(t); f.commit('correct\n');
  // The worker report was recorded before the commit only to keep setup small;
  // settle still reads the actual clean lane and independent scripted reviewer.
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
  const result = autopilotNotice(f.entry, { execute: call });
  assert.equal(result.disposition, 'handled', fs.readFileSync(result.receipt, 'utf8'));
  const saved = JSON.parse(fs.readFileSync(result.receipt));
  assert.equal(saved.actions[0].result.result, withFindings ? 'promotable_with_findings' : 'promotable');
  if (withFindings) {
    assert.ok(saved.follow_up); assert.deepEqual(f.show(saved.follow_up).accept, [minor]);
  }
  assert.ok(f.show(f.run).notes.some(n => n.text.includes('notice-autopilot/v1')));
  const events = fs.readFileSync(path.join(f.org, 'events.jsonl')), calls = f.herdrCalls();
  assert.equal(autopilotNotice(f.entry, { execute: call }).disposition, 'handled');
  assert.deepEqual(fs.readFileSync(path.join(f.org, 'events.jsonl')), events);
  assert.deepEqual(f.herdrCalls(), calls);
});
test('automatic PASS reaches the real queue, lands and closes without waking the supervisor', { timeout: 30000 }, async t => {
  const f = setup(t); f.commit('correct\n');
  const call = (file, args) => {
    const r = f.exec(process.execPath, [file, ...args]);
    if (r.status !== 0) throw Error(r.stderr || r.stdout);
    return r.stdout;
  };
  const result = await promptSupervisor(f.entry.to, f.entry.message, { org: f.org, cwd: f.repo, id: 'automatic-cycle', executeAutopilot: call, waitSeconds: 0 });
  assert.equal(result.handled, true, result.autopilot?.summary);
  const directory = path.join(f.entry.project.identity, 'promote'), deadline = Date.now() + loadTimeout(20000);
  let closed = false;
  while (Date.now() < deadline) {
    closed = f.show(f.item).closed?.as === 'done';
    if (closed && !fs.existsSync(path.join(directory, 'worker.lock'))) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(closed, 'promotion notice closes the record without supervisor chat');
  assert.ok(!fs.existsSync(path.join(directory, 'worker.lock')), 'finite promotion owner exited');
  assert.ok(!fs.existsSync(f.workspace)); assert.equal(fs.readFileSync(path.join(f.repo, 'work.txt'), 'utf8'), 'correct\n');
  const queue = JSON.parse(fs.readFileSync(path.join(directory, 'queue.json')));
  assert.equal(queue.results.length, 1); assert.equal(queue.results[0].outcome, 'promoted');
  const notices = readInbox(result.inbox); assert.equal(notices.length, 2);
  assert.ok(notices.every(entry => entry.state === 'handled'));
  assert.ok(f.herdrCalls().filter(a => a[0] === 'agent' && a[1] === 'prompt').every(a => a[3].includes('Private record file:')));
});
