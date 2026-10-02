// Current state is a pure fold over the event log. Status is derived, never stored.
import { categoryFlagText } from './discernment.mjs';
export const BUDGET_KEYS = ['max_runs', 'max_children', 'max_depth', 'escalation_budget'];

export function fold(events) {
  const s = { items: new Map(), runs: new Map(), links: [], categoryFlags: [], eventCount: events.length, lastAt: null };
  for (const e of events) apply(s, e);
  return s;
}

function apply(s, e) {
  s.lastAt = e.at;
  const item = s.items.get(e.id ?? e.item);
  switch (e.type) {
    case 'category.flagged':
      s.categoryFlags.push({ id: e.id, run: e.run ?? null, source: e.source, category: e.category, signals: e.signals,
        at: e.at, by: e.by, seq: e.seq });
      break;
    case 'item.added':
      s.items.set(e.id, {
        id: e.id,
        kind: e.kind ?? 'work',
        title: e.title,
        role: e.role ?? null,
        capability: e.capability ?? null,
        parent: e.parent ?? null,
        priority: e.priority ?? null,
        accept: e.accept ?? [],
        budget: e.budget ?? {},
        meta: e.meta ?? {},
        created: { seq: e.seq, at: e.at, by: e.by, run: e.from_run ?? null, why: e.why ?? null, ...(e.unattributed ? { unattributed: true } : {}) },
        closed: null,
        outcome: null,
        runs: [],
        notes: [],
      });
      break;
    case 'item.updated':
      if (!item) break;
      for (const [key, value] of Object.entries(e.fields ?? {})) {
        if (key === 'budget' || key === 'meta') item[key] = { ...item[key], ...value };
        else item[key] = value;
      }
      break;
    case 'item.closed':
      if (item) item.closed = { as: e.as, at: e.at, by: e.by, note: e.note ?? null, seq: e.seq };
      break;
    case 'item.reopened':
      if (item) {
        item.closed = null;
        item.outcome = null;
      }
      break;
    case 'link.added':
      if (!s.links.some((l) => l.blocker === e.blocker && l.blocked === e.blocked)) {
        s.links.push({ blocker: e.blocker, blocked: e.blocked, seq: e.seq, at: e.at, by: e.by });
      }
      break;
    case 'link.removed':
      s.links = s.links.filter((l) => !(l.blocker === e.blocker && l.blocked === e.blocked));
      break;
    case 'note.added': {
      const target = s.items.get(e.id) ?? s.runs.get(e.id);
      if (target) {
        target.notes.push({
          text: e.text, decision: Boolean(e.decision), at: e.at, by: e.by, seq: e.seq,
          ...(e.summary ? { summary: e.summary } : {}),
          ...(e.kind ? { kind: e.kind } : {}),
        });
      }
      break;
    }
    case 'run.started':
      s.runs.set(e.id, {
        id: e.id,
        item: e.item,
        meta: e.meta ?? {},
        workspace: e.workspace ?? null,
        report_path: e.report_path,
        brief_path: e.brief_path,
        started: { at: e.at, by: e.by, seq: e.seq },
        abandoned: null,
        report: null,
        notes: [],
      });
      s.items.get(e.item)?.runs.push(e.id);
      break;
    case 'run.updated': {
      const run = s.runs.get(e.id);
      if (run) run.meta = { ...run.meta, ...(e.meta ?? {}) };
      break;
    }
    case 'run.abandoned': {
      const run = s.runs.get(e.id);
      if (run) run.abandoned = { at: e.at, by: e.by, note: e.note ?? null, seq: e.seq };
      break;
    }
    case 'report.ingested': {
      const run = s.runs.get(e.run);
      if (!run) break;
      run.report = { ...e.report, at: e.at, seq: e.seq, sha256: e.sha256, file: e.file, late: Boolean(e.late) };
      const target = s.items.get(run.item);
      if (target) target.outcome = { value: e.report.outcome, run: e.run, at: e.at, seq: e.seq };
      break;
    }
    default:
      // Unknown event types from newer versions are ignored, not fatal.
      break;
  }
}

const ROLE_PREFIX = {
  engineer: 'ENG', engineering: 'ENG', architect: 'ARCH', architecture: 'ARCH',
  researcher: 'RES', research: 'RES', reviewer: 'REV', review: 'REV',
  planner: 'PLAN', triage: 'TRI', human: 'HUM', writer: 'DOC', designer: 'DES',
};

