#!/usr/bin/env node
// Foreground custody of ONE recorded duty. No launch, identity adoption, entry
// catch-up, lifecycle action, callback retarget, scheduler or permission grant.
import fs, { observeGit } from '../lib/record-observation.mjs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { loadEvents, transact, withRecordGuard } from '../lib/store.mjs';
import { fold, openQuestionsFor } from '../lib/state.mjs';
import { readHandoff, recordedHandoffs, handoffKey } from '../lib/handoffs.mjs';
import { assertOwner, readOwnedRun } from '../lib/run-owner-guard.mjs';
import { readProjectPolicy } from '../lib/config-policy.mjs';
import { protectRecordMutation } from '../lib/record-guard.mjs';
import { nativeSender } from '../messages/operator-inbox.mjs';
import { readInbox } from '../messages/inbox-read.mjs';
import { readStandardSlots } from '../sessions/receipts.mjs';
import { readControllerJournal } from '../sessions/runtime.mjs';
import { equalBinding } from '../sessions/lifecycle-evidence.mjs';
import { parseUniqueJson } from '../sessions/json.mjs';
import { herdrSocketPath } from '../lanes/board/herdr-client.mjs';
import { lineDirectory } from '../line-service/cutoff.mjs';
import { gitProject } from '../lib/project.mjs';
import { projectEnvironment } from '../lib/releases.mjs';
import { invokeHerdr } from './herdr-edge.mjs';
import { safePoint } from './safe-point.mjs';

