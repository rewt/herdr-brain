import { parseArgs } from 'node:util';
import { findOrgDir, transact, UserError, writer } from './store.mjs';
import { fold } from './state.mjs';
import { requestRetirement } from './retire-trigger.mjs';
import { effectiveWorkerIdentity } from './worker-identity.mjs';
import { readReviewVerdicts } from './review-verdict.mjs';
import { gitProject } from './project.mjs';
import { protectRecordMutation } from './record-guard.mjs';
import { boundSuccessor, SESSION_RELEASE_POLICY } from './session-release.mjs';
import { publishCloseoutEvents } from './closeout.mjs';

// Explicit operator/supervisor confirmation recorded by the record CLI. This
// leaves both reports immutable and does not put eligibility in the fold.
export function handoffCommand(argv) {
  const { values: opt, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    to: { type: 'string' }, confirm: { type: 'boolean' }, why: { type: 'string' },
  } });
  const [from] = positionals;
  if (positionals.length !== 1 || !/^R-\d+$/.test(from ?? '') || !/^R-\d+$/.test(opt.to ?? '') || !opt.confirm || !opt.why?.trim())
    throw new UserError('usage: record handoff R-old --to R-new --confirm --why TEXT');
  const org = findOrgDir();
  if (!org) throw new UserError('no record found');
  const who = writer();
  const result = transact(org, events => {
    const state = fold(events), a = state.runs.get(from), b = state.runs.get(opt.to);
    const am = effectiveWorkerIdentity(a, state), bm = effectiveWorkerIdentity(b, state);
    const identity = r => { const m = effectiveWorkerIdentity(r, state); return !m.identity_conflict && r?.workspace && m.pane && m.worker_workspace && (m.terminal_id || m.agent_session_id); };
    if (!identity(a) || !identity(b) || a.item !== b.item || b.started.seq <= a.started.seq || b.abandoned ||
        state.items.get(b.item)?.runs.at(-1) !== b.id || a.meta.pane === b.meta.pane ||
        (am.agent_session_id && am.agent_session_id === bm.agent_session_id)) throw new UserError('handoff requires a newer retained successor with a different recorded launch identity on the same item');
    const prior = events.filter(e => e.type === 'retirement.handoff' && e.from === from).at(-1);
    if (prior && prior.to !== b.id) throw new UserError('handoff already names a different successor');
    return protectRecordMutation({ org, events, state, command: 'handoff', mutation: {
      add: prior ? [] : [{ type: 'retirement.handoff', from, to: b.id, item: a.item, confirmed: true, why: opt.why }],
    } });
  }, { actor: who.actor, unattributed: who.unattributed });
  if (result.added.length) try { requestRetirement({ org, eventSeq: result.added.at(-1).seq, source: 'record handoff' }); }
  catch (e) { process.stderr.write(`record: retirement request deferred: ${e.message}\n`); }
  publishCloseoutEvents({ org, added: result.added });
  process.stdout.write(JSON.stringify({ from, to: opt.to, recorded: result.added.length > 0 }) + '\n');
  return 0;
}

export function releaseCommand(argv) {
  const { values: opt, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    ...Object.fromEntries(['session', 'terminal', 'pane', 'head', 'authority', 'next', 'unresolved', 'why'].map(key => [key, { type: 'string' }])),
    evidence: { type: 'string', multiple: true }, confirm: { type: 'boolean' }, reviewer: { type: 'boolean' },
  } });
  const [run] = positionals, org = findOrgDir();
  if (!org) throw new UserError('no record found');
  if (positionals.length !== 1) throw new UserError('usage: record pane-release R-n (see record help)');
  const result = recordPaneRelease({ org, run, opt });
  process.stdout.write(JSON.stringify({ run, recorded: result.added.length > 0 }) + '\n');
  return 0;
}

