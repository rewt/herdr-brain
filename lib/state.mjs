// Current state is a pure fold over the event log. Status is derived, never stored.
import { categoryFlagText } from './discernment.mjs';
import { ROLE_PREFIX, roleIs } from './roles.mjs';
import { WORKER_KEYS } from './worker-identity.mjs';
export const BUDGET_KEYS = ['max_runs', 'max_children', 'max_depth', 'escalation_budget'];

export function fold(events) {
  const s = { items: new Map(), runs: new Map(), lessons: new Map(), candidates: new Map(), links: [], categoryFlags: [], eventCount: 0, lastAt: null,
    workerReceipts: new Map(), sessionBindings: new Map() };
  return extendFold(s, events);
}

// Extend an in-memory derived state with an observed append-only tail.
export function extendFold(s, events) {
  for (const e of events) apply(s, e);
  s.eventCount += events.length;
  return s;
}

function apply(s, e) {
  s.lastAt = e.at;
  const item = s.items.get(e.id ?? e.item);
  switch (e.type) {
    case 'lesson.proposed':
      s.lessons.set(e.id, {
        id: e.id, text: e.text, scope: e.scope, paths: e.paths ?? [], modules: e.modules ?? [], evidence: e.evidence,
        proposed: { seq: e.seq, at: e.at, by: e.by }, activation: null, retirement: null, supersession: null,
      });
      break;
    case 'lesson.activated': {
      const lesson = s.lessons.get(e.id);
      if (lesson) {
        lesson.activation = { seq: e.seq, at: e.at, by: e.by };
        lesson.retirement = null;
      }
      break;
    }
    case 'lesson.retired': {
      const lesson = s.lessons.get(e.id);
      if (lesson) lesson.retirement = { seq: e.seq, at: e.at, by: e.by, reason: e.reason };
      break;
    }
    case 'lesson.superseded': {
      const lesson = s.lessons.get(e.id);
      if (lesson) lesson.supersession = { seq: e.seq, at: e.at, by: e.by, by_lesson: e.by_lesson, reason: e.reason };
      break;
    }
    case 'release.cut': {
      const { type, seq, at, by, ...candidate } = e;
      s.candidates.set(e.id, { ...candidate, created: { seq, at, by }, started: null, gate: null, question: null });
      break;
    }
    case 'release.gate.started':
      if (s.candidates.has(e.id)) s.candidates.get(e.id).started = { seq: e.seq, at: e.at, by: e.by };
      break;
    case 'release.gate.finished':
      if (s.candidates.has(e.id)) Object.assign(s.candidates.get(e.id), { gate: { ...e.gate, seq: e.seq, at: e.at, by: e.by }, question: e.question });
      break;
    // Retired operator priorities (priority.added, priorities.ranked) fall
    // through to the default: older records keep loading and display by type.
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
      if (run) {
        run.meta = { ...run.meta, ...(e.meta ?? {}) };
        if (!s.workerReceipts.has(e.id) && e.meta?.agent && e.meta.pane && e.meta.worker_workspace &&
            (e.meta.terminal_id || e.meta.agent_session_id))
          s.workerReceipts.set(e.id, { seq: e.seq, ...Object.fromEntries(WORKER_KEYS.filter(k => e.meta[k] != null).map(k => [k, e.meta[k]])) });
      }
      break;
    }
    case 'run.session_bound': {
      if (s.runs.has(e.run)) {
        if (!s.sessionBindings.has(e.run)) s.sessionBindings.set(e.run, []);
        s.sessionBindings.get(e.run).push(e);
      }
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
      if (target) {
        // Runs are appended in start-event order; clocks and numeric ids do not
        // determine which report owns the outcome. A late older report must
        // leave it untouched, including when a reopen has cleared it.
        const newestReported = target.runs.findLast((id) => s.runs.get(id)?.report);
        if (newestReported === e.run) {
          target.outcome = { value: run.report.outcome, run: run.id, at: run.report.at, seq: run.report.seq };
        } else run.report.late = true;
      }
      break;
    }
    default:
      // Unknown event types from newer versions are ignored, not fatal.
      break;
  }
}

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
  return `${prefix}-${maxNumber([...s.items.keys(), ...s.lessons.keys(), ...taken], prefix) + 1}`;
}

export function nextRunId(s) {
  return `R-${maxNumber(s.runs.keys(), 'R') + 1}`;
}

// Lessons are knowledge, not schedulable work: no item status, runs or budgets.
export function nextLessonId(s) {
  return `L-${maxNumber([...s.lessons.keys(), ...s.items.keys()], 'L') + 1}`;
}

export function lessonState(lesson) {
  if (lesson.supersession) return 'superseded';
  if (lesson.retirement) return 'retired';
  return lesson.activation ? 'active' : 'proposed';
}

