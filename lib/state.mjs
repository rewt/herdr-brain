// Current state is a pure fold over the event log. Status is derived, never stored.
import { categoryFlagText } from './discernment.mjs';
import { ROLE_PREFIX, roleIs } from './roles.mjs';
import { WORKER_KEYS } from './worker-identity.mjs';
import { applyObligationEvent } from './obligations.mjs';
export const BUDGET_KEYS = ['max_runs', 'max_children', 'max_depth', 'escalation_budget'];
export const acceptanceTarget = target => target ? {
  head: target.head, base: target.base, reportHash: target.reportHash, evidence_kind: target.evidence_kind,
  claim_generation: target.claim_generation ?? target.source_provenance?.claim_generation ?? target.landed_evidence?.owner_generation,
  report_sha256: target.report_sha256 ?? target.source_group?.report_sha256,
} : null;

export function fold(events) {
  const s = { items: new Map(), runs: new Map(), lessons: new Map(), candidates: new Map(), links: [], categoryFlags: [], eventCount: 0, lastAt: null,
    workerReceipts: new Map(), sessionBindings: new Map(), obligations: new Map() };
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
        ...(e.meta?.review_target ? { acceptance_capture: structuredClone({
          source_item: e.meta.review_source_item, source_run: e.meta.review_source_run,
          target: acceptanceTarget(e.meta.review_target),
        }) } : {}),
      });
      break;
    case 'item.acceptance-amended':
      if (!item) break;
      // Retain the original words and authorship before replacing active text.
      item.accept_history ??= [{ accept: [...item.accept], seq: item.created.seq,
        at: item.created.at, by: item.created.by, why: null }];
      item.accept_history.push({ accept: [...e.accept], seq: e.seq, at: e.at, by: e.by, why: e.why });
      item.accept = [...e.accept];
      break;
    case 'item.updated':
      if (!item) break;
      for (const [key, value] of Object.entries(e.fields ?? {})) {
        if (key === 'budget' || key === 'meta') item[key] = { ...item[key], ...value };
        else item[key] = value;
      }
      break;
    case 'line.priority-holds-migrated':
    case 'line.priority-holds-restored':
      // Exact metadata snapshots are authorized under the owning record lock.
      // Older folds ignore these events and conservatively retain old holds.
      for(const change of e.changes??[]) {
        const subject=s.items.get(change.id);
        if(subject)subject.meta=structuredClone(change.after);
      }
      break;
    case 'decision.restored':
      for(const before of e.items??[])s.items.set(before.id,structuredClone(before));
      s.links=structuredClone(e.links);
      if(s.items.has(e.decision))delete s.items.get(e.decision).decision_disposition;
      break;
    case 'decision.applied':
    case 'decision.stale': {
      const decision=s.items.get(e.decision);
      if(decision&&decision.meta.decision_request?.key===e.key)decision.decision_disposition={key:e.key,seq:e.seq,type:e.type};
      break;
    }
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
        s.links.push({ blocker: e.blocker, blocked: e.blocked, seq: e.seq, at: e.at, by: e.by,
          ...(e.requires ? { requires: e.requires, consumer: e.consumer, wake: e.wake, stuck_owner: e.stuck_owner } : {}) });
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
    case 'run.claimed': {
      const run = s.runs.get(e.run);
      if (run) { run.owner = e.owner; run.owner_generation = e.seq; }
      break;
    }
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
    case 'change.landed': {
      const run = s.runs.get(e.run);
      if (run && run.item === e.item) (run.landings ??= []).push({ type: e.type, seq: e.seq, at: e.at,
        item: e.item, run: e.run, head: e.head, base: e.base, project: e.project,
        producer: { ownership_generation: e.producer?.ownership_generation } });
      break;
    }
    case 'change.reviewed': {
      const run = s.runs.get(e.source_run);
      if (run && run.item === e.item) (run.judgments ??= []).push(Object.fromEntries([
        'type', 'seq', 'at', 'item', 'head', 'base', 'review_key', 'review_item', 'review_run', 'verdict', 'covered_commits',
        'source_run', 'source_report_sha256', 'source_claim_generation', 'report_sha256', 'intent_fulfilled',
      ].filter(k => e[k] !== undefined).map(k => [k, e[k]])));
      break;
    }
    case 'review.finding-linked':
      if (s.items.has(e.correction_item)) (s.items.get(e.correction_item).finding_bindings ??= []).push(e);
      break;
    case 'correction.discharged': {
      const run = s.runs.get(e.run);
      if (run && run.item === e.item) (run.discharges ??= []).push(e);
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
  applyObligationEvent(s, e);
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
  && s.items.get(id)?.parent === parent && roleIs(s.items.get(id), 'REV')
  && (s.items.get(id)?.meta.proposal_intake !== 'report-proposal/v1' || s.items.get(id)?.meta.queue_selected === true);
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
  const item=s.items.get(id);
  if(roleIs(item,'DEC')&&item.meta.decision_request&&!item.decision_disposition)return false;
  return isResolved(status) && !isDeclined(item) && !(status === 'done' && failedVerdict(s, id));
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
  // Only newly typed intake records gain the note view. Saved/legacy selected
  // work and attempts require no new metadata or migration.
  if (!item.runs.length && item.meta.proposal_intake === 'report-proposal/v1' && item.meta.queue_selected !== true)
    return item.meta.proposal_lapse ? 'lapsed' : 'proposed';
  const beforeReview = reviewPrerequisite(s, id, blocked);
  const key = beforeReview ? `before-review:${id}` : id;
  if (visiting.has(key)) return 'blocked';
  visiting.add(key);
  const blockers = blockersOf(s, id).filter((b) => !beforeReview || !reviewChild(s, id, b));
  const unresolved = blockers.filter((b) => !dependencyReleases(s, b, id, itemStatus(s, b, visiting, id)));
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

// Completion remains the default. Acceptance is an explicit consumer choice;
// neither Unknown nor a positive counter can release an accepted-outcome edge.
export function dependencyReleases(s, blocker, blocked, status) {
  if (!releases(s, blocker, status)) return false;
  const link = s.links.find(l => l.blocker === blocker && l.blocked === blocked);
  return link?.requires !== 'accepted' || itemConditions(s, blocker).Accepted.status === 'True';
}

const fullCommit = value => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value ?? '');
const hash = value => /^[a-f0-9]{64}$/.test(value ?? '');
const evidenceRef = e => e ? { seq: e.seq, at: e.at, type: e.type ?? 'report.ingested' } : null;

