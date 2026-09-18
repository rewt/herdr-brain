// The board from the read model (org today --json), Herdr's agents and session
// transcripts. Pure: deterministic given its inputs. Rows carry no codes in their
// visible text; codes live only in what the Context tab shows.
import path from 'node:path';
import { doingText, upText, whoFor } from './names.mjs';
import { firstMarkdownPath } from './sources.mjs';
import { DEFAULT_PREFIXES, firstSentence, hasCodes, oneLine, stripCodes } from './text.mjs';
import { CATEGORY_WORDS, asQuestions } from './brain.mjs';

export const NO_PLAIN = '· no plain summary';

const ROLE_WORDS = {
  engineer: 'engineering', engineering: 'engineering', reviewer: 'review', review: 'review',
  architect: 'design', architecture: 'design', designer: 'design', researcher: 'research',
  research: 'research', planner: 'planning', writer: 'writing', human: 'decision', triage: 'triage',
};

export function roleWords(role) {
  if (!role) return 'no role';
  return ROLE_WORDS[role.toLowerCase()] ?? role.toLowerCase();
}

const OUTCOME_WORDS = { done: 'finished', blocked: 'blocked', needs_human: 'needs a decision', failed: 'failed' };

export function outcomeWords(outcome) {
  return OUTCOME_WORDS[outcome] ?? 'outcome not recorded';
}

