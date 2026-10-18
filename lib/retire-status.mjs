// Display projections only. Retirement authority stays in the shared planner.
import { chainFor, matchingRun, matchingRelease, planRetirement, integratedLaneDecision } from './retire.mjs';
import { roleIs } from './roles.mjs';
import { terminalTimes, ageMs, renderAge } from './retire-age.mjs';
import { effectiveWorkerIdentity } from './worker-identity.mjs';

export const RETIREMENT_CLASSES = ['TERMINAL', 'ACTIVE', 'WAITING', 'IDLE-NONTERMINAL', 'UNKNOWN', 'PROTECTED'];
const values = value => value instanceof Map ? [...value.values()] : value ?? [];
const unique = list => [...new Set(list.filter(v => v !== undefined && v !== null && v !== ''))];
const joined = list => unique(list).join(', ') || null;
const latest = runs => [...runs].sort((a, b) => (b.started?.seq ?? 0) - (a.started?.seq ?? 0))[0];
const session = a => a.agent_session?.value ?? a.agent_session_id;
const referenceText = ref => `${ref.kind ?? 'live'} reference ${ref.job ?? ref.owner ?? ''}`.trim();
const openChainReason = /^(?:review, correction or integration chain is still open|(?:R-\d+|[A-Z][A-Z0-9]*-\d+) awaits correction or disposition|declined blocker .+|review .+ has no terminal PASS|chain item .+ has no recorded disposition)$/;
const agentExitKeepReasons = new Set([
  'agent exit topology changed',
  'agent exit terminal identity changed or unknown',
  'agent exit occupant identity changed',
  'agent exit shell identity changed or another process remains',
  'agent exit recorded launch identity changed',
  'agent exit checkout is not clean and integrated',
  'ambiguous agent exit receipts',
]);
const laneSweepKeepReasons = new Set([
  'unknown or mismatched registered lane identity',
  'promotion queue cleanup pending; retry through queue',
]);
const laneInventoryReasons = new Set(['lane worktree is not clean', 'lane tip is not integrated in main',
  'lane has no commits of its own and no recorded terminal chain', 'lane branch history is unavailable and no recorded terminal chain']);

function nextActor(snapshot, run) {
  if (!run) return 'supervisor/Astra: resolve chain ownership';
  const chain = chainFor(snapshot.record, run), items = chain.items.filter(i => chain.ids.has(i.id));
  const human = items.find(i => roleIs(i, 'HUM') && !i.closed);
  if (human) return `operator: answer ${human.id}`;
  const reviews = items.filter(i => roleIs(i, 'REV'));
  const failed = reviews.find(i => {
    const r = latest(chain.runs.filter(r => r.item === i.id));
    return r?.report && String(r.report.extra?.verdict ?? '').trim().toUpperCase() !== 'PASS';
  });
  const owner = latest(chain.runs.filter(r => r.item === chain.root?.id))?.meta?.agent;
  if (failed || ['blocked', 'needs_human', 'failed'].includes(run.report?.outcome))
    return `fix owner ${owner ?? chain.root?.id ?? run.item}: correction or disposition`;
  const review = reviews.find(i => !i.closed);
  if (review) return `reviewer ${latest(chain.runs.filter(r => r.item === review.id))?.meta?.agent ?? review.id}: review ${chain.root?.id ?? run.item}`;
  return `supervisor: arrange review or integration for ${chain.root?.id ?? run.item}`;
}