export function prefixFor(kind, role) {
  if (kind === 'goal') return 'G';
  if (!role) return 'W';
  const key = role.toLowerCase();
  return ROLE_PREFIX[key] ?? (key.replace(/[^a-z0-9]/g, '').slice(0, 4).toUpperCase() || 'W');
}

function maxNumber(ids, prefix) {
  let max = 0;
  for (const id of ids) {
    const m = /^(.+)-(\d+)$/.exec(id);
    if (m && m[1] === prefix) max = Math.max(max, Number(m[2]));
  }
  return max;
}

export function nextItemId(s, { kind, role }, taken = new Set()) {
  const prefix = prefixFor(kind, role);
  return `${prefix}-${maxNumber([...s.items.keys(), ...taken], prefix) + 1}`;
}

export function nextRunId(s) {
  return `R-${maxNumber(s.runs.keys(), 'R') + 1}`;
}

export function compareIds(a, b) {
  const [, pa = a, na = '0'] = /^(.+)-(\d+)$/.exec(a) ?? [];
  const [, pb = b, nb = '0'] = /^(.+)-(\d+)$/.exec(b) ?? [];
  return pa === pb ? Number(na) - Number(nb) : pa < pb ? -1 : 1;
}

export function sortItems(items) {
  return [...items].sort((a, b) => {
    const pa = typeof a.priority === 'number' ? a.priority : -Infinity;
    const pb = typeof b.priority === 'number' ? b.priority : -Infinity;
    return pa !== pb ? pb - pa : compareIds(a.id, b.id);
  });
}

export function children(s, id) {
  return sortItems([...s.items.values()].filter((i) => i.parent === id));
}

export function descendants(s, id, seen = new Set([id])) {
  const out = [];
  for (const child of children(s, id)) {
    if (seen.has(child.id)) continue;
    seen.add(child.id);
    out.push(child, ...descendants(s, child.id, seen));
  }
  return out;
}

// Nearest first.
export function ancestors(s, id) {
  const out = [];
  const seen = new Set([id]);
  let current = s.items.get(id)?.parent;
  while (current && !seen.has(current) && s.items.has(current)) {
    seen.add(current);
    out.push(s.items.get(current));
    current = s.items.get(current).parent;
  }
  return out;
}

export function blockersOf(s, id) {
  return s.links.filter((l) => l.blocked === id).map((l) => l.blocker);
}

export function blockedBy(s, id) {
  return s.links.filter((l) => l.blocker === id).map((l) => l.blocked);
}

export function openRuns(s, id) {
  return (s.items.get(id)?.runs ?? []).map((r) => s.runs.get(r)).filter((r) => r && !r.report && !r.abandoned);
}

export function isResolved(status) {
  return status === 'done' || status === 'dropped';
}

// A question answered "no" is closed, but the work it blocked must not proceed:
// it stays blocked until someone re-plans it and removes the link.
export function isDeclined(item) {
  return Boolean(item?.closed) && item.meta?.answer === 'no';
}

export function releases(s, id, status) {
  return isResolved(status) && !isDeclined(s.items.get(id));
}

export function itemStatus(s, id, visiting = new Set()) {
  const item = s.items.get(id);
  if (!item) return 'unknown';
  if (item.closed) return item.closed.as;
  if (openRuns(s, id).length) return 'active';
  if (item.kind === 'goal') return 'open';
  if (visiting.has(id)) return 'blocked';
  visiting.add(id);
  const blockers = blockersOf(s, id);
  const unresolved = blockers.filter((b) => !releases(s, b, itemStatus(s, b, visiting)));
  visiting.delete(id);
  if (unresolved.length) return 'blocked';
  switch (item.outcome?.value) {
    case 'done':
      return 'done';
    case 'needs_human':
      return 'needs_human';
    case 'blocked':
      // Blocked on linked items that are now resolved means ready to continue;
      // blocked with nothing linked is still waiting on whatever the report said.
      return blockers.length ? 'ready' : 'blocked';
    default:
      return 'ready';
  }
}

export function statusMap(s) {
  const map = new Map();
  for (const id of s.items.keys()) map.set(id, itemStatus(s, id));
  return map;
}

