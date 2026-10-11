import test from '../../test/helpers/bounded-test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueFor, enqueue } from '../promote.mjs';
import { reconcileBatchCompletion } from '../completion.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { waitForInboxIdle } from '../../test/helpers/inbox.mjs';
import { commandAllowance } from '../../test/helpers/command-allowance.mjs';

const source = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'batch-complete-'))), repo = path.join(root, 'repo');
  fixtureFleet(t, root); fs.mkdirSync(repo);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.001', SUPERVISOR_INPUT_POLL_SECONDS: '0.001' };
  for (const k of Object.keys(env)) if (/^(LANE_|ORG_|HERDR_|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(k)) delete env[k];
  env.HERDR_MONITOR_FLEET = process.env.HERDR_MONITOR_FLEET;
  const exec = (command, args, cwd = repo) => spawnSync(command, args, { cwd, env, encoding: 'utf8', [commandAllowance]: 60000 });
  const ok = r => { assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim(); };
  const git = (args, cwd = repo) => ok(exec('git', args, cwd));
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Completion']); git(['config', 'user.email', 'completion@example.invalid']);
  const org = path.join(repo, '.org');
  const record = args => ok(exec(process.execPath, [path.join(source, 'bin/org.mjs'), ...args]));
  record(['init', org]);
  const count = path.join(root, 'gates'), checker = path.join(root, 'check.cjs');
  fs.writeFileSync(checker, `const fs=require('fs');fs.appendFileSync(${JSON.stringify(count)},'gate\\n');console.log('# tests 1');if(fs.existsSync('bad'))process.exit(1);`);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.org/\n.lane/\n');
  fs.writeFileSync(path.join(repo, '.supervisor.json'), JSON.stringify({ autopilot: { enabled: false } }));
  fs.writeFileSync(path.join(repo, '.lane.validation.json'), JSON.stringify({ promotion: `${process.execPath} ${checker}` }));
  fs.writeFileSync(path.join(repo, 'base'), 'base'); git(['add', '.']); git(['commit', '-qm', 'Base']);
  const herdr = path.join(root, 'herdr');
  fs.writeFileSync(herdr, `#!${process.execPath}
const a=process.argv.slice(2);if(a[0]==='agent'&&a[1]==='get')console.log(JSON.stringify({result:{agent:{agent:'claude',agent_status:'idle',pane_id:'fake'}}}));
else if(a[0]==='pane'&&a[1]==='read')console.log('────────────────────\\n❯ \\n────────────────────');
else console.log(JSON.stringify({result:{workspaces:[],agents:[]}}));`, { mode: 0o755 });
  const fault = path.join(root, 'refuse-record'), preload = path.join(root, 'fault.cjs');
  fs.writeFileSync(preload, `if(process.argv[1]?.endsWith('org.mjs')&&process.argv.includes('complete-batch')&&require('fs').existsSync(${JSON.stringify(fault)})){if(require('fs').readFileSync(${JSON.stringify(fault)},'utf8')==='lost-ack'){process.stdout.write=()=>true;}else{console.error('injected record refusal');process.exit(1);}}`);
  env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ""} --require ${preload}`;
  const queue = queueFor(repo), members = [];
  const lane = (topic, bad = false) => {
    const workspace = path.join(root, topic); git(['worktree', 'add', '-qb', `lane/${topic}`, workspace]);
    fs.writeFileSync(path.join(workspace, bad ? 'bad' : topic), topic); git(['add', '.'], workspace); git(['commit', '-qm', topic], workspace);
    const item = record(['add', topic]), run = record(['start', item, '--workspace', workspace]).match(/^R-\d+/)[0];
    const report = path.join(root, `${topic}.md`);
    fs.writeFileSync(report, `---\nrun: ${run}\noutcome: done\nsummary: Implemented ${topic}\nheadline: Implemented ${topic}\n---\n`);
    record(['ingest', report]);
    const head = git(['rev-parse', 'HEAD'], workspace);
    const job = enqueue(queue, [topic], { to: 'test', herdr, attempts: 1, retry: 0,
      laneCLI: path.join(source, 'lanes/lane.mjs'), org, run, expectedHead: head })[0];
    const member = { topic, workspace, item, run, head, job }; members.push(member); return member;
  };
  const drain = () => ok(exec(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain']));
  const show = id => JSON.parse(record(['show', id, '--json']));
  const gates = () => fs.existsSync(count) ? fs.readFileSync(count, 'utf8').trim().split('\n').length : 0;
  const events = () => fs.readFileSync(path.join(org, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  t.after(async () => { await waitForInboxIdle(path.join(org, 'supervisor/inbox.log')); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, repo, org, env, git, record, queue, lane, drain, show, gates, events, fault, members };
}

for (const size of [1, 3]) test(`native ${size}-member batch reconciles atomically before cleanup and duplicate recovery`, t => {
  const f = fixture(t); for (let i = 0; i < size; i++) f.lane(`lane-${i}`);
  f.drain(); assert.equal(f.gates(), 1);
  const rows = f.queue.load().results;
  assert.equal(rows.length, size);
  for (const m of f.members) { assert.equal(f.show(m.item).closed.as, 'done'); assert.equal(fs.existsSync(m.workspace), false); }
  assert.ok(rows.every(r => r.reconciliation.state === 'complete'));
  const events = f.events(), markers = events.filter(e => e.type === 'promotion.reconciled');
  assert.equal(markers.length, 1); assert.equal(markers[0].items.length, size);
  const velocity = events.filter(e => e.type === 'note.added' && e.text.startsWith('Promotion: report-to-main'));
  assert.ok(velocity.every(e => e.seq > markers[0].seq), 'even pre-cleanup telemetry follows whole-batch reconciliation');
  const before = fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8');
  const replay = reconcileBatchCompletion({ project: f.queue.project, jobs: rows, results: rows.map(job => ({ job, result: job })) });
  assert.equal(replay.pending, false); assert.equal(replay.results[0].result.reconciliation.replayed, true);
  assert.equal(fs.readFileSync(path.join(f.org, 'events.jsonl'), 'utf8'), before);
  f.drain(); assert.equal(f.gates(), 1);
});

test('integrated record refusal retains every lane and resumes records without another gate', t => {
  const f = fixture(t); const first = f.lane('first'), second = f.lane('second');
  fs.writeFileSync(f.fault, 'refuse'); f.drain();
  assert.equal(f.gates(), 1); assert.equal(f.queue.load().interrupted.length, 1);
  for (const m of [first, second]) { assert.equal(f.show(m.item).closed, null); assert.ok(fs.existsSync(m.workspace)); }
  assert.ok(f.queue.load().results.every(r => r.reconciliation.state === 'pending'));
  const receipt = f.queue.load().results[0].receipt, log = fs.readFileSync(f.queue.load().results[0].log, 'utf8');
  const proof = JSON.parse(fs.readFileSync(receipt));
  fs.unlinkSync(f.fault); f.drain(); assert.equal(f.gates(), 1);
  assert.equal(fs.readFileSync(f.queue.load().results[0].log, 'utf8'), log);
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt)).attempts, proof.attempts);
  for (const m of [first, second]) { assert.equal(f.show(m.item).closed.as, 'done'); assert.equal(fs.existsSync(m.workspace), false); }
  assert.equal(f.events().filter(e => e.type === 'promotion.reconciled').length, 1);
  assert.equal(f.queue.load().interrupted.length, 0);
});

test('bisected batch accounts for its exclusion without mutating newer excluded work', t => {
  const f = fixture(t), first = f.lane('first'), second = f.lane('second'), bad = f.lane('broken', true);
  fs.writeFileSync(f.fault, 'refuse'); f.drain(); assert.equal(f.gates(), 3);
  f.record(['start', bad.item, '--workspace', bad.workspace]);
  f.record(['note', bad.item, 'New excluded correction is underway']);
  const excluded = f.show(bad.item);
  fs.unlinkSync(f.fault); f.drain(); assert.equal(f.gates(), 3);
  assert.deepEqual(f.show(bad.item), excluded); assert.ok(fs.existsSync(bad.workspace));
  for (const m of [first, second]) { assert.equal(f.show(m.item).closed.as, 'done'); assert.equal(fs.existsSync(m.workspace), false); }
  const marker = f.events().find(e => e.type === 'promotion.reconciled');
  assert.deepEqual(marker.excluded, [bad.item]); assert.equal(marker.historical_exclusions[0].run, bad.run);
});

for (const change of ['new-run', 'blocker', 'missing-member']) test(`recovery refuses ${change} and retains all integrated lanes`, t => {
  const f = fixture(t), first = f.lane('first'), second = f.lane('second');
  fs.writeFileSync(f.fault, 'refuse'); f.drain(); const gates = f.gates(); fs.unlinkSync(f.fault);
  if (change === 'new-run') f.record(['start', first.item, '--workspace', first.workspace]);
  if (change === 'blocker') f.record(['ask', 'Reserved decision?', '--parent', first.item, '--category', 'design', '--recommend', 'yes', '--why', 'Need operator decision', '--blocks', first.item, '--wait']);
  if (change === 'missing-member') {
    const receipt = f.queue.load().results[0].receipt, plan = JSON.parse(fs.readFileSync(receipt));
    plan.completion.jobs.pop(); fs.writeFileSync(receipt, JSON.stringify(plan));
  }
  f.drain(); assert.equal(f.gates(), gates);
  for (const m of [first, second]) { assert.equal(f.show(m.item).closed, null); assert.ok(fs.existsSync(m.workspace)); }
  assert.equal(f.events().filter(e => e.type === 'promotion.reconciled').length, 0);
  assert.equal(f.queue.load().interrupted.length, 1);
});


test('lost record acknowledgement replays the receipt before cleanup without repeating the gate or completion events', t => {
  const f = fixture(t), first = f.lane('first'), second = f.lane('second');
  fs.writeFileSync(f.fault, 'lost-ack'); f.drain();
  assert.equal(f.gates(), 1); assert.equal(f.events().filter(e => e.type === 'promotion.reconciled').length, 1);
  for (const m of [first, second]) { assert.equal(f.show(m.item).closed.as, 'done'); assert.ok(fs.existsSync(m.workspace)); }
  const receipt = f.queue.load().results[0].receipt + '.record.json', bytes = fs.readFileSync(receipt, 'utf8');
  fs.unlinkSync(f.fault); f.drain();
  assert.equal(f.gates(), 1); assert.equal(fs.readFileSync(receipt, 'utf8'), bytes);
  assert.equal(f.events().filter(e => e.type === 'promotion.reconciled').length, 1);
  assert.ok(f.queue.load().results.slice(-2).every(r => r.reconciliation.replayed));
  for (const m of [first, second]) assert.equal(fs.existsSync(m.workspace), false);
});


for (const mode of ['operator-reserved', 'human']) test(`native completion refuses ${mode} work before gating or integration`, t => {
  const f = fixture(t), member = f.lane('reserved'), base = f.git(['rev-parse', 'main']);
  f.record(['set', member.item, mode === 'human' ? 'role=human' : 'meta.operator_reserved=true']);
  f.drain(); assert.equal(f.gates(), 0); assert.equal(f.git(['rev-parse', 'main']), base);
  assert.ok(fs.existsSync(member.workspace)); assert.equal(f.show(member.item).closed, null);
  assert.equal(f.queue.load().results[0].outcome, 'refused');
  assert.match(f.queue.load().results[0].reason, /not ordinary authorized work/);
});