const source = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const text = v => typeof v === 'string' && v.trim() && !/[\x00-\x1f\x7f]/u.test(v);
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const git = (repo, args) => {
  observeGit(repo);
  return execFileSync('git', ['--no-optional-locks', '-C', repo, ...args],
    { env: projectEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
};
const nativeTuple = b => ({ name: b.native.name, pane: b.native.pane_id, workspace: b.native.workspace_id,
  terminal: b.native.terminal_id, session: b.native.agent_session.value, cwd: b.project.checkout });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const present = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };

export function parseDuty(markdown) {
  const blocks = [...markdown.matchAll(/^```brain-supervisor-duty\r?\n([\s\S]*?)^```\s*$/gm)];
  if (blocks.length !== 1) throw Error('handoff needs exactly one brain-supervisor-duty block');
  const d = parseUniqueJson(blocks[0][1]);
  if (!exact(d, ['schema', 'id', 'item', 'run', 'intent', 'project', 'source_head', 'claim', 'duty', 'lifetime', 'predecessor', 'successor', 'recovery', 'obligations']) ||
      d.schema !== 'supervisor-duty/v1' || !/^[\w:-]{1,100}$/.test(d.id ?? '') ||
      !/^R-\d+$/.test(d.run ?? '') || !text(d.item) || !text(d.intent) ||
      !exact(d.project, ['canonical', 'common', 'org', 'head']) ||
      !['canonical', 'common', 'org'].every(k => path.isAbsolute(d.project[k] ?? '')) ||
      ![d.project.head, d.source_head].every(h => /^[a-f0-9]{40}$/.test(h ?? '')) ||
      !exact(d.claim, ['owner', 'generation']) || !Number.isSafeInteger(d.claim.generation) ||
      !exact(d.lifetime, ['not_before', 'expires']) ||
      ![d.lifetime.not_before, d.lifetime.expires].every(v => text(v) && Number.isFinite(Date.parse(v))) ||
      Date.parse(d.lifetime.expires) <= Date.parse(d.lifetime.not_before) ||
      d.predecessor !== null && (!exact(d.predecessor, ['start_seq', 'result_seq']) || !Object.values(d.predecessor).every(v => Number.isSafeInteger(v) && v > 0)) ||
      !exact(d.successor, ['owner', 'next_event']) || !Object.values(d.successor).every(text) ||
      !exact(d.recovery, ['owner', 'planning_channel', 'next_event']) || !Object.values(d.recovery).every(text) ||
      !Array.isArray(d.obligations) || d.obligations.some(o => !exact(o, ['id', 'owner', 'attempt', 'receipt', 'next_event']) || !Object.values(o).every(text)))
    throw Error('invalid finite supervisor duty contract');
  dutyCommand(d); // Closed catalog; no arbitrary script, shell or native argv.
  return d;
}

export function dutyCommand(d) {
  const p = d.project, c = d.duty;
  if (exact(c, ['kind', 'through']) && c.kind === 'checkpoint' && Number.isSafeInteger(c.through) && c.through >= 0)
    return ['supervisor/supervisor.mjs', 'checkpoint', '--through', String(c.through), '--repo', p.canonical, '--org', p.org, '--role', 'supervisor'];
  if (exact(c, ['kind', 'journal', 'id', 'decision_seq']) && c.kind === 'resolve-launch' &&
      typeof c.journal === 'string' && path.dirname(c.journal) === path.join(p.org, 'dispatch') &&
      /^[\w-]{1,80}$/.test(c.id ?? '') && Number.isSafeInteger(c.decision_seq) && c.decision_seq > 0)
    return ['dispatch/launch-reservations.mjs', 'resolve', '--repo', p.canonical, '--org', p.org,
      '--journal', c.journal, '--id', c.id, '--decision-seq', String(c.decision_seq)];
  throw Error('unsupported duty: only an exact checkpoint or existing guarded launch resolution is supported');
}

export function inspectDuty({ org, handoffSeq, events } = {}) {
  org = fs.realpathSync(org);
  if (!events) {
    const loaded = loadEvents(org);
    if (loaded.tornTail) throw Error('incomplete record event');
    events = loaded.events;
  }
  const entry = events.find(e => e.type === 'handoff.recorded' && e.seq === handoffSeq);
  if (!entry || entry.slot !== 'supervisor') throw Error('exact recorded supervisor handoff sequence required');
  const handoff = readHandoff(org, entry), duty = parseDuty(fs.readFileSync(handoff.path, 'utf8'));
  if (duty.project.org !== org) throw Error('handoff belongs to another record');
  const attempts = events.filter(e => e.type.startsWith('supervisor.duty.') && e.duty_id === duty.id);
  return { duty, handoff, attempts };
}

function verify({ org, handoffSeq, cwd, env, call, now, finishing = false }, events, expected) {
  const doc = inspectDuty({ org, handoffSeq, events }), d = doc.duty, p = d.project;
  const binding = nativeSender(org, { cwd, env, call }), b = nativeTuple(binding);
  const configured = readProjectPolicy(p.canonical, 'promote', env, { canonical: p.canonical }).config.to;
  if (binding.project.checkout !== p.canonical || binding.project.canonical !== p.canonical ||
      binding.project.identity !== p.common || configured !== b.name || doc.handoff.author !== b.name ||
      doc.handoff.workspace !== b.workspace)
    throw Error('actual canonical project supervisor and original handoff owner required; labels grant no authority');
  if (expected && !same(b, expected)) throw Error('native supervisor session/terminal binding changed');
  const latest = recordedHandoffs(events).get(handoffKey(doc.handoff.workspace, 'supervisor'));
  if (latest.seq !== handoffSeq) throw Error('handoff was superseded; retain the original duty');
  const enrollment = readStandardSlots(p.common);
  if (enrollment.errors.length) throw Error(enrollment.errors.join('; '));
  const slots = enrollment.slots.filter(s => s.standardSlot === 'supervisor' && s.checkout === p.canonical &&
    s.server === herdrSocketPath(env) && s.workspace === b.workspace && s.panes.some(v => v.pane === b.pane));
  const read = args => {
    const reply = JSON.parse(call('herdr', args));
    if (!reply.result || reply.ok === false || reply.error) throw Error('native observation UNKNOWN/refused; retain binding');
    return reply.result;
  };
  const pane = read(['pane', 'get', b.pane]).pane, agents = read(['agent', 'list']).agents;
  if (slots.length !== 1 || pane?.tab_id !== slots[0].tab || pane.pane_id !== b.pane ||
      pane.workspace_id !== b.workspace || pane.terminal_id !== b.terminal || !Array.isArray(agents))
    throw Error('native supervisor enrollment or physical binding changed');
  const occupants = agents.filter(a => a.name === b.name || a.pane_id === b.pane || a.terminal_id === b.terminal || a.agent_session?.value === b.session);
  if (occupants.length !== 1 || !same(nativeTuple({ native: occupants[0], project: { checkout: occupants[0].cwd } }), b))
    throw Error('conflicting live occupant or changed native identity');
  // KEEP enrollment protects a layout; it cannot authorize a renamed worker.
  // Require the existing controller's acknowledged real launch/incarnation too.
  const journal = readControllerJournal(p.common), physical = { server: herdrSocketPath(env), workspace: b.workspace,
    tab: pane.tab_id, pane: b.pane, checkout: b.cwd, terminalId: b.terminal, agentName: b.name, nativeSessionId: b.session };
  const launched = journal.operations.some(op => op.state === 'acknowledged' &&
    ['start-standard-slot', 'create-standard-slot'].includes(op.kind) && op.spec.role === 'supervisor' && equalBinding(op.receipt.binding, physical));
  const restored = journal.incarnations.some(i => equalBinding(i.binding, physical) && journal.operations.some(op =>
    op.id === i.operationId && op.state === 'acknowledged' && op.participants?.some(m => m.uid === i.uid && m.spec.role === 'supervisor')));
  if (!launched && !restored) throw Error('acknowledged canonical native supervisor launch binding is missing; KEEP/display metadata grants no authority');
  if (now() < Date.parse(d.lifetime.not_before) || now() >= Date.parse(d.lifetime.expires)) throw Error('finite duty lifetime is not current');
  for (const [repo, head] of [[p.canonical, p.head], [source, d.source_head]])
    if (git(repo, ['rev-parse', 'HEAD']) !== head || git(repo, ['status', '--porcelain=v1', '--untracked-files=all']) ||
        git(repo, ['ls-files', '-v', '-z']).split('\0').some(row => /^[a-zS] /.test(row)))
      throw Error('clean committed canonical/source head changed or unique source is unaccounted');
  const main = readProjectPolicy(p.canonical, 'lane', env, { canonical: p.canonical }).config.main ?? 'main';
  if (git(p.canonical, ['symbolic-ref', '--short', 'HEAD']) !== main) throw Error('canonical checkout has unique branch source; retain it for its actual owner');
  if (gitProject(p.canonical).identity !== p.common) throw Error('actual Git common directory changed');
  for (const file of [path.join(org, 'STOP'), path.join(lineDirectory(org, p.common), 'STOP'),
    ...['STOP', 'HOLD'].map(n => path.join(p.canonical, '.lane/supervisor', n))])
    if (present(file)) throw Error('STOP/HOLD prevents finite duty');
  const state = fold(events), run = assertOwner(readOwnedRun(org, d.run, events), d.claim);
  if (run.item !== d.item || !finishing && (run.abandoned || run.report) || !run.workspace || gitProject(run.workspace).identity !== p.common)
    throw Error('original run/claim/source is no longer current');
  for (let item = state.items.get(d.item); item; item = state.items.get(item.parent))
    if (item.closed || item.role === 'human' || ['hold', 'held', 'reserved', 'operator_reserved'].some(k => item.meta[k]) ||
        ['security', 'funds-and-chain', 'publish', 'delete-data', 'licensing', 'priorities'].includes(item.meta.category))
      throw Error('held or reserved effect requires its actual owner; no finite-duty waiver');
  if (openQuestionsFor(state, d.item).length) throw Error('unapproved operator question prevents finite duty');
  if (d.obligations.some(o => o.owner === b.name)) throw Error('unhandled callback/job remains with its original supervisor owner');
  const inbox = path.join(org, 'supervisor/inbox.log');
  if (present(inbox) && (!fs.lstatSync(inbox).isFile() || fs.realpathSync(inbox) !== inbox)) throw Error('original inbox is redirected or unreadable');
  if (readInbox(inbox).some(e => e.to === b.name && e.state !== 'handled'))
    throw Error('original pending/sent/UNKNOWN/refused notice remains unhandled; no replay or retarget');
  const busy = events.filter(e => e.type === 'supervisor.duty.started' && e.project === p.common &&
    e.duty_id !== d.id && !events.some(f => f.type === 'supervisor.duty.completed' && f.start_seq === e.seq));
  if (busy.length) throw Error('another finite duty retains canonical custody (cap1)');
  return { ...doc, binding: b };
}

function record(options, build) {
  return transact(options.org, events => protectRecordMutation({ org: options.org, events, state: fold(events),
    command: 'supervisor finite-duty', mutation: build(events) }),
  { actor: options.actor, strictTail: true, lockOptions: { recover: false } });
}

// The checkpoint calls this immediately around its cursor write. It retains
// the existing cursor lock and fences the recorded claim/source across effect.
export function guardDutyCheckpoint({ org, startSeq, through, cwd = process.cwd(), env = process.env, call = invokeHerdr, now = Date.now }, operation) {
  return withRecordGuard(org, events => {
    const start = events.find(e => e.type === 'supervisor.duty.started' && e.seq === startSeq);
    if (!start || start.duty.kind !== 'checkpoint' || start.duty.through !== through ||
        events.some(e => e.type === 'supervisor.duty.result' && e.start_seq === startSeq)) throw Error('original unspent checkpoint duty intent required');
    verify({ org, handoffSeq: start.handoff_seq, cwd, env, call, now }, events, start.native);
  }, operation, { recover: false, label: 'finite-duty-checkpoint' });
}

export function runDuty({ org, handoffSeq, cwd = process.cwd(), env = process.env, call = invokeHerdr,
  now = Date.now, command = spawnSync } = {}) {
  const options = { org: fs.realpathSync(org), handoffSeq, cwd, env, call, now };
  const first = verify(options, loadEvents(options.org).events), d = first.duty;
  options.actor = first.binding.name;
  const { added: [start] } = record(options, events => {
    verify(options, events, first.binding);
    if (d.predecessor) {
      const completed = events.find(e => e.type === 'supervisor.duty.completed' && e.start_seq === d.predecessor.start_seq &&
        e.result_seq === d.predecessor.result_seq && e.successor_seq === handoffSeq);
      if (!completed || completed.native.session === first.binding.session)
        throw Error('next duty requires the completed predecessor handoff and a fresh native session');
    }
    if (events.some(e => e.type === 'supervisor.duty.started' && e.duty_id === d.id))
      throw Error('original duty attempt already exists; failed/UNKNOWN attempts cannot replay');
    return { add: [{ type: 'supervisor.duty.started', duty_id: d.id, item: d.item, run: d.run,
      project: d.project.common, handoff_seq: handoffSeq, handoff_sha256: first.handoff.sha256,
      claim: d.claim, source_head: d.source_head, native: first.binding, duty: d.duty,
      command: [process.execPath, ...dutyCommand(d).map((v, i) => i === 0 ? path.join(source, v) : v)], node: process.version,
      successor: d.successor, recovery: d.recovery }] };
  });
  let result;
  try {
    verify(options, loadEvents(options.org).events, first.binding);
    const [file, ...args] = dutyCommand(d);
    if (d.duty.kind === 'checkpoint') args.push('--finite-duty-start', String(start.seq));
    // Existing tools keep their own fresh native/claim/source/CAS/FF checks.
    // No shell, timeout kill, role rewrite, runtime switch or automatic retry.
    const r = command(process.execPath, [path.join(source, file), ...args], { cwd: d.project.canonical,
      env: { ...env, ORG_DIR: options.org, ORG_ACTOR: first.binding.name }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    result = { state: r.error || r.signal || r.status === null ? 'unknown' : r.status === 0 ? 'succeeded' : 'failed',
      command: [process.execPath, path.join(source, file), ...args],
      exit_code: r.status ?? null, signal: r.signal ?? null, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), error: r.error?.message ?? null };
  } catch (error) { result = { state: 'unknown', exit_code: null, error: error.message }; }
  const { added: [receipt] } = record(options, () => ({ add: [{ type: 'supervisor.duty.result', duty_id: d.id,
    item: d.item, run: d.run, start_seq: start.seq, project: d.project.common, native: first.binding, result }] }));
  return { start, receipt, termination_authorized: false };
}

export function finishDuty({ org, handoffSeq, successorSeq, cwd = process.cwd(), env = process.env,
  call = invokeHerdr, now = Date.now, readProcess } = {}) {
  org = fs.realpathSync(org);
  const doc = inspectDuty({ org, handoffSeq }), starts = doc.attempts.filter(e => e.type === 'supervisor.duty.started');
  if (starts.length !== 1) throw Error('one original duty binding required');
  const start = starts[0], options = { org, handoffSeq, cwd, env, call, now, actor: start.native.name, finishing: true };
  // The successor handoff necessarily supersedes the original; verify all
  // original fences before recording it, then use its exact immutable bytes.
  const events = loadEvents(org).events, next = inspectDuty({ org, handoffSeq: successorSeq, events });
  if (next.handoff.seq <= handoffSeq || next.duty.id === doc.duty.id || !next.duty.predecessor ||
      next.duty.predecessor.start_seq !== start.seq ||
      !['canonical', 'common', 'org'].every(k => next.duty.project[k] === doc.duty.project[k]) ||
      next.handoff.workspace !== doc.handoff.workspace || next.handoff.author !== start.native.name ||
      doc.duty.successor.owner !== next.handoff.author)
    throw Error('successor must be a fresh recorded duty in the original supervisor slot');
  if (doc.duty.obligations.some(o => !next.duty.obligations.some(n => same(n, o))))
    throw Error('successor handoff must preserve original callback/job obligations and owners');
  // Verify against a view ending immediately before the successor handoff.
  // All claim/HOLD/inbox/source/native reads still use current state below.
  const checkEvents = rows => rows.filter(e => !(e.type === 'handoff.recorded' && e.workspace === doc.handoff.workspace && e.slot === 'supervisor' && e.seq > handoffSeq));
  verify(options, checkEvents(events), start.native);
  const observation = safePoint({ cwd, org, pane: start.native.pane, readProcess,
    call: args => {
      const reply = JSON.parse(call('herdr', args));
      if (!reply.result || reply.ok === false || reply.error) throw Error('native safe boundary UNKNOWN/refused');
      return reply.result;
    } });
  if (!observation.safe) throw Error('safe boundary is held or unknown; retain original binding');
  const { added: [completed] } = record(options, rows => {
    verify(options, checkEvents(rows), start.native);
    const latest = recordedHandoffs(rows).get(handoffKey(doc.handoff.workspace, 'supervisor'));
    if (latest.seq !== successorSeq || inspectDuty({ org, handoffSeq: successorSeq, events: rows }).handoff.sha256 !== next.handoff.sha256)
      throw Error('successor handoff changed');
    const results = rows.filter(e => e.type === 'supervisor.duty.result' && e.start_seq === start.seq);
    if (results.length !== 1 || results[0].result.state !== 'succeeded' || rows.some(e => e.type === 'supervisor.duty.completed' && e.start_seq === start.seq))
      throw Error('failed/UNKNOWN/completed duty retains its original attempt; no completion inferred');
    if (next.duty.predecessor.result_seq !== results[0].seq) throw Error('successor handoff must retain the actual duty receipt');
    return { add: [{ type: 'supervisor.duty.completed', duty_id: doc.duty.id, item: doc.duty.item, run: doc.duty.run,
      project: doc.duty.project.common, start_seq: start.seq, result_seq: results[0].seq, native: start.native,
      successor_seq: successorSeq, successor_sha256: next.handoff.sha256, safe_point: observation,
      termination_authorized: false }] };
  });
  return completed;
}

export function recoveryPlan({ org, handoffSeq } = {}) {
  const doc = inspectDuty({ org, handoffSeq }), p = doc.duty.project, project = gitProject(p.canonical);
  if (project.checkout !== project.canonical || project.identity !== p.common || git(p.canonical, ['rev-parse', 'HEAD']) !== p.head)
    throw Error('recovery handoff project/source changed; original owner must reconcile');
  const supervisor = readProjectPolicy(p.canonical, 'promote', process.env, { canonical: p.canonical }).config.to;
  if (!text(supervisor) || doc.handoff.author !== supervisor) throw Error('canonical recovery owner binding is missing');
  const latest = recordedHandoffs(loadEvents(org).events).get(handoffKey(doc.handoff.workspace, 'supervisor'));
  if (latest.seq !== handoffSeq) throw Error('recovery requires the latest verified handoff; no fallback to an older duty');
  const holds = [path.join(org, 'STOP'), path.join(lineDirectory(org, p.common), 'STOP'),
    ...['STOP', 'HOLD'].map(n => path.join(p.canonical, '.lane/supervisor', n))].filter(present);
  return { kind: 'recovery/manual-assistance', manual_assistance: true, zero_nudge_success: false,
    state: 'manual-owner-checks-required', holds, dirty: Boolean(git(p.canonical, ['status', '--porcelain=v1', '--untracked-files=all'])),
    supervisor, project: p, handoff_seq: handoffSeq, handoff_sha256: doc.handoff.sha256,
    recovery: doc.duty.recovery, attempts: doc.attempts, obligations: doc.duty.obligations,
    action: 'The recorded planning owner uses the existing authorized session controller to start/restore the actual canonical supervisor; read the handoff and original inbox. Missing authority stays pending.',
    required: ['fresh native enrollment/occupancy', 'existing scoped session authorization', 'claim/source/STOP/HOLD checks',
      'read-only entry before duty authorization', 'preserve original attempts, jobs and watcher recipients'],
    executed: false, termination_authorized: false };
}

if (isMain(import.meta.url)) {
  try {
    const { values: v, positionals: p } = parseArgs({ allowPositionals: true,
      usage: 'finite-duty.mjs inspect|run|finish|recovery --org DIR --handoff-seq N [--successor-seq N]',
      options: { org: { type: 'string', default: process.env.ORG_DIR }, 'handoff-seq': { type: 'string' }, 'successor-seq': { type: 'string' } } });
    if (p.length !== 1 || !['inspect', 'run', 'finish', 'recovery'].includes(p[0]) || !v.org || !Number.isSafeInteger(Number(v['handoff-seq']))) throw Error('exact record and handoff sequence required');
    const options = { org: v.org, handoffSeq: Number(v['handoff-seq']), successorSeq: Number(v['successor-seq']) };
    const result = ({ inspect: inspectDuty, run: runDuty, finish: finishDuty, recovery: recoveryPlan })[p[0]](options);
    process.stdout.write(JSON.stringify(result) + '\n');
    if (p[0] === 'run' && result.receipt.result.state !== 'succeeded') process.exitCode = 1;
  } catch (error) { process.stderr.write(`finite-duty: ${error.message}\n`); process.exitCode = 1; }
}
