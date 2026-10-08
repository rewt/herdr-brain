// Read projections for the live Projects trial. Session metadata is display-only.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { buildBoard } from '../lib/model.mjs';
import { findOrgDir } from '../../lib/store.mjs';
import { staleProject } from '../../lib/fleet.mjs';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const firstSentence = value => {
  const text = clean(value);
  const match = /^(.{20,}?[.!?])\s/.exec(text);
  return match ? match[1] : text;
};

// The small part of the retired items pane worth keeping: a factual chronology
// of item lifecycle moments. Raw events still come only through `record log`.
export function activityEntries(status, events = []) {
  const items = new Map((status?.items ?? []).map(item => [item.id, item]));
  const runs = new Map((status?.runs ?? []).map(run => [run.id, run]));
  const entry = event => {
    const item = items.get(event.id) ?? items.get(event.item);
    switch (event.type) {
      case 'item.added': {
        if (event.kind === 'goal') return null;
        const created = item?.created ?? {};
        const source = created.run ?? (event.by && event.by !== 'human' ? event.by : null);
        return { mark: /^HUM-/.test(event.id) ? '?' : '+', verb: /^HUM-/.test(event.id) ? 'asked' : 'created', id: event.id,
          title: event.title ?? item?.title ?? '', detail: [source ? `by ${source}` : null, event.parent ? `under ${event.parent}` : null].filter(Boolean).join(' · '), summary: created.why ?? null };
      }
      case 'run.started': {
        const meta = event.meta ?? {};
        return { mark: '▶', verb: 'started', id: event.item, title: item?.title ?? '', detail: [event.id, meta.agent, meta.harness, meta.model].filter(Boolean).join(' · ') };
      }
      case 'report.ingested': {
        const report = event.report ?? {};
        return { mark: report.outcome === 'done' ? '✓' : '!', verb: report.outcome === 'done' ? 'reported' : report.outcome ?? 'reported', id: event.item,
          title: item?.title ?? '', detail: [event.run, report.proposals?.length ? `${report.proposals.length} proposed` : null].filter(Boolean).join(' · '),
          summary: report.headline ?? firstSentence(report.summary) };
      }
      case 'item.closed':
        if (item?.kind === 'goal') return null;
        return { mark: event.as === 'dropped' ? '×' : '■', verb: event.as === 'dropped' ? 'dropped' : /^HUM-/.test(event.id) ? 'answered' : 'closed', id: event.id,
          title: item?.title ?? '', summary: event.note ?? null };
      case 'note.added':
        return event.decision && event.kind !== 'answer' ? { mark: '◆', verb: 'decided', id: event.id, title: item?.title ?? '', summary: event.text } : null;
      case 'run.abandoned': {
        const run = runs.get(event.id);
        return { mark: '×', verb: 'abandoned', id: run?.item, title: items.get(run?.item)?.title ?? '', detail: event.id };
      }
      default:
        return null;
    }
  };
  return events.slice().sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0)).map(event => {
    const value = entry(event);
    return value?.id ? { ...value, at: event.at, seq: event.seq } : null;
  }).filter(Boolean);
}

export function itemOrigin(item) {
  const created = item?.created;
  if (!created) return null;
  const source = created.run ? `proposed by ${created.run}` : created.by && created.by !== 'human' ? `created by ${created.by}` : 'created by the operator';
  return { source, at: created.at ?? null, why: created.why ?? null, unattributed: Boolean(created.unattributed) };
}

export function canonical(file) {
  if (!file) return null;
  try { return fs.realpathSync(file); } catch { return path.resolve(file); }
}

export function createIdentityReader() {
  const cache = new Map();
  return function identity(folder) {
    if (!folder) return null;
    const cwd = canonical(folder);
    if (cache.has(cwd)) return cache.get(cwd);
    try { if (!fs.statSync(cwd).isDirectory()) return null; } catch { return null; }
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 2000 });
    const key = r.status === 0 ? canonical(r.stdout.trim()) : cwd;
    const root = r.status === 0 && path.basename(key) === '.git' ? path.dirname(key) : cwd;
    const value = { key, root, cwd, git: r.status === 0, name: path.basename(root) || root };
    // A timeout or spawn failure is not an answer; ask again next time.
    if (!r.error && r.status !== null) cache.set(cwd, value);
    return value;
  };
}

export function workspaceIdentity(w, identity) {
  const wt = w.worktree;
  return wt?.repo_key ? { key: canonical(wt.repo_key), root: wt.repo_root, cwd: wt.checkout_path, git: true, name: wt.repo_name }
    : identity(w.cwd ?? w.path);
}