// Edges point from the old lesson to its replacement. A replacement cannot
// lead back to the old lesson, even through several earlier replacements.
export function wouldCycleLesson(s, id, byLesson) {
  const seen = new Set();
  let current = byLesson;
  while (current && !seen.has(current)) {
    if (current === id) return true;
    seen.add(current);
    current = s.lessons.get(current)?.supersession?.by_lesson;
  }
  return false;
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
  return [...new Set([...s.links.filter((l) => l.blocked === id).map((l) => l.blocker),
    ...children(s, id).filter((i) => reviewChild(s, id, i.id)).map((i) => i.id)])];
}

export function blockedBy(s, id) {
  const parent = s.items.get(id)?.parent;
  return [...new Set([...s.links.filter((l) => l.blocker === id).map((l) => l.blocked),
    ...(reviewChild(s, parent, id) ? [parent] : [])])];
}

export function openRuns(s, id) {
  return (s.items.get(id)?.runs ?? []).map((r) => s.runs.get(r)).filter((r) => r && !r.report && !r.abandoned);
}

export function laterRuns(s, runId) {
  const run = s.runs.get(runId);
  const siblings = s.items.get(run?.item)?.runs ?? [];
  const index = siblings.indexOf(runId);
  return index < 0 ? [] : siblings.slice(index + 1).map((id) => s.runs.get(id));
}

export function isResolved(status) {
  return status === 'done' || status === 'dropped';
}

// A question answered "no" is closed, but the work it blocked must not proceed:
// it stays blocked until someone re-plans it and removes the link.
export function isDeclined(item) {
  return Boolean(item?.closed) && item.meta?.answer === 'no';
}

// A review that finished without a PASS verdict (FAIL, NEEDS-WORK, ...) keeps holding the work it
// blocks, even after an earlier PASS. Reports without a verdict are unaffected.
export function failedVerdict(s, id) {
  const verdict = s.runs.get(s.items.get(id)?.outcome?.run)?.report?.extra?.verdict;
  return verdict !== undefined && String(verdict).trim().toUpperCase() !== 'PASS';
}

const reviewChild = (s, parent, id) => s.items.get(parent)?.kind === 'work'
  && s.items.get(id)?.parent === parent && roleIs(s.items.get(id), 'REV');
const hasPass = (s, id) => String(s.runs.get(s.items.get(id)?.outcome?.run)?.report?.extra?.verdict ?? '')
  .trim().toUpperCase() === 'PASS';

// A prerequisite may lead to its own review child through links and other review holds.
// Check the whole path so intermediate work can become ready in its own view too.
function reviewPrerequisite(s, id, blocked) {
  if (!blocked || s.items.get(id)?.kind !== 'work') return false;
  const reviews = new Set(children(s, id).filter(i => roleIs(i, 'REV')).map(i => i.id));
  if (!reviews.size) return false;
  const stack = [blocked], seen = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (reviews.has(current)) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...blockedBy(s, current));
  }
  return false;
}

// Open operator questions that hold promotion: under the work itself or under a review that blocks it,
// whether or not they are linked as blockers.
export function openQuestionsFor(s, id) {
  const owners = new Set([id, ...blockersOf(s, id).filter((b) => roleIs(s.items.get(b), 'REV'))]);
  return [...s.items.values()].filter((q) => owners.has(q.parent) && roleIs(q, 'HUM') && !q.closed);
}

// Promotion requires an explicit PASS from every done reviewer blocker, including children.
// Status releases done reviews without a verdict; promotion still requires PASS.
export function reviewsWithoutPass(s, id) {
  return blockersOf(s, id).filter((b) => {
    const item = s.items.get(b);
    // Any spelling that names the reviewer role (the REV prefix), such as "review" or "Reviewer".
    if (!roleIs(item, 'REV') || itemStatus(s, b, new Set(), id) !== 'done') return false;
    return !hasPass(s, b);
  });
}

export function releases(s, id, status) {
  return isResolved(status) && !isDeclined(s.items.get(id)) && !(status === 'done' && failedVerdict(s, id));
}