// Every known reason has a display mapping; a new/foreign reason stays UNKNOWN.
// This function cannot authorize an action, even when it returns TERMINAL.
export function classifyRetirement(decision, { snapshot = {}, agents = [] } = {}) {
  const reason = decision?.why ?? 'missing planner decision';
  const keep = () => ({ class: 'UNKNOWN', nextAction: `keep; ${reason}` });
  if ((snapshot.errors ?? []).includes(reason) || (snapshot.git ?? []).some(g => g.error === reason) ||
      (Array.isArray(snapshot.standardSlots?.errors) && snapshot.standardSlots.errors.includes(reason))) return keep();
  if (['release', 'exit'].includes(decision?.decision)) return { class: 'TERMINAL', nextAction: 'terminal; retire through the guarded executor' };
  if (decision?.decision !== 'keep') return keep();
  if (agentExitKeepReasons.has(reason)) return keep();
  if (laneInventoryReasons.has(reason)) return { class: null, nextAction: `keep; ${reason}` };
  if (laneSweepKeepReasons.has(reason)) return keep();
  if (['operator focus or this tab', 'persistent, operator or lab workspace', 'persistent or detached desk workspace'].includes(reason) ||
      /^adopted standard slot (?:chat|supervisor|logs) \(.+\); explicit withdrawal required$/.test(reason))
    return { class: 'PROTECTED', nextAction: 'keep' };
  const reference = (snapshot.references ?? []).find(ref => referenceText(ref) === reason);
  if (reference) return /^unknown\b/i.test(reference.kind ?? '') ? keep() : {
    class: 'ACTIVE', nextAction: `waiting on ${reference.owner ?? reference.kind ?? 'live resource'}${reference.job ? ` (${reference.job})` : ''}`,
  };
  if (/^occupant .+ is (?:working|blocked)$/.test(reason)) return { class: 'ACTIVE', nextAction: `waiting on ${reason.slice(9)}` };
  if (/^(?:R-\d+ report is not ingested|callback report is not ingested|open run on .+|open run in lane|open run uses callback checkout|open recorded run uses lane|retained successor for handoff from R-\d+)$/.test(reason))
    return { class: 'ACTIVE', nextAction: `waiting on ${reason}` };
  if (openChainReason.test(reason)) {
    const runs = agents.map(a => matchingRun(a, snapshot.record)).filter(Boolean);
    // Callback rows may name their run without a native agent occupant.
    if (!runs.length && decision.run) runs.push(values(snapshot.record?.runs).find(r => r.id === decision.run));
    if (!runs.length || runs.some(r => !r)) return keep();
    const current = runs.find(run => {
      const chain = chainFor(snapshot.record, run);
      return latest(chain.runs.filter(r => r.item === run.item))?.id === run.id ||
        (roleIs(chain.items.find(i => i.id === run.item), 'REV') && latest(chain.runs.filter(r => chain.ids.has(r.item) && roleIs(chain.items.find(i => i.id === r.item), 'REV')))?.id === run.id);
    });
    if (current) return { class: 'WAITING', nextAction: nextActor(snapshot, current) };
    if (agents.length && agents.every(a => ['idle', 'done'].includes(a.agent_status ?? a.status)))
      return { class: 'IDLE-NONTERMINAL', nextAction: 'release candidate; supervisor/Astra decision via `record pane-release` (ENG-369)' };
  }
  return keep();
}

function identityDiagnostic(agent, snapshot) {
  if (matchingRun(agent, snapshot.record)) return null;
  const candidates = values(snapshot.record?.runs).filter(r => r.meta?.agent === agent.name ||
    (r.meta?.pane === agent.pane_id && r.meta?.worker_workspace === agent.workspace_id) ||
    (session(agent) && effectiveWorkerIdentity(r, snapshot.record).agent_session_id === session(agent)));
  const run = latest(candidates);
  if (!run) return null;
  const identity = effectiveWorkerIdentity(run, snapshot.record);
  if (identity.identity_conflict) return `${agent.name}: conflicting recorded launch/session evidence for ${run.id}; keep and inspect`;
  const missing = ['worker_workspace', 'terminal_id', 'agent_session_id'].filter(key => !identity[key]);
  return missing.length ? `${agent.name}: newest candidate ${run.id} lacks ${missing.join(', ')}; launcher must call dispatch/record-worker.mjs (dispatch/README.md, External dispatchers)` : null;
}