export function catalog(configured, workspaces, identity, opened = [], agents = []) {
  const result = [...configured, ...opened].map((p) => {
    if (p.identity && staleProject(p)) return { ...p, stale: true, org: null, repoKey: p.identity, root: p.cwd, git: false, configured: false };
    const repo = identity(p.cwd);
    const org = p.org ?? (p.cwd ? findOrgDir({ cwd: p.cwd, env: {} }) : null);
    return { ...p, org, id: p.id ?? `configured:${p.name}`, repoKey: repo?.key, root: repo?.root ?? p.cwd, git: Boolean(repo?.git), configured: Boolean(org) };
  });
  const known = new Set(result.map(p => p.repoKey).filter(Boolean));
  const discover = repo => {
    if (!repo?.key || known.has(repo.key)) return;
    known.add(repo.key);
    const org = findOrgDir({ cwd: repo.root, env: {} });
    result.push({ id: `discovered:${repo.key}`, name: repo.name ?? path.basename(repo.root), cwd: repo.root, root: repo.root, repoKey: repo.key, git: repo.git, org, configured: Boolean(org) });
  };
  for (const w of workspaces) discover(workspaceIdentity(w, identity));
  // An agent is assigned by its own cwd, so a checkout known only from an
  // agent (another repo, or a folder without Git) still needs a project.
  for (const a of agents) if (a.cwd) discover(identity(a.cwd));
  return result;
}

// The newest moment the organization recorded: any `at` on its items and runs
// (created, closed, notes, starts, reports). Status carries no last-event time.
export function lastRecorded(status) {
  let last = null;
  const walk = v => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'at' && typeof x === 'string') { if (!last || x > last) last = x; }
      else if (x && typeof x === 'object') walk(x);
    }
  };
  walk(status?.items); walk(status?.runs);
  return last;
}

export function projectView(project, data, identity, now = Date.now()) {
  const empty = { lastAt: null, sessions: [], goals: [], tasks: [], activity: [], decided: [], asked: [], candidates: [], desks: data.desks ?? null, housekeeping: data.housekeeping ?? null, routes: data.routes ?? null, needs: [], categoryFlags: [], aged: [], later: [], parked: [], resolved: [], reports: [], ended: [], allNeeds: [], elsewhere: [], spaces: [], tabs: [], items: [], itemsById: new Map() };
  if (!project) return empty;
  const spaces = data.workspaces.filter(w => workspaceIdentity(w, identity)?.key === project.repoKey && project.repoKey);
  const spacesById = new Map(spaces.map(w => [w.workspace_id, w]));
  // Current cwd wins over a workspace label. Repo names and branch prefixes are
  // never used to assign sessions or decide whether a checkout is a worktree.
  const agents = data.agents.filter(a => a.cwd ? identity(a.cwd)?.key === project.repoKey && project.repoKey : spacesById.has(a.workspace));
  const repoOf = cwd => { const r = identity(cwd); return r ? { root: r.key, name: r.name, path: r.root, git: r.git } : null; };
  const sameRun = r => !r.workspace || identity(r.workspace)?.key === project.repoKey;
  const today = data.today ? { ...data.today, running: (data.today.running ?? []).filter(sameRun), agent_runs: (data.today.agent_runs ?? []).filter(sameRun) } : null;
  // Brain results are assigned below by checkout, not by the board's label filter.
  const board = buildBoard({ today, brain: data.brain, herdr: { ok: true, agents }, tabs: data.tabs.map(t => ({ tab: t.tab_id, label: t.label, workspace: t.workspace_id })), repoOf, projectName: null, fallbackCwd: project.cwd });
  const items = data.status?.items ?? [];
  const itemsById = new Map(items.map(i => [i.id, i]));
  const goalOf = item => { const visited = new Set(); for (let i = item; i && !visited.has(i.id); i = itemsById.get(i.parent)) { if (i.kind === 'goal') return i.id; visited.add(i.id); } return null; };
  // A pane's label is the operator's own name for a session (display only).
  const labels = new Map((data.panes ?? []).filter(x => x.label).map(x => [x.pane_id, x.label]));
  const sessions = board.groups.flatMap(g => g.rows).filter(row => row.live).map(row => ({ ...row, pane: row.live?.pane, tab: row.live?.tab, space: row.live?.workspace, label: labels.get(row.live?.pane) ?? null,
    since: data.since?.get(row.live?.pane)?.at ?? null,
    task: itemsById.has(row.run?.item) ? row.run.item : null, goal: goalOf(itemsById.get(row.run?.item)),
    recorded: Boolean(row.run && !(today?.running ?? []).some(r => r.run === row.run.run)),
  }));
  // A pane can cd into this project while its workspace belongs to another repo.
  // Keep its actual checkout available, without reparenting that workspace.
  const tabIds = new Set(sessions.map(s => s.tab));
  const tabs = data.tabs.filter(t => spacesById.has(t.workspace_id) || tabIds.has(t.tab_id));
  // The reverse: an agent in one of this project's tabs that works in another
  // checkout belongs to that project, but the tab must not claim to be a shell.
  const shown = new Set(sessions.map(s => s.pane)), ownTabs = new Set(tabs.map(t => t.tab_id));
  const elsewhere = data.agents.filter(a => ownTabs.has(a.tab) && !shown.has(a.pane)).map(a => ({ pane: a.pane, tab: a.tab, name: a.name, cwd: a.cwd, status: a.status, repo: identity(a.cwd) }));
  // Org questions come from this project's own organization. A Brain result
  // belongs where its session ran; a label match is only a fallback for results
  // that recorded no checkout, and an unmatched result belongs to no project.
  const ownResult = r => {
    const where = r.data?.where;
    if (where) return identity(where)?.key === project.repoKey;
    const label = r.data?.project;
    return Boolean(project.configured && label && label !== 'other' && label === project.name);
  };
  const waiting = settle(board.waiting.filter(i => i.kind !== 'fold' && (i.kind !== 'result' || ownResult(i))), itemsById,
    { live: new Set(data.agents.map(a => a.pane)), now });
  return { ...empty, ...controlEntries(data.status), priorities: data.status?.priorities ?? { revision: 0, priorities: [], unaligned: { work: [], runs: [] } }, items, itemsById, board, sessions, spaces, tabs, lastAt: lastRecorded(data.status), activity: activityEntries(data.status, data.events),
    candidates: (data.status?.candidates ?? []).filter(c => c.identity === project.repoKey),
    categoryFlags: (data.status?.attention ?? today?.attention ?? []).filter(a => a.kind === 'category'),
    goals: items.filter(i => i.kind === 'goal' && !i.closed),
    tasks: items.filter(i => i.kind !== 'goal' && i.role !== 'human' && !['done', 'dropped'].includes(i.status)).map(i => ({ ...i, goal: goalOf(i) })),
    needs: waiting.filter(i => !i.foldedIn),
    aged: waiting.filter(i => i.foldedIn === 'aged'),
    later: waiting.filter(i => i.foldedIn === 'later'), parked: waiting.filter(i => i.foldedIn === 'stages'),
    resolved: waiting.filter(i => i.foldedIn === 'resolved'), reports: waiting.filter(i => i.foldedIn === 'reports'),
    ended: waiting.filter(i => i.foldedIn === 'ended'), allNeeds: waiting,
    elsewhere,
  };
}