// Read-only facts shared by dependency and phase consumers. No model, clock,
// liveness inference, retry or phase setter. Historical verdicts stay intact.
export function itemConditions(s, id, { progress = null, visiting = new Set() } = {}) {
  const item = s.items.get(id), run = s.runs.get(item?.runs.at(-1)), report = run?.report;
  const generation = { run: run?.id ?? null, report: report?.sha256 ?? null, claim: run?.owner_generation ?? null };
  const fact = (status, reason, evidence = []) => ({ status, reason, observed_generation: generation,
    evidence: evidence.filter(Boolean).map(evidenceRef) });
  if (visiting.has(id)) return { Completed: fact('Unknown', 'condition cycle'), SourceDelivered: fact('Unknown', 'condition cycle'),
    Accepted: fact('Unknown', 'condition cycle'), Progressing: fact('Unknown', 'condition cycle'), phase: 'pending' };
  visiting = new Set([...visiting, id]);
  const completed = report ? fact(report.outcome === 'done' ? 'True' : 'False', `reported ${report.outcome}`, [report])
    : fact(run?.abandoned ? 'False' : 'Unknown', run?.abandoned ? 'run abandoned without a report' : 'no current report');
  const recordedLandings = run?.landings ?? [];
  const landings = recordedLandings.filter(l => fullCommit(l.head) && l.project === run.meta.dispatch_project &&
    run.owner_generation != null && l.producer?.ownership_generation === run.owner_generation), landing = landings.at(-1);
  const source = landing ? fact('True', 'recorded source landing; acceptance is separate', [landing]) : fact('Unknown', 'no current landing observed');
  const reviews = [...s.items.values()].filter(q => roleIs(q, 'REV') &&
    (q.meta.review_source_item === id && q.meta.review_source_run === run?.id || reviewChild(s, id, q.id)));
  const pendingReviews = reviews.filter(q => !q.closed && (q.outcome?.value !== 'done' || openRuns(s, q.id).length));
  const questions = [...s.items.values()].filter(q => roleIs(q, 'HUM') && !q.closed &&
    (q.parent === id || reviews.some(r => r.id === q.parent)));
  const declaredQuestions = (report?.questions ?? report?.extra?.questions ?? []).length || (report?.blockers ?? []).length;
  let accepted = fact('Unknown', 'no class-specific acceptance evidence');
  let judgment = null;
  const code = recordedLandings.length || (report?.artifacts ?? []).some(a => /(?:source:|commit:)/i.test(a));
  if (completed.status !== 'True') accepted = fact(completed.status === 'False' ? 'False' : 'Unknown', 'current run has no completed result', [report]);
  else if (!item.outcome || item.outcome.run !== run.id || item.closed?.as === 'dropped') accepted = fact('False', 'completion superseded, reopened or dropped', [report]);
  else if (questions.length || declaredQuestions) accepted = fact('False', 'outstanding question or blocker', [report]);
  else if (item?.meta.review_fix_of) {
    // Intake verified the original finding and actual captured check result.
    const keys = item.meta.review_finding_keys ?? [];
    const discharge = run.discharges?.findLast(d => d.report_sha256 === report.sha256 && d.claim_generation === run.owner_generation &&
      d.review_key === item.meta.review_fix_of && keys.length && keys.every(key => d.findings.some(f => f.key === key)));
    const exact = discharge && hash(report.sha256) && fullCommit(landing?.head) &&
      discharge.findings.every(f => f.head === landing.head && item.finding_bindings?.some(b => b.seq === f.finding_seq && b.finding_key === f.key));
    accepted = exact ? fact('True', 'assigned findings discharged with explicit correction results', [report, ...landings])
      : fact('Unknown', 'correction discharge missing or incomplete; done/check selection is not a result', [report]);
  } else if (code) {
    judgment = (run.judgments ?? []).findLast(e => {
      const review = s.items.get(e.review_item), reviewer = s.runs.get(e.review_run), capture = review?.acceptance_capture, target = capture?.target;
      const claim = target?.claim_generation;
      return hash(report.sha256) && run.owner_generation != null && e.source_run === run.id &&
        e.source_report_sha256 === report.sha256 && e.source_claim_generation === run.owner_generation &&
        claim === run.owner_generation && review?.meta.review_source_run === run.id && review.meta.review_source_item === id &&
        roleIs(review, 'REV') && capture.source_run === run.id && capture.source_item === id &&
        JSON.stringify(acceptanceTarget(review.meta.review_target)) === JSON.stringify(target) &&
        e.head === target?.head && e.base === target?.base && e.review_key === `${id}:${e.head}` &&
        reviewer?.item === review.id && reviewer.report?.outcome === 'done' && reviewer.report.sha256 === e.report_sha256 &&
        review.runs.at(-1) === reviewer.id && review.outcome?.run === reviewer.id &&
        (target.report_sha256 ?? (target.evidence_kind === 'native-landings/v1' ? e.source_report_sha256 : target.reportHash)) === report.sha256 &&
        recordedLandings.length === landings.length && landing?.head === e.head && landings.every(l => (e.covered_commits ?? [e.head]).includes(l.head) &&
          l.project === run.meta.dispatch_project && l.producer?.ownership_generation === run.owner_generation);
    }) ?? null;
    accepted = judgment ? judgment.verdict === 'PASS' && judgment.intent_fulfilled !== true
      ? fact('Unknown', 'PASS recorded without exact fulfilled-intent evidence', [judgment])
      : fact(judgment.verdict === 'PASS' ? 'True' : 'False', `exact-target ${judgment.verdict}`, [judgment])
      : fact('Unknown', 'current report/head/claim has no exact judgment', [report]);
    if (pendingReviews.length && accepted.status === 'True') accepted = fact('Unknown', 'review still pending', [report]);
  } else if (item?.meta.acceptance_class === 'plan' || ['ARCH', 'RES', 'DEC', 'PLAN', 'TRI', 'DOC', 'DES'].some(role => roleIs(item, role))) {
    accepted = reviews.some(q => failedVerdict(s, q.id)) ? fact('False', 'negative plan review retained', [report])
      : pendingReviews.length ? fact('Unknown', 'plan review pending', [report])
      : fact('True', 'completed plan report without an outstanding question or review', [report]);
  }
  let progressing = fact('Unknown', 'bound progress observations unavailable; ENG-1033 supplies counters');
  if (report || run?.abandoned) progressing = fact('False', 'current run is finished; no execution progress inferred', [report, run?.abandoned]);
  else if (run && progress?.run === run.id && progress.claim_generation === run.owner_generation && progress.available === true &&
      Number.isSafeInteger(progress.from_seq) && Number.isSafeInteger(progress.to_seq) &&
      progress.from_seq >= run.started.seq && progress.to_seq >= progress.from_seq && progress.to_seq <= (s.eventCount ? Math.max(s.eventCount, run.started.seq) : 0)) {
    const changes = landings.filter(e => e.seq > progress.from_seq && e.seq <= progress.to_seq);
    progressing = fact(changes.length ? 'True' : 'False', changes.length ? 'source advanced in the observed record interval' : 'no source transition in the observed interval; diagnostic only', changes);
  } else if (!progress && landing && run && landing.seq > run.started.seq) progressing = fact('True', 'source advanced during this run; counter feed remains unavailable', [landing]);
  const corrections = [...s.items.values()].filter(q => q.meta.review_source_item === id && q.meta.review_source_run === run?.id && q.meta.review_fix_of);
  const correctionPending = corrections.some(q => itemConditions(s, q.id, { visiting }).Accepted.status !== 'True');
  if (correctionPending) accepted = fact('False', 'linked correction is not discharged', [judgment]);
  else if (corrections.length && judgment && accepted.status === 'False' && !questions.length && !declaredQuestions)
    accepted = fact('True', 'exact negative judgment retained; linked findings discharged', [judgment, ...corrections.map(q => s.runs.get(q.runs.at(-1))?.report)]);
  const phase = correctionPending || accepted.status === 'False' && completed.status === 'True' ? 'needs-work'
    : accepted.status === 'True' ? 'accepted' : pendingReviews.length ? 'in-review'
      : completed.status === 'True' ? 'ready-for-review' : run && !report && !run.abandoned ? 'working' : 'pending';
  return { Completed: completed, SourceDelivered: source, Accepted: accepted, Progressing: progressing, phase };
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