function processDiagnostic(panes) {
  let unnamed = 0;
  const names = panes.flatMap(p => {
    const info = p.process_info ?? {}, roots = new Set([info.shell_pid, ...(info.foreground_processes ?? []).map(row => row.pid)]);
    // Kernel comm only; foreground argv/argv0 and command lines never leave here.
    return (info.process_tree ?? []).filter(row => !roots.has(row.pid)).flatMap(row => {
      const comm = /^\[(.+)\]$/s.exec(row.command ?? '');
      if (comm) return [comm[1]];
      unnamed++;
      return [];
    });
  });
  return joined([...names, ...(unnamed ? [`${unnamed} unnamed`] : [])]);
}

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
function releaseRecommendation(snapshot, run) {
  const git = snapshot.git?.find(g => g.path === run.workspace);
  const m = effectiveWorkerIdentity(run, snapshot.record);
  if (m.identity_conflict) return null;
  if (!m.agent_session_id || !m.terminal_id || !git?.head || git.error) {
    const lane = git?.lane ?? m.lane;
    const root = snapshot.workspaces?.find(w => w.worktree?.checkout_path === run.workspace)?.worktree?.repo_root;
    // lane close preserves unmerged work in archive/lane/<topic> and performs
    // its own fresh record, Git, reference and occupant checks.
    return lane && root ? `cd ${quote(root)} && lane close ${quote(lane)}` : null;
  }
  return `record pane-release ${run.id} --session ${quote(m.agent_session_id)} --terminal ${quote(m.terminal_id)} --pane ${quote(m.pane)} --head ${quote(git.head)} --authority '<confirmed authority>' --next ${quote(nextActor(snapshot, run))} --unresolved '<disposition of unresolved work>' --evidence ${quote(run.report_path ?? '<evidence path>')} --confirm --why '<release reason>'`;
}