// Questions and decisions are structured record facts, never inferred from
// narrative or session metadata. All history survives the daily Activity cutoff.
export function controlEntries(status) {
  const items = status?.items ?? [], runs = status?.runs ?? [];
  const asked = items.filter(i => i.role === 'human' && i.kind !== 'goal').map(i => ({ ...i, source: i.id,
    why: i.notes?.find(n => n.kind === 'why')?.text ?? i.created?.why,
    answerState: i.meta?.answer != null && i.closed ? `${i.meta.answer} · ${i.meta.answered_by ?? 'unknown'}` : i.closed ? 'dropped' : 'Waiting on you',
  })).sort((a, b) => (b.created?.seq ?? 0) - (a.created?.seq ?? 0));
  const decided = [...items, ...runs].flatMap(i => (i.notes ?? []).filter(n => n.decision).map(n => ({
    key: `${i.id}:${n.seq}`, item: i.item ?? i.id, source: i.id, at: n.at, by: n.by ?? 'unknown', seq: n.seq,
    ...(n.kind === 'answer' ? { heading: i.title } : {}),
    text: n.kind === 'answer' ? `${i.title} → ${n.summary ?? n.text}` : n.summary ?? n.text, detail: n.text,
  })));
  const fields = value => Array.isArray(value) ? value : value == null ? [] : [value];
  const textOf = value => typeof value === 'string' ? value : value?.text ?? value?.decision ?? value?.question;
  for (const run of runs) {
    const report = run.report;
    if (!report) continue;
    const by = run.meta?.agent ?? `run:${run.id}`;
    for (const [index, decision] of fields(report.decisions ?? report.extra?.decisions).entries()) {
      const text = textOf(decision);
      if (typeof text !== 'string' || !text.trim()) continue;
      decided.push({ key: `${run.id}:report:${index}`, item: run.item, source: run.id, by, at: report.at, seq: report.seq,
        text, detail: [text, decision?.category ? `Category: ${decision.category}` : null, decision?.why].filter(Boolean).join('\n\n') });
    }
    for (const [index, question] of fields(report.questions ?? report.extra?.questions).entries()) {
      const title = textOf(question);
      if (typeof title !== 'string' || !title.trim() || asked.some(q => q.id === question?.id)) continue;
      // A report entry without an actual record question is evidence, not a
      // synthetic waiting item or something record answer can accept.
      asked.push({ id: `${run.id}:question:${index}`, source: run.id, item: run.item, title, why: question?.why,
        created: { by, at: report.at, seq: report.seq }, meta: { category: question?.category, recommend: question?.recommend },
        answerState: 'In report · no record question', reportQuestion: true });
    }
  }
  // record answer writes note, metadata, close as one batch. Only that
  // corresponding note replaces the current summary; older notes stay visible.
  for (const q of asked.filter(q => q.closed && q.meta?.answer != null &&
    !q.notes?.some(n => n.decision && n.kind === 'answer' && n.seq === q.closed.seq - 2))) decided.push({
    key: `${q.id}:${q.closed.seq}`, item: q.id, source: q.id, at: q.closed.at, by: q.meta.answered_by ?? 'unknown', seq: q.closed.seq,
    text: `${q.title} → ${q.meta.answer}`, detail: q.notes?.filter(n => n.kind === 'answer').at(-1)?.text ?? q.why,
  });
  decided.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
  asked.sort((a, b) => (b.created?.seq ?? 0) - (a.created?.seq ?? 0));
  return { asked, decided };
}