// Work completion excludes review holds when it is a direct or transitive prerequisite
// of its own review child. The optional blocked id lets views and guards use the same
// dependency-specific status, without deadlocking intermediate prerequisite work.
export function itemStatus(s, id, visiting = new Set(), blocked = null) {
  const item = s.items.get(id);
  if (!item) return 'unknown';
  if (item.closed) return item.closed.as;
  if (openRuns(s, id).length) return 'active';
  if (item.kind === 'goal') return 'open';
  const beforeReview = reviewPrerequisite(s, id, blocked);
  const key = beforeReview ? `before-review:${id}` : id;
  if (visiting.has(key)) return 'blocked';
  visiting.add(key);
  const blockers = blockersOf(s, id).filter((b) => !beforeReview || !reviewChild(s, id, b));
  const unresolved = blockers.filter((b) => !releases(s, b, itemStatus(s, b, visiting, id)));
  visiting.delete(key);
  if (unresolved.length) return 'blocked';
  switch (item.outcome?.value) {
    case 'done':
      return 'done';
    case 'needs_human':
      return 'needs_human';
    case 'blocked':
      // Blocked on linked items that are now resolved means ready to continue;
      // blocked with nothing linked is still waiting on whatever the report said.
      return s.links.some(l => l.blocked === id) ? 'ready' : 'blocked';
    default:
      return 'ready';
  }
}

export function statusMap(s) {
  const map = new Map();
  for (const id of s.items.keys()) map.set(id, itemStatus(s, id));
  return map;
}

// Index links, current runs and explicit plans once per read, including parked
// questions. Looking up a question then visits only its dependency subgraph.
export function waitingImpactIndex(s, statuses = statusMap(s)) {
  const dependents = new Map(), itemRuns = new Map(), namedRuns = new Map(), planSteps = new Map();
  const names = text => new Set(String(text ?? '').match(/[A-Za-z][A-Za-z0-9]*-\d+/g) ?? []);
  const addDependent = (blocker, blocked) => {
    if (!dependents.has(blocker)) dependents.set(blocker, []);
    const ids = dependents.get(blocker);
    if (!ids.includes(blocked)) ids.push(blocked);
  };
  for (const link of s.links) addDependent(link.blocker, link.blocked);
  for (const item of s.items.values()) {
    if (reviewChild(s, item.parent, item.id)) addDependent(item.id, item.parent);
  }
  for (const item of s.items.values()) {
    if (isResolved(statuses.get(item.id))) continue;
    const activeRuns = openRuns(s, item.id);
    const run = s.runs.get(item.outcome?.run);
    const waitingRun = run && !run.abandoned && !activeRuns.some(r => r.started.seq > run.started.seq)
      && ['blocked', 'needs_human'].includes(run.report?.outcome);
    itemRuns.set(item.id, [...activeRuns.map(r => r.id), ...(waitingRun ? [run.id] : [])]);
    if (waitingRun) for (const blocker of run.report.blockers ?? []) {
      for (const id of names(blocker)) {
        if (id === item.id) continue;
        if (!namedRuns.has(id)) namedRuns.set(id, new Set());
        namedRuns.get(id).add(run.id);
      }
    }

    // Plans use the existing note event. Only the latest explicitly marked plan
    // on each target contributes; arbitrary mentions and old plans do not.
    for (const target of [item, ...activeRuns, ...(waitingRun ? [run] : [])]) {
      const plan = target.notes.findLast(n => n.kind === 'plan' || /^\s*(?:#+\s*)?plan\s*:/im.test(n.text)
        || /^\s*#+\s+plan\s*$/im.test(n.text));
      if (!plan) continue;
      let inPlan = plan.kind === 'plan';
      for (const line of plan.text.split('\n')) {
        if (/^\s*(?:#+\s*)?plan\s*:|^\s*#+\s+plan\s*$/i.test(line)) { inPlan = true; continue; }
        if (/^\s*#+\s/.test(line)) { inPlan = false; continue; }
        if (inPlan && /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line)
          && !/^\s*[-*+]\s+\[[xX]\]/.test(line)) {
          for (const id of names(line)) if (id !== item.id) planSteps.set(id, (planSteps.get(id) ?? 0) + 1);
        }
      }
    }
  }
  return { dependents, itemRuns, namedRuns, planSteps };
}

// Display-only impact: count unresolved dependents once through diamonds, stop
// at resolved work, and deduplicate linked and explicitly named waiting runs.
export function waitingImpact(s, id, statuses = statusMap(s), index = waitingImpactIndex(s, statuses)) {
  const items = new Set(), seen = new Set([id]), stack = [id];
  const runs = new Set(index.namedRuns.get(id));
  while (stack.length) {
    for (const next of index.dependents.get(stack.pop()) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (!s.items.has(next) || isResolved(statuses.get(next))) continue;
      items.add(next);
      for (const run of index.itemRuns.get(next) ?? []) runs.add(run);
      stack.push(next);
    }
  }
  return { items: items.size, runs: runs.size, plan_steps: index.planSteps.get(id) ?? 0 };
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
    // Review-child holds are completion conditions, not prerequisite links.
    // A child review may legitimately wait for its parent's work report.
    stack.push(...s.links.filter(l => l.blocker === current).map(l => l.blocked));
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