export function retirementStatus(snapshot, { project = snapshot.common, generatedAt = new Date().toISOString(), worktrees = [], promotions = [] } = {}) {
  const held = snapshot.retirementHold ?? null, plan = planRetirement(snapshot);
  const display = held ? planRetirement({ ...snapshot, retirementHold: undefined }) : plan;
  const observedRuns = unique([...(snapshot.agents ?? []).map(a => matchingRun(a, snapshot.record)),
    ...(snapshot.callbacks ?? []).map(c => values(snapshot.record?.runs).find(r => r.id === c.run))]).filter(Boolean);
  const times = terminalTimes(snapshot, observedRuns);
  const rows = [];
  for (const decision of [...display.close, ...display.keep]) {
    const panes = (snapshot.panes ?? []).filter(p => p.tab_id === decision.tab_id);
    const ws = (snapshot.workspaces ?? []).find(w => w.workspace_id === decision.workspace_id);
    const tabAgents = (snapshot.agents ?? []).filter(a => a.tab_id === decision.tab_id || panes.some(p => p.pane_id === a.pane_id));
    const callback = (snapshot.callbacks ?? []).find(r => r.tab === decision.tab_id);
    const classification = classifyRetirement({ ...decision, run: callback?.run }, { snapshot, agents: tabAgents });
    const add = (type, pane, agents, observedPanes) => {
      const matched = agents.map(a => ({ name: a.name ?? null, kind: a.agent ?? null, status: a.agent_status ?? a.status ?? null,
        run: matchingRun(a, snapshot.record) }));
      const diagnostics = agents.map(a => identityDiagnostic(a, snapshot)).filter(Boolean);
      if (decision.why === 'background or unknown pane process remains') {
        const names = processDiagnostic(observedPanes);
        if (names) diagnostics.push(`extra kernel processes: ${names}`);
      }
      const runs = matched.map(a => a.run).filter(Boolean);
      if (!runs.length && callback?.run) {
        const run = values(snapshot.record?.runs).find(r => r.id === callback.run);
        if (run) runs.push(run);
      }
      const dates = runs.map(run => {
        const agent = agents.find(a => matchingRun(a, snapshot.record)?.id === run.id);
        const git = snapshot.git?.find(g => g.path === run.workspace);
        const release = agent && matchingRelease(snapshot, agent, run, git);
        const natural = times.get(run.id), explicit = release?.head === git?.head ? release?.at : null;
        return natural && explicit ? (Date.parse(natural) < Date.parse(explicit) ? natural : explicit) : natural ?? explicit;
      });
      const terminalAt = dates.length && dates.every(at => Number.isFinite(Date.parse(at))) ? dates.reduce((a, b) => Date.parse(a) > Date.parse(b) ? a : b) : null;
      const terminalAgeMs = ageMs(terminalAt, generatedAt);
      const recommendations = classification.class === 'IDLE-NONTERMINAL' ? unique(runs.map(run => releaseRecommendation(snapshot, run))) : [];
      rows.push({ type, workspace: decision.workspace_id, worktree: ws?.worktree?.checkout_path ?? null, tab: decision.tab_id, pane,
        agent: joined(matched.map(a => a.name)), kind: joined(matched.map(a => a.kind)), status: joined(matched.map(a => a.status)),
        run: joined(matched.map(a => a.run?.id)), item: joined(matched.map(a => a.run?.item)),
        lane: joined(matched.map(a => a.run?.meta?.lane)) ?? snapshot.git?.find(g => g.path === ws?.worktree?.checkout_path)?.lane ?? null,
        ...classification, terminalAt, terminalAgeMs, terminalAge: renderAge(terminalAgeMs),
        ...(classification.class === 'IDLE-NONTERMINAL' ? { nextActor: runs.map(run => nextActor(snapshot, run)).join('; '),
          recommendation: recommendations.join('; ') || null,
          nextAction: recommendations.length ? `supervisor/Astra: confirm release evidence, then ${recommendations.join('; ')}` : classification.nextAction } : {}),
        held, reason: [decision.why, ...diagnostics].join('; '),
        agents: matched.map(a => ({ ...a, run: a.run?.id ?? null })),
      });
    };
    add('tab', null, tabAgents, panes);
    for (const pane of panes) add('pane', pane.pane_id, tabAgents.filter(a => a.pane_id === pane.pane_id), [pane]);
  }
  for (const tree of worktrees) {
    // Compact inventories deliberately omit cleanliness; they cannot establish
    // sweep eligibility or turn ordinary work in progress into UNKNOWN rows.
    let decision;
    if (tree.branch?.startsWith('lane/') && tree.clean != null) {
      // Inventory keeps precede project errors; one diagnostic must not turn
      // every lane still in progress into another UNKNOWN row.
      const why = tree.clean !== true ? 'lane worktree is not clean' : tree.integrated !== true ? 'lane tip is not integrated in main' : null;
      decision = why ? { decision: 'keep', why } : integratedLaneDecision(held ? { ...snapshot, retirementHold: undefined } : snapshot, tree);
    }
    const recordError = tree.clean === true && tree.integrated === true ? tree.recordError : null;
    const keepReason = recordError ?? (decision?.decision === 'keep' ? decision.why : tree.error);
    // Tabs/panes already account for occupants, runs, chains and references.
    // Only sweep-specific failures classify a lane inventory row; ordinary
    // non-lane inventory read errors retain their existing UNKNOWN class.
    const classified = recordError || laneSweepKeepReasons.has(keepReason) || (!tree.branch?.startsWith('lane/') && tree.error);
    rows.push({ ...tree, type: 'worktree', class: classified ? 'UNKNOWN' : null, held,
      reason: `${keepReason ? `${keepReason}; ` : ''}branch ${tree.branch ?? 'detached'}; head ${tree.head ?? '?'}; integrated ${tree.integrated ?? '?'}; clean ${tree.clean ?? '?'}; archive ${tree.archiveTag ? `${tree.archiveTag} (${tree.archiveMatchesHead ? 'HEAD' : 'different tip'})` : 'none'}; untracked ${tree.untracked ?? '?'}; ignored ${tree.ignored ?? '?'}; panes ${tree.paneCount}`,
      nextAction: keepReason ? `keep; ${keepReason}` : decision ? 'eligible for integrated-lane sweep; evidence and fresh authority verified on apply' : 'inventory only; lane retirement requires a fresh guarded plan' });
  }
  for (const row of promotions.filter(row => ['queued', 'admission', 'stage', 'reconcile', 'unknown', 'withheld'].includes(row.phase))) {
    const unknown = ['unknown', 'withheld'].includes(row.phase);
    rows.push({ type: 'promotion', held: null, id: row.id, source: row.project, item: row.item, lane: row.lane, worktree: row.worktree,
      pane: row.where.pane, kind: row.kind, status: row.phase, class: unknown ? 'UNKNOWN' : 'ACTIVE',
      reason: `${row.project}: ${row.id}; ${row.status.text}`,
      nextAction: unknown ? `keep; ${row.project}: ${row.status.text}` : `waiting on ${row.project}: ${row.id} (${row.phase})` });
  }
  for (const diagnostic of display.diagnostics.filter(d => d.type === 'follow-up')) rows.push({
    ...diagnostic, worktree: diagnostic.cwd, class: null, held,
  });
  for (const reason of unique([...(snapshot.errors ?? []), ...display.diagnostics.filter(d => d.type !== 'follow-up').map(d => d.reason)])) {
    const ignored = reason === 'expired reference ignored' && !(snapshot.errors ?? []).includes(reason);
    rows.push({ type: 'diagnostic', class: ignored ? null : 'UNKNOWN', held, reason,
      nextAction: ignored ? 'diagnostic only; no live hold' : `keep; ${reason}` });
  }
  const counts = Object.fromEntries(RETIREMENT_CLASSES.map(name => [name, rows.filter(r => r.class === name).length]));
  return { schema: 'lanes-status/v1', generatedAt, project, held, counts, rows };
}