export function hhmm(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Visible text never shows record codes. Text that has them is shown without them, marked.
// prefixes: the item-id prefixes the organization uses (see text.mjs).
export function plain(text, prefixes) {
  const t = oneLine(text);
  return hasCodes(t, prefixes) ? `${stripCodes(t, prefixes) || 'text with only codes'} ${NO_PLAIN}` : t;
}

// The plain line for a decision note: its summary, or its first sentence without codes, marked.
// `plain` says whether the agent recorded a summary; a summary with codes is still marked.
export function decisionHeadline(note, prefixes) {
  if (note.summary && oneLine(note.summary)) return { text: plain(note.summary, prefixes), plain: true };
  const stripped = stripCodes(firstSentence(note.text), prefixes);
  return { text: `${stripped || 'decision recorded'} ${NO_PLAIN}`, plain: false };
}

function whoAnswered(by) {
  if (by === 'human') return 'you';
  if (by === 'auto') return 'auto';
  return by ? 'agent' : 'unknown';
}

function answerWords(answer) {
  return ['yes', 'no'].includes(answer) ? answer : 'answered';
}

// A yes/no question shows what each answer does under its row, when it says.
function yesNoOptions(q, visible) {
  if (!q.on_yes && !q.on_no) return [];
  return [
    { key: 'y', label: 'yes', causes: q.on_yes ? visible(q.on_yes) : 'not recorded' },
    { key: 'n', label: 'no', causes: q.on_no ? visible(q.on_no) : 'not recorded' },
  ];
}

function questionRow(q, visible, ex = null) {
  const rec = String(q.recommend ?? '').trim().toLowerCase();
  // A reading of the question (brain explain) brings the operator's format:
  // a quoted gist, plain sentences on what is at stake, and actions to pick.
  const options = ex?.options?.length
    ? ex.options.filter((o) => o?.key != null && o.label).slice(0, 9).map((o) => ({ key: String(o.key), label: o.label, causes: o.causes ?? '' }))
    : null;
  return {
    key: `q:${q.id}`,
    kind: 'question',
    handle: q.id,
    gist: ex?.gist ?? null,
    explain: ex?.explain ?? null,
    why: ex?.why ?? null,
    headline: visible(q.title),
    category: q.category ?? 'no category',
    recommend: q.recommend ? visible(q.recommend) : null,
    asked: hhmm(q.created?.at),
    tag: q.category ?? 'no category',
    time: hhmm(q.created?.at),
    state: q.recommend ? `recommend: ${visible(q.recommend)}` : 'no recommendation',
    question: q.id,
    options: options ?? yesNoOptions(q, visible),
    via: options ? 'answer' : 'yesno',
    recommendKey: options ? (ex.recommend != null && options.some((o) => o.key === String(ex.recommend)) ? String(ex.recommend) : null)
      : rec === 'yes' ? 'y' : rec === 'no' ? 'n' : null,
    actions: ['approve', 'decline', 'dispatch'],
    doc: q.memo ? { path: q.memo } : { missing: 'no memo recorded' },
    agent: null,
    data: q,
  };
}

// What a stopped session left behind: its question, the choices and how a
// choice reaches it, Claude's draft if there is one, and whether the session
// is still there to peek at, reply to or go to.
// The work item a session was on: what the reading named, else the run the
// session belongs to (a worker by its agent name, a settle session by its run).
function itemForSession(today, session) {
  const runs = [...(today?.running ?? []), ...(today?.agent_runs ?? [])];
  const byAgent = runs.find((r) => r.agent === session);
  if (byAgent?.item) return byAgent.item;
  const m = /^settle-r-(\d+)/.exec(session ?? '');
  if (!m) return null;
  const run = `R-${m[1]}`;
  return runs.find((r) => r.run === run)?.item ?? (today?.finished ?? []).find((f) => f.run === run)?.item ?? null;
}

// A run code is not what the operator calls the work: R-136 becomes the item it ran.
function itemHandle(today, id) {
  if (!id || !/^R-\d+$/.test(id)) return id ?? null;
  const runs = [...(today?.running ?? []), ...(today?.agent_runs ?? []), ...(today?.finished ?? [])];
  return runs.find((r) => r.run === id)?.item ?? id;
}

function leadSentence(text, max = 90) {
  const t = String(text ?? '').trim();
  const stop = t.search(/[.!?](\s|$)/);
  const s = stop > 0 ? t.slice(0, stop + 1) : t;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function resultRow(q, visible, agents, today) {
  const d = q.brain;
  const agent = agents.get(d.session) ?? null;
  const suggestion = d.suggestion ?? d.digest?.suggestion ?? null;
  const actions = [];
  if (q.options.length) actions.push('pick');
  if (suggestion) actions.push('draft');
  if (agent) actions.push('peek', 'reply', 'go');
  if (!q.later) actions.push('later');
  actions.push('drop');
  return {
    ...questionRow(q, visible),
    kind: 'result',
    headline: q.title,
    category: q.category,
    categoryWords: CATEGORY_WORDS[q.category] ?? q.category,
    handle: itemHandle(today, q.item) ?? itemForSession(today, d.session),
    // A finished session's own first line is often terminal chrome; without a
    // gist, the reading's first sentence says it better.
    gist: q.gist ?? (!q.options.length && !d.digest?.question && q.explain ? leadSentence(q.explain) : null),
    explain: q.explain,
    why: q.why,
    from: d.tab_label ?? d.session,
    session: d.tab_label ?? d.session,
    options: q.options,
    via: q.via,
    recommendKey: q.recommendKey,
    suggestion,
    unsent: d.unsent ?? null,
    nextStep: d.digest?.next_step ?? null,
    later: q.later,
    actions,
    go: agent ? { agent: d.session, tab: agent.tab ?? d.tab ?? null, pane: agent.pane ?? d.pane ?? null } : null,
    live: agent,
    data: d,
    doc: d.screen ? { text: d.screen } : { missing: 'nothing was on its screen' },
  };
}

// A waiting row's line, the way the operator reads work: the item's id, then a
// quoted gist of what is at stake (or its title when nothing has been read yet).
function titled(row) {
  const gist = row.gist ? `“${String(row.gist).trim().replace(/^["“']+|["”']+$/g, '')}”` : null;
  const text = gist ?? row.headline;
  return { ...row, title: row.headline, headline: row.handle ? `${row.handle} — ${text}` : text };
}

// A folded group inside Waiting on you: one line until it is opened.
function foldRow(fold, headline, count) {
  return { key: `fold:${fold}`, kind: 'fold', fold, headline, count, actions: [], doc: { missing: 'a group, not an item' }, data: null };
}

// Today's answers, decisions and finished work, newest first.
function historyRows(today, visible, prefixes) {
  const rows = [];
  for (const d of today?.decided ?? []) {
    if (d.kind === 'question') {
      rows.push({
        key: `a:${d.id}`,
        kind: 'answer',
        headline: visible(d.title),
        tag: d.category ?? 'no category',
        time: hhmm(d.at),
        state: `${answerWords(d.answer)} · ${whoAnswered(d.answered_by)}${d.overruled ? ' · overruled' : ''}`,
        question: d.id,
        actions: d.answered_by === 'human' ? [] : ['overrule'],
        doc: d.memo ? { path: d.memo } : { missing: 'no memo recorded' },
        agent: null,
        at: d.at,
        data: d,
      });
    } else {
      const h = decisionHeadline(d, prefixes);
      const doc = firstMarkdownPath(d.text);
      rows.push({
        key: `n:${d.id}:${d.seq}`,
        kind: 'decision',
        headline: h.text,
        plain: h.plain,
        tag: 'decision',
        time: hhmm(d.at),
        state: d.by === 'human' ? 'you' : 'agent',
        question: null,
        actions: [],
        doc: doc ? { path: doc } : { text: d.text },
        agent: null,
        at: d.at,
        data: d,
      });
    }
  }
  for (const f of today?.finished ?? []) {
    if (f.kind === 'report') {
      rows.push({
        key: `f:${f.run}`,
        kind: 'report',
        headline: f.headline ? visible(f.headline) : `${visible(f.title ?? 'untitled work')}: ${outcomeWords(f.outcome)}`,
        tag: roleWords(f.role),
        time: hhmm(f.at),
        state: outcomeWords(f.outcome),
        question: null,
        actions: [],
        doc: { path: f.report_file },
        agent: null,
        at: f.at,
        data: f,
      });
    } else {
      rows.push({
        key: `c:${f.item}:${f.seq}`,
        kind: 'closed',
        headline: `${visible(f.title)}: ${f.as === 'dropped' ? 'dropped' : 'closed'}`,
        tag: roleWords(f.role),
        time: hhmm(f.at),
        state: f.as === 'dropped' ? 'dropped' : 'closed',
        question: null,
        actions: [],
        doc: f.note ? { text: f.note } : { missing: 'no closing note recorded' },
        agent: null,
        at: f.at,
        data: f,
      });
    }
  }
  // Stable for equal times: the order org today gave.
  return rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => (a.at === b.at ? i - j : a.at < b.at ? 1 : -1)).map(([r]) => r);
}

export const STATES = ['working', 'idle', 'blocked', 'done', 'gone', 'unknown'];
const URGENCY = { blocked: 0, working: 1, idle: 2, done: 3, unknown: 4, gone: 5 };
const GONE_KEEP_MS = 3600000;
const UNKNOWN_REPO = { root: '', name: 'unknown repository', path: '', git: false };

function sessionName(run, agent, tabs, prefixes, laneSession) {
  if (run?.lane) return stripCodes(`lane ${run.lane}${run.round ? ` r${run.round}` : ''}`, prefixes);
  const topic = laneSession?.topic ?? String(laneSession?.lane ?? '').replace(/^lane\//, '');
  if (topic) {
    const kind = /^review(?:er)?$/i.test(laneSession.role ?? '') ? 'review' : 'lane';
    return stripCodes(`${kind} ${topic}`, prefixes);
  }
  const folder = agent?.cwd ? path.basename(agent.cwd) : '';
  if (/^lane-[a-z0-9][a-z0-9-]*$/i.test(folder) && (!agent?.name || agent.name.startsWith(`${folder}-`))) {
    return `lane ${folder.slice('lane-'.length)}`;
  }
  if (agent?.name) return stripCodes(agent.name, prefixes) || agent.name;
  const tab = agent?.tab ? tabs.get(agent.tab) : null;
  if (tab?.label) return /^\d+$/.test(tab.label) ? `tab ${tab.label}` : stripCodes(tab.label, prefixes) || `tab ${tab.number ?? ''}`.trim();
  if (run) return `run r${run.round ?? ''}`.trim();
  return agent?.pane ? `pane ${agent.pane}` : 'unnamed session';
}

function sessionRow({ run, agent, state, deps, tabs, prefixes }) {
  const { transcriptOf, repoOf, briefOf, laneSessionOf, nowMs, fallbackCwd } = deps;
  const transcript = agent ? transcriptOf(agent, run) : null;
  const cwd = agent?.cwd ?? run?.workspace ?? null;
  const repo = repoOf(cwd) ?? (agent ? null : repoOf(fallbackCwd)) ?? UNKNOWN_REPO;
  const laneSession = agent && repo.git ? laneSessionOf(agent, repo) : null;
  return {
    key: run ? `r:${run.run}` : agent.name ? `h:${agent.name}` : `h:pane:${agent.pane}`,
    kind: 'session',
    session: sessionName(run, agent, tabs, prefixes, laneSession),
    who: whoFor({ harness: run?.harness, model: run?.model, effort: run?.effort, agentTool: agent?.tool, transcriptModel: transcript?.model }),
    where: cwd ? path.basename(cwd) : 'unknown',
    up: upText(run?.started ?? transcript?.firstAt ?? null, nowMs),
    state,
    doing: doingText({
      title: agent?.title, agentName: agent?.name, prefixes,
      brief: run?.brief_path ? () => briefOf(run.brief_path) : null,
      itemTitle: run?.title,
    }),
    // A row with a live agent can be gone to: by its name, or by its tab.
    go: agent && state !== 'gone' ? { agent: agent.name ?? null, tab: agent.tab ?? null, pane: agent.pane ?? null } : null,
    agent: agent?.name ?? run?.agent ?? null,
    cwd,
    repo,
    run: run ?? null,
    transcript,
    live: agent ?? null,
    actions: agent && state !== 'gone' ? ['peek', 'reply', 'go'] : [],
    doc: run?.brief_path ? { path: run.brief_path } : { missing: 'no brief recorded' },
    question: null,
    data: agent ?? run,
  };
}

// The whole board. Pure given its inputs:
//   today         org today --json
//   herdr         { ok, agents, error } from herdr agent list
//   tabs          herdr tab list (labels for agents without a name)
//   transcriptOf  (agent, run) → { file, model, firstAt, note } | null
//   repoOf        folder → { root, name, path, git } | null
//   briefOf       brief path → text | null
//   seen          agent name → when this console last saw it (ms)
//   fallbackCwd   the project's checkout, for a run with no known folder
export function buildBoard({
  today, brain = null, herdr = null, tabs = [], transcriptOf = () => null, repoOf = () => null, briefOf = () => null,
  laneSessionOf = () => null,
  nowMs = Date.now(), seen = new Map(), fallbackCwd = null, explanations = new Map(), explaining = null,
}) {
  const prefixes = today?.project?.item_prefixes ?? undefined;
  const visible = (text) => plain(text, prefixes);
  const deps = { transcriptOf, repoOf, briefOf, laneSessionOf, nowMs, fallbackCwd };
  // Sessions may belong to other organizations, so their text also loses the default prefixes.
  const sessionPrefixes = [...new Set([...(prefixes ?? []), ...DEFAULT_PREFIXES])];
  const tabMap = new Map((tabs ?? []).map((t) => [t.tab, t]));
  const herdrOk = Boolean(herdr?.ok);
  const agents = herdrOk ? herdr.agents ?? [] : [];
  const byName = new Map(agents.filter((a) => a.name).map((a) => [a.name, a]));
  const runs = today?.running ?? [];
  // An agent is named after its open run, else after the latest finished run it did.
  const runByAgent = new Map([...(today?.agent_runs ?? []), ...runs].filter((r) => r.agent).map((r) => [r.agent, r]));

  const sessions = [];
  for (const agent of agents) {
    const run = agent.name ? runByAgent.get(agent.name) ?? null : null;
    const state = STATES.includes(agent.status) && agent.status !== 'gone' ? agent.status : 'unknown';
    sessions.push(sessionRow({ run, agent, state, deps, tabs: tabMap, prefixes: sessionPrefixes }));
  }
  for (const run of runs) {
    if (run.agent && byName.has(run.agent)) continue;
    if (herdrOk) {
      const last = run.agent ? seen.get(run.agent) : undefined;
      const since = last ?? Date.parse(run.started);
      if (!(nowMs - since < GONE_KEEP_MS)) continue;
    }
    sessions.push(sessionRow({ run, agent: null, state: herdrOk ? 'gone' : 'unknown', deps, tabs: tabMap, prefixes: sessionPrefixes }));
  }

  const groups = new Map();
  for (const row of sessions) {
    const g = groups.get(row.repo.root) ?? { key: row.repo.root, name: row.repo.name, path: row.repo.path, rows: [] };
    g.rows.push(row);
    groups.set(row.repo.root, g);
  }
  const rank = (row) => URGENCY[row.state] ?? 9;
  const byUrgency = (a, b) => rank(a) - rank(b) || a.session.localeCompare(b.session);
  const list = [...groups.values()].map((g) => ({ ...g, rows: g.rows.sort(byUrgency) }));
  list.sort((a, b) => rank(a.rows[0]) - rank(b.rows[0]) || a.name.localeCompare(b.name));

  const tag = (r) => ({ ...r, prefixes });
  const results = asQuestions(brain?.rows ?? []).map((q) => titled(resultRow(q, visible, byName, today)));
  const now = results.filter((r) => !r.later);
  const saved = results.filter((r) => r.later);
  // Questions for a stage the project is not working on yet, or parked, are
  // not the operator's problem today: one line, opened on demand.
  const open = today?.project?.open_stage ?? null;
  const questions = (today?.waiting ?? []).map((q) => titled({ ...questionRow(q, visible, explanations.get(q.id) ?? null), explaining: explaining === q.id }));
  const current = (q) => open === null || q.data.stage === null || q.data.stage === undefined || String(q.data.stage) === String(open);
  const parked = questions.filter((q) => !current(q));
  const waiting = [...now, ...questions.filter(current)];
  const folded = [];
  if (saved.length) folded.push(foldRow('later', `${saved.length} saved for later`, saved.length), ...saved.map((r) => ({ ...r, foldedIn: 'later' })));
  if (parked.length) {
    folded.push(
      foldRow('stages', `${parked.length} older question${parked.length === 1 ? ' is' : 's are'} parked or wait for a later stage (stage ${open} is open now)`, parked.length),
      ...parked.map((r) => ({ ...r, foldedIn: 'stages' })),
    );
  }
  return {
    // What sessions left behind comes first: a stranded reply or a stuck
    // session is costing time now, while an org question waits patiently.
    waiting: [...waiting, ...folded].map(tag),
    waitingCount: waiting.length,
    direction: latestDirection(today),
    groups: list.map((g) => ({ ...g, rows: g.rows.map(tag) })),
    history: historyRows(today, visible, prefixes).map(tag),
    prefixes,
  };
}

// The operator's newest instruction to the whole project today: a decision
// note of theirs on the project's top goal.
function latestDirection(today) {
  const goal = today?.project?.top_goal?.id;
  if (!goal) return null;
  const notes = (today?.decided ?? []).filter((d) => d.kind === 'note' && d.id === goal && d.by === 'human');
  const newest = notes.sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  return newest ? { text: String(newest.text).replace(/^OPERATOR DIRECTION(?: \d{4}-\d{2}-\d{2} \d{2}:\d{2})?:\s*/, ''), at: newest.at, goal } : null;
}

// The rows a view moves through, in screen order.
export function boardRows(board, view = 'list') {
  if (!board) return [];
  return view === 'history' ? board.history : [...board.waiting, ...board.groups.flatMap((g) => g.rows)];
}

// scope: { repo: root | null, view: 'all' | 'needs' | 'working' }. Questions show in every scope.
// unfolded: the folds inside Waiting on you that are open ('later', 'stages').
export function visibleBoard(board, scope = {}, unfolded = []) {
  const keep = (row) => (scope.view === 'needs' ? row.state === 'blocked' : scope.view === 'working' ? row.state === 'working' : true);
  const groups = board.groups
    .filter((g) => !scope.repo || g.key === scope.repo)
    .map((g) => ({ ...g, rows: g.rows.filter(keep) }))
    .filter((g) => g.rows.length);
  const waiting = (board.waiting ?? [])
    .filter((r) => !r.foldedIn || unfolded.includes(r.foldedIn))
    .map((r) => (r.kind === 'fold' ? { ...r, open: unfolded.includes(r.fold) } : r));
  return { ...board, waiting, groups };
}

// The scope choices, with counts: every repository, then the views.
export function scopeItems(board) {
  const rows = board.groups.flatMap((g) => g.rows);
  const count = (state) => rows.filter((r) => r.state === state).length;
  return [
    { label: 'All repositories', count: rows.length, repo: null, view: 'all' },
    ...board.groups.map((g) => ({ label: g.name, count: g.rows.length, repo: g.key, view: 'all' })),
    { label: 'needs you', count: (board.waitingCount ?? board.waiting.length) + count('blocked'), repo: null, view: 'needs', key: '!' },
    { label: 'working', count: count('working'), repo: null, view: 'working', key: 'w' },
    { label: 'history', count: board.history.length, repo: null, view: 'history', key: 'h' },
  ];
}

export function boardKeys(board) {
  return {
    waiting: board.waiting.map((r) => r.key),
    groups: board.groups.map((g) => g.key),
    rows: Object.fromEntries(board.groups.map((g) => [g.key, g.rows.map((r) => r.key)])),
  };
}

// Rows and groups already on screen keep their places on refresh.
export function orderBoard(board, previous) {
  if (!previous) return board;
  const groups = stableOrder(previous.groups, board.groups);
  return {
    ...board,
    waiting: stableOrder(previous.waiting, board.waiting),
    groups: groups.map((g) => ({ ...g, rows: stableOrder(previous.rows?.[g.key], g.rows) })),
  };
}

// Key/value lines for a session's Context tab: the only place codes appear.
export function sessionContext(row, project = {}) {
  const pairs = [];
  const add = (k, v) => {
    if (v !== undefined && v !== null && v !== '') pairs.push([k, String(v)]);
  };
  const a = row.live;
  const r = row.run;
  add('row', row.key);
  add('checkout', row.cwd ?? 'unknown');
  add('repository', row.repo?.path || row.repo?.name);
  add('agent', a ? `${a.name ?? 'unnamed'}${a.tool ? ` (${a.tool})` : ''}` : row.agent ? `${row.agent} (gone)` : 'none');
  if (a) add('herdr', [a.workspace && `workspace ${a.workspace}`, a.tab && `tab ${a.tab}`, a.pane && `pane ${a.pane}`, a.status].filter(Boolean).join(' · '));
  add('session id', a?.session);
  add('run', r ? `${r.run} on ${r.item}: ${r.title ?? 'untitled work'}` : 'no org run');
  add('started', r?.started ?? row.transcript?.firstAt);
  add('brief', r?.brief_path);
  add('report', r?.report_path);
  add('transcript', row.transcript?.file ?? 'not found');
  const models = [row.transcript?.model && `${row.transcript.model} (transcript)`, r?.model && `${r.model} (org)`].filter(Boolean);
  add('model', models.length ? models.join(' · ') : 'unknown');
  add('effort', r?.effort);
  add('gate', 'not recorded');
  add('org', project.org);
  return pairs;
}

// Keeps rows that were already on screen in their previous relative order; new rows
// take their natural place. Rows never reorder under the cursor on refresh.
export function stableOrder(previousKeys, rows) {
  if (!previousKeys?.length) return rows;
  const rank = new Map(previousKeys.map((k, i) => [k, i]));
  const old = rows.filter((r) => rank.has(r.key)).sort((a, b) => rank.get(a.key) - rank.get(b.key));
  let next = 0;
  return rows.map((r) => (rank.has(r.key) ? old[next++] : r));
}

// Selection follows identity: the same row if it still exists, otherwise its nearest
// surviving neighbour from the previous list.
export function keepSelection(previousKey, previousKeys, rows) {
  if (!rows.length) return null;
  const keys = rows.map((r) => r.key);
  if (previousKey && keys.includes(previousKey)) return previousKey;
  const at = previousKeys?.indexOf(previousKey) ?? -1;
  if (at >= 0) {
    for (let d = 1; d < previousKeys.length; d++) {
      for (const k of [previousKeys[at + d], previousKeys[at - d]]) if (k && keys.includes(k)) return k;
    }
  }
  return keys[0];
}

function listTitles(list) {
  return (list ?? []).map((b) => b.title ?? 'untitled work');
}

// What a no means for one dependent. An open run and a closed item both count before
// blockers, so only the rest is really held. Older read models carry no status: unknown.
function afterDecline(b) {
  const name = b.title ?? 'untitled work';
  if (b.open_runs?.length || b.status === 'active') return `Still running, not stopped by the no: ${name}.`;
  if (b.status === 'done' || b.status === 'dropped') return `Already ${b.status === 'dropped' ? 'dropped' : 'closed'}, not reopened: ${name}.`;
  if (b.status === 'blocked') return `Still blocked: ${name}.`;
  return b.status ? `Not held by the no (now ${b.status}): ${name}.` : `Held by the no unless already running or closed: ${name}.`;
}

// Paragraphs for the Summary tab, without codes.
export function summaryParagraphs(row) {
  // A result's text is already plain: it is the session's own words or a
  // reading of them. Running the code stripper over it only mangles session
  // names like "settle R-124" and marks honest prose as code.
  if (row.kind === 'result') return rawParagraphs(row);
  return rawParagraphs(row).map((p) => (p === row.headline ? p : plain(p, row.prefixes)));
}

function rawParagraphs(row) {
  const d = row.data;
  switch (row.kind) {
    case 'question':
      if (row.gist || row.explain) {
        return [
          row.headline,
          row.explain,
          row.options?.length && row.via === 'answer'
            ? ['What you can do:', ...row.options.map((o) => `  ${o.key}  ${o.label}${o.causes ? ` — ${o.causes}` : ''}${row.recommendKey === o.key ? '   ← recommended' : ''}`), 'Press its number to record that answer.'].join('\n')
            : null,
          row.why ? `Why that one: ${row.why}` : null,
          `As filed: ${d.title}`,
          `Asked at ${hhmm(d.created?.at)}.`,
        ].filter(Boolean);
      }
      return [
        row.headline,
        `Recommend: ${d.recommend ?? 'not recorded'}. ${d.why ?? 'No reason recorded.'}`,
        `On yes: ${d.on_yes ?? 'not recorded'}`,
        `On no: ${d.on_no ?? 'not recorded'}`,
        d.blocks?.length ? `Unblocks: ${listTitles(d.blocks).join('; ')}.` : 'Unblocks: nothing recorded.',
        d.status === 'blocked' ? 'This question is itself waiting on other work.' : null,
        `Category: ${d.category ?? 'not recorded'}. Asked at ${hhmm(d.created?.at)}.`,
      ].filter(Boolean);
    case 'result': {
      const g = d.digest ?? {};
      const where = d.where ? d.where.split('/').slice(-2).join('/') : 'an unknown folder';
      const how = row.via === 'key' ? 'Press its number to answer the prompt the session is stuck at.' : 'Press its number to send that answer to the session.';
      return [
        row.headline,
        d.unsent
          ? `You already answered this. Your reply is typed into its prompt box and was never sent:\n\n    "${d.unsent}"\n\nIt is waiting behind whatever is on its screen.`
          : null,
        row.suggestion
          ? `Claude drafted a reply for you. You did not write it and nobody has sent it:\n\n    "${row.suggestion}"\n\nPress y to send it as it is, or r to write your own.`
          : null,
        row.explain ?? 'No summary was made of this one. The Screen tab has what it actually said.',
        g.explain && g.what_happened ? `What the session did: ${g.what_happened}` : null,
        row.options?.length
          ? ['What you can do:', ...row.options.map((o) => `  ${o.key}  ${o.label}${o.causes ? ` — ${o.causes}` : ''}${row.recommendKey === o.key ? '   ← recommended' : ''}`), how].join('\n')
          : null,
        g.why ? `Why that one: ${g.why}` : null,
        g.next_step ? `Next step: ${g.next_step}` : null,
        `This came from the session ${d.tab_label ?? d.session}, running in ${where}. It went ${d.state} at ${hhmm(d.at)}.`,
        row.live ? 'Enter shows its screen here; g goes to it.' : 'That session is no longer in Herdr, so it can only be read here.',
      ].filter(Boolean);
    }
    case 'answer':
      return [
        row.headline,
        `Answer: ${d.answer}, by ${whoAnswered(d.answered_by)} at ${hhmm(d.at)}${d.overruled ? ' (overruled)' : ''}. Recommended: ${d.recommend ?? 'not recorded'}.`,
        d.note ? `Note: ${d.note}` : null,
        d.why ? `Why it was asked: ${d.why}` : null,
        ...(d.answer === 'no' ? (d.blocks ?? []).map(afterDecline) : [d.blocks?.length ? `Released: ${listTitles(d.blocks).join('; ')}.` : null]),
        row.actions.includes('overrule') ? 'Answered without you. Press n to overrule.' : null,
      ].filter(Boolean);
    case 'decision':
      return [
        row.headline,
        `Decided by ${d.by === 'human' ? 'you' : 'an agent'} at ${hhmm(d.at)}, on: ${d.title ?? 'untitled work'}.`,
        row.plain ? `Detail: ${d.text}` : 'The agent did not record a plain summary. The Document tab has the full note.',
      ];
    case 'report':
      return [
        row.headline,
        `${d.title ?? 'untitled work'}: ${outcomeWords(d.outcome)} at ${hhmm(d.at)}${d.late ? ' (reported after the run was given up)' : ''}.`,
        d.headline ? null : 'The report has no plain headline.',
        `Summary: ${d.summary}`,
      ].filter(Boolean);
    case 'closed':
      return [row.headline, `Closed as ${d.as} at ${hhmm(d.at)}.`, d.note ? `Note: ${d.note}` : null].filter(Boolean);
    default:
      return [row.headline];
  }
}

// Key/value lines for the Context tab: the only place codes appear.
export function contextPairs(row, project = {}) {
  const d = row.data;
  const pairs = [['row', row.key]];
  const add = (k, v) => {
    if (v !== undefined && v !== null && v !== '') pairs.push([k, Array.isArray(v) ? v.join(', ') : String(v)]);
  };
  switch (row.kind) {
    case 'question':
    case 'answer':
      add('item', d.id);
      add('title', d.title);
      add('why', d.why);
      add('category', d.category);
      add('status', d.status);
      add('priority', d.priority);
      add('asked', d.created ? `${d.created.at} by ${d.created.by}` : null);
      add('answered', d.at ? `${d.at} by ${d.answered_by}` : null);
      add('blocks', d.blocks?.map((b) => [b.id, b.title, b.status && `(${[b.status, ...(b.open_runs ?? [])].join(' ')})`].filter(Boolean).join(' ')));
      add('unblocks prioritized', d.unblocks_prioritized);
      add('memo', d.memo);
      break;
    case 'result':
      add('session', d.session);
      add('state', d.state);
      add('captured', d.at);
      add('folder', d.where);
      add('tab', d.tab_label ? `${d.tab_label} (${d.tab})` : d.tab);
      add('pane', d.pane);
      add('workspace', d.workspace);
      add('terminal title', d.title);
      add('unsent reply', d.unsent);
      add('claude draft', row.suggestion);
      add('answered by', row.via === 'key' ? 'pressing the key in its dialog' : 'sending the words as a reply');
      add('stuck at', d.dialog?.question);
      add('its options', d.dialog?.options?.map((o) => `${o.key}. ${o.label}`));
      add('read by', d.digest?.source === 'parser' ? 'the parser, no model call' : d.digest ? 'a model' : 'nothing yet');
      add('queue id', d.id);
      break;
    case 'decision':
      add('on', `${d.id} ${d.title ?? ''}`.trim());
      add('note', `#${d.seq} at ${d.at} by ${d.by}`);
      add('text', d.text);
      break;
    case 'report':
      add('run', d.run);
      add('item', d.item);
      add('outcome', d.outcome);
      add('recorded', d.at);
      add('report', d.report_file);
      break;
    case 'closed':
      add('item', d.item);
      add('closed', `${d.as} at ${d.at} by ${d.by}`);
      break;
    default:
      break;
  }
  add('org', project.org);
  return pairs;
}
