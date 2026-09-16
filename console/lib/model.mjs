// Rows from the read model (org today --json), Herdr's agent list and session notes.
// Pure: deterministic given its inputs. Rows carry no codes in their visible text;
// codes live in `context`, which only the Context tab shows.
import { EXECUTIVE_RE, firstMarkdownPath } from './sources.mjs';
import { firstLine, firstSentence, hasCodes, oneLine, stripCodes } from './text.mjs';

export const SECTIONS = [
  { key: 'waiting', title: 'WAITING ON YOU' },
  { key: 'decided', title: 'DECIDED TODAY' },
  { key: 'running', title: 'RUNNING' },
  { key: 'finished', title: 'FINISHED TODAY' },
  { key: 'sessions', title: 'SESSION NOTES' },
];

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

const SESSION_WORDS = { settle: 'Settling a finished task', exec: 'Executive session', plan: 'Planning session', audit: 'Audit session' };

export function hhmm(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Visible text never shows record codes. Text that has them is shown without them, marked.
export function plain(text) {
  const t = oneLine(text);
  return hasCodes(t) ? `${stripCodes(t) || 'text with only codes'} ${NO_PLAIN}` : t;
}

// The plain line for a decision note: its summary, or its first sentence without codes, marked.
export function decisionHeadline(note) {
  if (note.summary && oneLine(note.summary)) return { text: oneLine(note.summary), plain: true };
  const stripped = stripCodes(firstSentence(note.text));
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

function sessionKind(name) {
  return EXECUTIVE_RE.exec(name ?? '')?.[1] ?? null;
}

// Time from a session name's HHMM suffix ("exec-1610").
function nameTime(name) {
  const m = /-(\d{2})(\d{2})$/.exec(name ?? '');
  return m ? `${m[1]}:${m[2]}` : '--:--';
}

export function buildRows({ today, herdr = null, sessions = null }) {
  const agentsByName = new Map((herdr?.agents ?? []).filter((a) => a.name).map((a) => [a.name, a]));
  const herdrOk = Boolean(herdr?.ok);
  const liveState = (name) => {
    if (!name) return 'agent not recorded';
    if (!herdrOk) return 'unknown';
    return agentsByName.get(name)?.status ?? 'agent gone';
  };
  const sections = Object.fromEntries(SECTIONS.map((s) => [s.key, []]));

  for (const q of today?.waiting ?? []) {
    sections.waiting.push({
      key: `q:${q.id}`,
      kind: 'question',
      headline: plain(q.title),
      tag: q.category ?? 'no category',
      time: hhmm(q.created?.at),
      state: q.recommend ? `recommend: ${plain(q.recommend)}` : 'no recommendation',
      question: q.id,
      actions: ['approve', 'decline'],
      doc: q.memo ? { path: q.memo } : { missing: 'no memo recorded' },
      agent: null,
      data: q,
    });
  }

  for (const d of today?.decided ?? []) {
    if (d.kind === 'question') {
      sections.decided.push({
        key: `a:${d.id}`,
        kind: 'answer',
        headline: plain(d.title),
        tag: d.category ?? 'no category',
        time: hhmm(d.at),
        state: `${answerWords(d.answer)} · ${whoAnswered(d.answered_by)}${d.overruled ? ' · overruled' : ''}`,
        question: d.id,
        actions: d.answered_by === 'human' ? [] : ['overrule'],
        doc: d.memo ? { path: d.memo } : { missing: 'no memo recorded' },
        agent: null,
        data: d,
      });
    } else {
      const h = decisionHeadline(d);
      const doc = firstMarkdownPath(d.text);
      sections.decided.push({
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
        data: d,
      });
    }
  }

  const runAgents = new Set();
  for (const r of today?.running ?? []) {
    if (r.agent) runAgents.add(r.agent);
    sections.running.push({
      key: `r:${r.run}`,
      kind: 'run',
      headline: plain(r.title ?? 'untitled work'),
      tag: roleWords(r.role),
      time: hhmm(r.started),
      state: `since ${hhmm(r.started)} · ${liveState(r.agent)}`,
      question: null,
      actions: r.agent ? ['focus'] : [],
      doc: r.brief_path ? { path: r.brief_path } : { missing: 'no brief recorded' },
      agent: r.agent,
      data: r,
    });
  }
  const ledgerByName = new Map((sessions?.sessions ?? []).map((s) => [s.name, s]));
  for (const a of herdr?.agents ?? []) {
    const kind = sessionKind(a.name);
    if (!kind || runAgents.has(a.name)) continue;
    const entry = ledgerByName.get(a.name);
    const time = entry ? entry.time.slice(0, 5) : nameTime(a.name);
    sections.running.push({
      key: `x:${a.name}`,
      kind: 'executive',
      headline: SESSION_WORDS[kind],
      tag: 'executive',
      time,
      state: `since ${time} · ${a.status}`,
      question: null,
      actions: ['focus'],
      doc: entry?.note ? { text: entry.note } : { missing: 'no final message yet' },
      agent: a.name,
      data: { ...a, ledger: entry ?? null },
    });
  }

  for (const f of today?.finished ?? []) {
    if (f.kind === 'report') {
      sections.finished.push({
        key: `f:${f.run}`,
        kind: 'report',
        headline: f.headline ? plain(f.headline) : `${plain(f.title ?? 'untitled work')}: ${outcomeWords(f.outcome)}`,
        tag: roleWords(f.role),
        time: hhmm(f.at),
        state: outcomeWords(f.outcome),
        question: null,
        actions: [],
        doc: { path: f.report_file },
        agent: null,
        data: f,
      });
    } else {
      sections.finished.push({
        key: `c:${f.item}:${f.seq}`,
        kind: 'closed',
        headline: `${plain(f.title)}: ${f.as === 'dropped' ? 'dropped' : 'closed'}`,
        tag: roleWords(f.role),
        time: hhmm(f.at),
        state: f.as === 'dropped' ? 'dropped' : 'closed',
        question: null,
        actions: [],
        doc: f.note ? { text: f.note } : { missing: 'no closing note recorded' },
        agent: null,
        data: f,
      });
    }
  }

  for (const s of [...(sessions?.sessions ?? [])].reverse()) {
    const line = s.note ? plain(firstLine(s.note)) : '';
    sections.sessions.push({
      key: `s:${s.name}`,
      kind: 'session',
      headline: line || (s.transcript ? 'no final message yet' : 'transcript not found'),
      tag: s.mode ?? 'session',
      time: s.time.slice(0, 5),
      state: agentsByName.has(s.name) ? agentsByName.get(s.name).status : herdrOk ? 'closed' : 'unknown',
      question: null,
      actions: agentsByName.has(s.name) ? ['focus'] : [],
      doc: s.note ? { text: s.note } : { missing: s.transcript ? 'the session has no final message yet' : `no transcript names ${s.name}` },
      agent: s.name,
      data: s,
    });
  }

  return SECTIONS.map((s) => ({ ...s, rows: sections[s.key] }));
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

export function orderSections(sections, previous) {
  return sections.map((s) => ({ ...s, rows: stableOrder(previous?.[s.key], s.rows) }));
}

export function orderKeys(sections) {
  return Object.fromEntries(sections.map((s) => [s.key, s.rows.map((r) => r.key)]));
}

export function flatRows(sections) {
  return sections.flatMap((s) => s.rows);
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

// Paragraphs for the Summary tab, without codes.
export function summaryParagraphs(row) {
  return rawParagraphs(row).map((p) => (p === row.headline ? p : plain(p)));
}

function rawParagraphs(row) {
  const d = row.data;
  switch (row.kind) {
    case 'question':
      return [
        row.headline,
        `Recommend: ${d.recommend ?? 'not recorded'}. ${d.why ?? 'No reason recorded.'}`,
        `On yes: ${d.on_yes ?? 'not recorded'}`,
        `On no: ${d.on_no ?? 'not recorded'}`,
        d.blocks?.length ? `Unblocks: ${listTitles(d.blocks).join('; ')}.` : 'Unblocks: nothing recorded.',
        d.status === 'blocked' ? 'This question is itself waiting on other work.' : null,
        `Category: ${d.category ?? 'not recorded'}. Asked at ${hhmm(d.created?.at)}.`,
      ].filter(Boolean);
    case 'answer':
      return [
        row.headline,
        `Answer: ${d.answer}, by ${whoAnswered(d.answered_by)} at ${hhmm(d.at)}${d.overruled ? ' (overruled)' : ''}. Recommended: ${d.recommend ?? 'not recorded'}.`,
        d.note ? `Note: ${d.note}` : null,
        d.why ? `Why it was asked: ${d.why}` : null,
        d.blocks?.length ? `${d.answer === 'no' ? 'Still blocked' : 'Released'}: ${listTitles(d.blocks).join('; ')}.` : null,
        row.actions.includes('overrule') ? 'Answered without you. Press n to overrule.' : null,
      ].filter(Boolean);
    case 'decision':
      return [
        row.headline,
        `Decided by ${d.by === 'human' ? 'you' : 'an agent'} at ${hhmm(d.at)}, on: ${d.title ?? 'untitled work'}.`,
        row.plain ? `Detail: ${d.text}` : 'The agent did not record a plain summary. The Document tab has the full note.',
      ];
    case 'run':
      return [
        row.headline,
        `${row.tag[0].toUpperCase()}${row.tag.slice(1)} work, started at ${hhmm(d.started)}. Agent: ${row.state.split(' · ')[1]}.`,
        'The Document tab shows the brief the agent was given.',
      ];
    case 'executive':
      return [
        row.headline,
        `Started at ${row.time}; now ${d.status}.`,
        d.ledger?.note ? `Latest message: ${firstLine(d.ledger.note)}` : 'No final message yet.',
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
    case 'session':
      return [
        row.headline,
        `A ${d.mode} session started at ${row.time}${d.note_at ? `; its last message came at ${hhmm(d.note_at)}` : ''}.`,
        'The Document tab has its full final message.',
      ];
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
      add('category', d.category);
      add('status', d.status);
      add('priority', d.priority);
      add('asked', d.created ? `${d.created.at} by ${d.created.by}` : null);
      add('answered', d.at ? `${d.at} by ${d.answered_by}` : null);
      add('blocks', d.blocks?.map((b) => `${b.id} ${b.title ?? ''}`.trim()));
      add('unblocks prioritized', d.unblocks_prioritized);
      add('memo', d.memo);
      break;
    case 'decision':
      add('on', `${d.id} ${d.title ?? ''}`.trim());
      add('note', `#${d.seq} at ${d.at} by ${d.by}`);
      add('text', d.text);
      break;
    case 'run':
      add('run', d.run);
      add('item', d.item);
      add('agent', d.agent);
      add('lane', d.lane);
      add('started', d.started);
      add('brief', d.brief_path);
      add('report path', d.report_path);
      break;
    case 'executive':
      add('agent', d.name);
      add('status', d.status);
      add('tab', d.tab);
      add('pane', d.pane);
      add('ledger', d.ledger ? `${d.ledger.time} ${d.ledger.mode} ${d.ledger.subject ?? ''}`.trim() : 'not in today\'s ledger');
      add('transcript', d.ledger?.transcript);
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
    case 'session':
      add('agent', d.name);
      add('mode', d.mode);
      add('subject', d.subject);
      add('started', d.time);
      add('transcript', d.transcript ?? 'not found');
      add('last message', d.note_at);
      break;
    default:
      break;
  }
  add('org', project.org);
  return pairs;
}