const columns = [['type', 'Type'], ['location', 'Workspace / worktree'], ['identity', 'Identity'], ['tab', 'Tab'], ['pane', 'Pane'], ['agent', 'Agent'],
  ['kind', 'Kind'], ['status', 'Status'], ['run', 'Run'], ['item', 'Item'], ['lane', 'Lane'], ['terminalAge', 'Terminal age'], ['class', 'Class'], ['held', 'Held'], ['reason', 'Reason / facts'], ['nextAction', 'Next action']];
const text = value => String(value ?? '—').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
export function renderRetirementStatus(status, { markdown = false } = {}) {
  const displayText = value => markdown ? text(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') : text(value);
  const matrix = [columns.map(([, title]) => title), ...status.rows.map(row => columns.map(([key]) => text(key === 'location' ? row.workspace ?? row.worktree : key === 'held' ? row.held ? 'yes' : 'no' : row[key])))];
  let table;
  if (markdown) {
    const line = cells => `| ${cells.map(cell => cell.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|')).join(' | ')} |`;
    table = [line(matrix[0]), line(columns.map(() => '---')), ...matrix.slice(1).map(line)].join('\n');
  } else {
    const widths = columns.map((_, i) => Math.max(...matrix.map(row => row[i].length)));
    table = matrix.map(row => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
  }
  return [`Lanes: ${text(status.project)} (${text(status.generatedAt)})`,
    `Hold: ${text(status.held ?? 'none')}`,
    `Counts (classified rows): ${RETIREMENT_CLASSES.map(c => `${c}=${status.counts[c]}`).join(', ')}`,
    'Operator: record today lists reserved decisions.',
    `TERMINAL older than 30 minutes: ${status.rows.filter(r => r.class === 'TERMINAL' && r.terminalAgeMs > 1800000).length}`, '',
    ...status.rows.filter(r => r.class === 'TERMINAL' && r.terminalAgeMs > 1800000).map(r => `- ${displayText(r.type)} ${displayText(r.pane ?? r.tab ?? r.worktree)}: ${displayText(r.run)}; ${displayText(r.terminalAge)}`),
    ...status.rows.filter(r => r.class === 'IDLE-NONTERMINAL').map(r => `- IDLE-NONTERMINAL ${displayText(r.pane ?? r.tab ?? r.worktree)}: ${displayText(r.nextActor ?? r.nextAction)}; ${displayText(r.recommendation)}`),
    '', table, ''].join('\n');
}
