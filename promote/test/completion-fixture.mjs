import { fixtureEnvironment } from '../../test/helpers/fixture-environment.mjs';
// Shared private record, lane and native-worker fixture for completion cases.
import { healthyMemoryEnvironment } from '../../test/helpers/promotion-memory-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { queueFor, enqueue } from '../promote.mjs';
import { reconcile } from '../../supervisor/reconcile.mjs';
import { handoffCloseout } from '../../lib/closeout-handoff.mjs';
import { digest } from '../../lib/completion.mjs';
import { fold } from '../../lib/state.mjs';
import { fixtureFleet } from '../../test/helpers/offline-herdr.mjs';
import { waitForInboxIdle } from '../../test/helpers/inbox.mjs';
import { commandAllowance } from '../../test/helpers/command-allowance.mjs';
import { promotionWorkers } from '../../test/helpers/promotion-worker.mjs';
export const source = fileURLToPath(new URL('../../', import.meta.url));
export function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'batch-complete-'))), repo = path.join(root, 'repo');
  fixtureFleet(t, root); fs.mkdirSync(repo);
  // These lifecycle cases inspect synchronous delivery; opt into a bounded wait.
  const env = { ...healthyMemoryEnvironment(fixtureEnvironment()), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', SUPERVISOR_INPUT_WAIT_SECONDS: '10', SUPERVISOR_INPUT_CONFIRM_SECONDS: '0.001', SUPERVISOR_INPUT_POLL_SECONDS: '0.001' };
  for (const k of Object.keys(env)) if (/^(LANE_|ORG_|HERDR_|GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG_COUNT))/.test(k)) delete env[k];
  env.HERDR_MONITOR_FLEET = process.env.HERDR_MONITOR_FLEET;
  const exec = (command, args, cwd = repo, extraEnv = {}) => spawnSync(command, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', [commandAllowance]: 60000 });
  const ok = r => { assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout.trim(); };
  const git = (args, cwd = repo) => ok(exec('git', args, cwd));
  git(['init', '-qb', 'main']); git(['config', 'user.name', 'Completion']); git(['config', 'user.email', 'completion@example.invalid']);
  const org = path.join(repo, '.org');
  const record = (args, extraEnv) => ok(exec(process.execPath, [path.join(source, 'bin/org.mjs'), ...args], repo, extraEnv));
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
  // These adversarial fixtures deliberately change readiness after admission.
  // Exercise the explicit, audited recovery path; ordinary writes now refuse.
  const recover = (member, args) => {
    if (Array.isArray(member)) {
      queue.transaction(data => { data.current = { id: 'fixture-recovery', phase: 'batching', jobs: data.pending }; data.pending = []; });
      member = member[0];
    }
    const data = queue.load();
    const batch = [data.current, ...(data.interrupted ?? [])].find(b => b?.jobs?.some(j => j.id === member.job.id));
    const id = batch?.id ?? data.results.findLast(r => r.id === member.job.id)?.batch ?? member.job.id;
    return record(args, { ORG_GUARD_OVERRIDE: id });
  };
  const lane = (topic, bad = false, options = {}) => {
    const workspace = path.join(root, topic); git(['worktree', 'add', '-qb', `lane/${topic}`, workspace]);
    fs.writeFileSync(path.join(workspace, bad ? 'bad' : topic), topic); git(['add', '.'], workspace); git(['commit', '-qm', topic], workspace);
    const item = record(['add', topic]);
    const superseded = options.supersede ? [record(['start', item, '--workspace', workspace]).match(/^R-\d+/)[0]] : [];
    for (const previous of superseded) record(['claim', previous, '--controller', 'brain']);
    const run = record(['start', item, '--workspace', workspace]).match(/^R-\d+/)[0];
    if (options.owned !== false) record(['claim', run, '--controller', 'brain']);
    const report = path.join(root, `${topic}.md`);
    const proposals = options.proposals?.length ? `proposals:\n${options.proposals.map(p => Object.entries(p).map(([key, value], i) => `${i ? '    ' : '  - '}${key}: ${JSON.stringify(value)}`).join('\n')).join('\n')}\n` : '';
    fs.writeFileSync(report, `---\nrun: ${run}\noutcome: done\nsummary: Implemented ${topic}\nheadline: Implemented ${topic}\n${proposals}${options.questions ? "questions:\n  - question: Does this behavior need adjustment?\n    category: design\n    recommend: no\n    why: The implementation is complete\n" : ""}---\n`);
    record(['ingest', report]);
    if (options.childBeforeAdmission) record(['add', 'New engineering scope', '--role', 'engineer', '--parent', item]);
    const head = git(['rev-parse', 'HEAD'], workspace);
    const job = enqueue(queue, [topic], { to: 'test', herdr, attempts: 1, retry: 0,
      laneCLI: path.join(source, 'lanes/lane.mjs'), org, run, claimedBy: options.owned === false ? undefined : 'brain', expectedHead: head, superseded })[0];
    const member = { topic, workspace, item, run, head, job, superseded }; members.push(member); return member;
  };
  const drain = () => {
    const output = ok(exec(process.execPath, [path.join(source, 'promote/promote.mjs'), '--drain']));
    const data = queue.load();
    const refusals = [...data.results, ...(data.current?.results ?? []).map(m => m.result)].filter(r => r.code?.startsWith('PROMOTE_NATIVE_'));
    if (refusals.length) t.diagnostic(JSON.stringify({ native_refusals: refusals.map(({ id, code, reason }) => ({ id, code, reason })) }));
    return output;
  };
  const show = id => JSON.parse(record(['show', id, '--json']));
  const gates = () => fs.existsSync(count) ? fs.readFileSync(count, 'utf8').trim().split('\n').length : 0;
  const events = () => fs.readFileSync(path.join(org, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const workers = promotionWorkers(repo);
  t.after(async () => { await workers.wait(); await waitForInboxIdle(path.join(org, 'supervisor/inbox.log')); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, repo, org, env, git, record, recover, queue, lane, drain, show, gates, events, fault, members, checker, preload, workers };
}


export function manualRecovery(f, rows, mode = 'complete') {
  const original = JSON.parse(fs.readFileSync(rows[0].receipt + '.record.json'));
  const manifest = path.join(f.repo, '.lane/manual-recovery.json'), prepared = path.join(f.repo, '.lane/manual-prepared.json');
  if (mode === 'wrong-head') f.git(['reset', '--hard', original.tip], rows[0].workspace);
  const items = (mode === 'missing-member' ? original.items.slice(0, 1) : original.items)
    .map((e, index) => ({ item: e.item, run: e.run, head: mode === 'wrong-head' && index === 0 ? original.tip : e.head,
      superseded: e.superseded, why: 'Inspected record changes and retained native gate proof.' }));
  const excluded = [...original.excluded];
  if (mode === 'missing-member') excluded.push({ item: original.items[1].item, run: original.items[1].run,
    superseded: [], disposition: 'historical', reason: 'Recovery deferred', next_action: 'Inspect this integrated member separately' });
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ batch: 'manual-recovery', candidate: f.git(['rev-parse', 'main']), items, excluded }));
  const args = ['--repo', f.repo, '--org', f.org, '--role', 'supervisor', '--prepared', prepared];
  const log = mode === 'wrong-log' ? path.join(f.root, 'other-gate.log') : rows[0].log;
  if (mode === 'wrong-log') fs.copyFileSync(rows[0].log, log);
  reconcile(['prepare', ...args, '--manifest', manifest, '--gate-log', log]);
  const result = reconcile(['finish', ...args, '--gate-exit', '0', '--tip', f.git(['rev-parse', 'main'])]);
  f.manualReceipt = prepared + '.record.json';
  return result;
}

// The caller of the stable manual adapter owns its tail, after native
// bookkeeping releases the interrupted integration/reconciliation references.
export function finishManualCloseout(f, receipt = f.manualReceipt) {
  const events = f.events(), state = fold(events), payload = JSON.parse(fs.readFileSync(receipt));
  const source = events.find(e => e.type === 'promotion.reconciled' && e.batch === payload.batch && e.fingerprint === digest(payload));
  assert.ok(source);
  const keys = source.closeout_targets.filter(t => {
    const item = state.items.get(t.item), run = state.runs.get(t.run);
    return item?.closed?.as === 'done' && item.runs.at(-1) === t.run && run?.report && !run.abandoned &&
      !events.some(e => e.seq > source.seq && e.type === 'item.reopened' && e.id === t.item);
  }).map(t => t.key);
  assert.ok(keys.length, 'manual caller retains at least one exact closed target');
  handoffCloseout({ cwd: f.repo, org: f.org, receipt, keys, env: f.env });
  f.drain();
}