// Both manual confirmations and the project policy use this exact transaction.
// The policy guard re-observes native identity/references under the record lock.
export function recordPaneRelease({ org, run, opt, guard, actor, common } = {}) {
  const who = writer();
  const result = transact(org, events => {
    guard?.(events);
    const review = opt.reviewer ? readReviewVerdicts(org, common ?? gitProject().identity).find(r => r.run === run &&
      r.pane === opt.pane && r.session === opt.session && r.terminal === opt.terminal) : null;
    return protectRecordMutation({ org, events, state: fold(events), command: 'pane-release',
      mutation: paneReleaseEvents(events, run, opt, { review }) });
  }, { actor: actor ?? who.actor, unattributed: actor ? false : who.unattributed });
  if (result.added.length) try { requestRetirement({ org, eventSeq: result.added.at(-1).seq, source: 'record pane-release' }); }
  catch (e) { process.stderr.write(`record: retirement request deferred: ${e.message}\n`); }
  publishCloseoutEvents({ org, added: result.added });
  return result;
}

export function paneReleaseEvents(events, run, opt, { review } = {}) {
  if (!/^R-\d+$/.test(run ?? '') || !opt.confirm ||
      !/^[a-f\d]{40}$/i.test(opt.head ?? '') ||
      ['session', 'terminal', 'pane', 'authority', 'next', 'unresolved', 'why'].some(key => !opt[key]?.trim()) ||
      !opt.evidence?.length || opt.evidence.some(value => !value.trim()))
    throw new UserError('usage: record pane-release R-n --session S --terminal T --pane P --head SHA --authority TEXT --next TEXT --unresolved TEXT --evidence PATH... --confirm --why TEXT');
  const state = fold(events), r = state.runs.get(run);
  const m = opt.reviewer ? { agent_session_id: review?.session, terminal_id: review?.terminal, pane: review?.pane, worker_workspace: review?.workspace } : effectiveWorkerIdentity(r, state);
  if (opt.reviewer && (!review || review.cwd !== r?.workspace)) throw new UserError('release requires a recorded reviewer launch and verdict');
  const superseded = !opt.reviewer && opt.policy === SESSION_RELEASE_POLICY && boundSuccessor(state, r);
  if (!r || (r.abandoned && !superseded)) throw new UserError('release requires an existing, non-abandoned run');
  if ((!Number.isSafeInteger(r.report?.seq) || r.report.seq < 1) && !superseded) throw new UserError(`${run} report is not ingested`);
  if (m.identity_conflict || !r.workspace || !m.worker_workspace || !m.agent_session_id ||
      !m.terminal_id || opt.session !== m.agent_session_id || opt.terminal !== m.terminal_id || opt.pane !== m.pane)
    throw new UserError('release requires the exact recorded native session, terminal, pane and workspace');
  if ([...state.runs.values()].some(newer => newer.started.seq > r.started.seq &&
      (newer.meta?.pane === m.pane || effectiveWorkerIdentity(newer, state).terminal_id === m.terminal_id || effectiveWorkerIdentity(newer, state).agent_session_id === m.agent_session_id)))
    throw new UserError('a newer run uses the same pane or native session; continuation keeps the pane');
  const release = { type: 'retirement.release', run, item: r.item, pane: opt.pane, terminal: opt.terminal,
    session: opt.session, workspace: m.worker_workspace, cwd: r.workspace, head: opt.head,
    authority: opt.authority, confirmed: true, why: opt.why,
    ...(opt.reviewer ? { recipient: 'reviewer', agent: review.agent, review_id: review.id } : {}),
    ...(opt.policy ? { policy: opt.policy } : {}) };
  const text = `Release ${run}: session ${opt.session}; terminal ${opt.terminal}; pane ${opt.pane}; head ${opt.head}. ` +
    `Evidence: ${opt.evidence.join(', ')}. Unresolved work: ${opt.unresolved}. Next actor or dispatch condition: ${opt.next}. ` +
    `Authority: ${opt.authority}. Why: ${opt.why}`;
  const prior = events.find(e => e.type === 'retirement.release' && e.run === run &&
    (e.recipient ?? 'worker') === (opt.reviewer ? 'reviewer' : 'worker') && (!opt.reviewer || e.pane === opt.pane));
  if (prior && (Object.keys(release).some(key => prior[key] !== release[key]) ||
      !events.some(e => e.type === 'note.added' && e.id === r.item && e.kind === 'release' && e.text === text)))
    throw new UserError(`${run} already has a different release`);
  return { add: prior ? [] : [{ type: 'note.added', id: r.item, text, decision: true, kind: 'release' }, release] };
}
