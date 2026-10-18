// Frozen fold from main at 1d41b7e78fb8536c95a2a4162951a13dea467d86.
// Completion fingerprints depend on this exact historical run shape.
export function fold(events) {
  const s = { items: new Map(), runs: new Map(), lessons: new Map(), candidates: new Map(), links: [], categoryFlags: [], eventCount: 0, lastAt: null };
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