const closedItem = item => Boolean(item && (item.closed || ['done', 'dropped'].includes(item.status)));

// A session's result stays in Needs you only while it still asks something
// open. One whose org item has closed, or an older one about the same item, is
// resolved; one that reports without asking is a report. A question with no
// org record whose session ended over a day ago is unowned: nobody will act on
// it unless the operator raises it. All remain readable, folded out of the
// queue. Org questions are the org's own and never fold here.
export const ENDED_AFTER_MS = 24 * 60 * 60 * 1000;
export function settle(waiting, itemsById, { live = new Set(), now = Date.now() } = {}) {
  const newest = new Map();
  for (const r of waiting) {
    const item = r.kind === 'result' && r.data?.digest?.item;
    if (item && !(newest.get(item)?.data?.at > r.data?.at)) newest.set(item, r);
  }
  return waiting.map(r => {
    // A reply that never left its prompt box is the operator's own words; it stays.
    if (r.kind !== 'result' || r.foldedIn || r.category === 'stranded') return r;
    const id = r.data?.digest?.item, item = itemsById.get(id);
    if (closedItem(item)) return { ...r, foldedIn: 'resolved', settled: `${item.id} is ${item.status === 'dropped' ? 'dropped' : 'closed'} in the record.` };
    if (id && newest.get(id) !== r) return { ...r, foldedIn: 'resolved', settled: `A newer session result about ${id} replaces this one.` };
    if (['report', 'finished'].includes(r.category) || r.data?.digest?.needs_you === false) return { ...r, foldedIn: 'reports', settled: 'This session reported without asking for a decision.' };
    if (!id && !live.has(r.data?.pane) && now - Date.parse(r.data?.at) > ENDED_AFTER_MS) return { ...r, foldedIn: 'ended', settled: 'Its session has ended and no record item holds this question. Raise it in the record if it still matters.' };
    return r;
  });
}

export function folderPath(input) {
  const value = String(input ?? '').trim();
  if (!value) throw new Error('Enter a folder path.');
  const cwd = canonical(path.resolve(value.replace(/^~(?=$|\/)/, os.homedir())));
  if (!fs.statSync(cwd).isDirectory()) throw new Error('Choose a directory.');
  return cwd;
}

export function acceptanceCriteria(item) {
  return (Array.isArray(item.accept) ? item.accept : [item.accept]).filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
}

export function relatedWork(model, itemId) {
  const within = id => {
    const visited = new Set();
    for (let item = model.itemsById.get(id); item && !visited.has(item.id); item = model.itemsById.get(item.parent)) {
      if (item.id === itemId) return true;
      visited.add(item.id);
    }
    return false;
  };
  const linked = model.sessions.filter(a => a.task && within(a.task));
  return { tasks: model.tasks.filter(t => t.id !== itemId && within(t.id)), current: linked.filter(a => !a.recorded), historical: linked.filter(a => a.recorded), unlinked: model.sessions.filter(a => !a.task).length };
}