export function rollup(s, id, statuses = statusMap(s)) {
  const counts = {};
  for (const d of descendants(s, id)) {
    if (d.kind === 'goal') continue;
    const st = statuses.get(d.id);
    counts[st] = (counts[st] ?? 0) + 1;
  }
  return counts;
}

export function wouldCycleBlock(s, blocker, blocked) {
  if (blocker === blocked) return true;
  // Does "blocked" already (transitively) block "blocker"?
  const stack = [blocked];
  const seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (current === blocker) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...blockedBy(s, current));
  }
  return false;
}

export function wouldCycleParent(s, id, parent) {
  if (!parent) return false;
  if (parent === id) return true;
  return ancestors(s, parent).some((a) => a.id === id);
}

export function effectiveBudget(s, id, config) {
  const budget = { ...config.budget };
  for (const ancestor of ancestors(s, id).reverse()) Object.assign(budget, ancestor.budget);
  Object.assign(budget, s.items.get(id)?.budget ?? {});
  return budget;
}

// Advisory signals: things worth a human glance. Nothing here refuses work.
export function attention(s, config, now, statuses = statusMap(s)) {
  // Auto-closed questions and completed reports still deserve operator review.
  const out = (s.categoryFlags ?? []).map(flag => ({ ...flag, kind: 'category', text: categoryFlagText(flag) }));
  for (const item of sortItems(s.items.values())) {
    if (isResolved(statuses.get(item.id))) continue;
    const b = effectiveBudget(s, item.id, config);
    const runs = item.runs.length;
    const kids = children(s, item.id).length;
    const depth = ancestors(s, item.id).length;
    const escalations = item.runs.filter((r) => truthy(s.runs.get(r)?.meta.escalation)).length;
    if (typeof b.max_runs === 'number' && runs > b.max_runs) out.push({ id: item.id, kind: 'budget', text: `${runs} runs (expected ≤ ${b.max_runs})` });
    if (typeof b.max_children === 'number' && kids > b.max_children) out.push({ id: item.id, kind: 'budget', text: `${kids} child items (expected ≤ ${b.max_children})` });
    if (typeof b.max_depth === 'number' && depth > b.max_depth) out.push({ id: item.id, kind: 'budget', text: `depth ${depth} (expected ≤ ${b.max_depth})` });
    if (typeof b.escalation_budget === 'number' && escalations > b.escalation_budget) out.push({ id: item.id, kind: 'budget', text: `${escalations} escalated runs (expected ≤ ${b.escalation_budget})` });
    const open = openRuns(s, item.id);
    if (open.length > 1) out.push({ id: item.id, kind: 'parallel', text: `${open.length} open runs: ${open.map((r) => r.id).join(', ')}` });
    for (const run of open) {
      const hours = (now - new Date(run.started.at)) / 3600000;
      if (hours > config.stale_run_hours) out.push({ id: item.id, kind: 'stale', text: `${run.id} open ${Math.floor(hours)}h without a report` });
    }
  }
  return out;
}

export function truthy(value) {
  return value === true || value === 'true' || value === 1 || value === 'yes';
}

export function runLabel(run) {
  return [run.meta.harness, run.meta.model, run.meta.effort].filter(Boolean).join(' · ');
}

function num(value) {
  if (value == null || value === '') return undefined;
  const n = Number(String(value).replace(/[,_]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

// Usage is optional and opaque to the core: recorded on the run (org set) or in the report.
export function runUsage(run) {
  const src = { ...(run.report?.usage ?? {}), ...run.meta };
  const usage = {
    tokens_in: num(src.tokens_in ?? src.input_tokens),
    tokens_out: num(src.tokens_out ?? src.output_tokens),
    tokens_cached: num(src.tokens_cached ?? src.cached_tokens),
    cost: num(src.cost ?? src.cost_usd),
  };
  return Object.values(usage).some((v) => v !== undefined) ? usage : null;
}

export function usageSummary(runs) {
  const total = { runs: 0, recorded: 0, tokens_in: 0, tokens_out: 0, tokens_cached: 0, cost: 0 };
  for (const run of runs) {
    total.runs++;
    const u = runUsage(run);
    if (!u) continue;
    total.recorded++;
    for (const key of ['tokens_in', 'tokens_out', 'tokens_cached', 'cost']) total[key] += u[key] ?? 0;
  }
  return total;
}
