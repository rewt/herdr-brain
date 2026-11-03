// Saved logical allocation and physical resource audit. Never grants admission.
import {createHash} from 'node:crypto';
import {validateCapacityAllocation, capacityIdentity} from '../dispatch/capacity-lineage.mjs';
import {measureLifecycle, timestamp} from './lifecycle.mjs';
import {canonical} from '../messages/schema.mjs';
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);
const hash = b => createHash('sha256').update(b).digest('hex');

export function capacityAudit({trial, events, verified, missing, fail}) {
  const c = trial.capacity, w = trial.window, unknown = [], valid = new Map();
  // A gap naming a run withholds only that run. One naming none covers the whole
  // capture: an unread or unlisted job could have consumed any release.
  const gap = (reason, run) => { unknown.push({run: run ?? null, reason}); missing('capacity-coverage', reason, run); };
  // Only the saved original bytes are parsed. Inline journals/config/census
  // cannot override them, even if they carry a generic verified evidence ID.
  const original = id => {
    const bytes = c?.saved?.[id];
    if (!id || typeof bytes !== 'string' || !verified.has(id) || hash(bytes) !== trial.evidence?.[id]?.sha256) {
      gap(`verified original capacity packet missing: ${id ?? 'unnamed'}`); return null;
    }
    try { return JSON.parse(bytes); } catch { gap(`invalid original capacity packet: ${id}`); return null; }
  };
  const inventory = original(c?.inventoryEvidence), config = original(c?.configEvidence), census = original(c?.censusEvidence);
  const refs = c?.journalRefs ?? [], journals = [];
  if (c?.complete !== true || inventory?.complete !== true || !Array.isArray(inventory?.journals) ||
      !same([...inventory.journals].sort(), refs.map(r => r.journal).sort()) || new Set(refs.map(r => r.journal)).size !== refs.length)
    gap('complete original allocation journal inventory required');
  for (const ref of refs) {
    const job = original(ref.evidence);
    if (!job || !ref.journal?.startsWith('/')) continue;
    journals.push({...job, journal: ref.journal});
  }
  const capacities = config?.identities ?? [];
  if (!capacities.length || capacities.some(k => k.project !== trial.project || !k.org || !Number.isSafeInteger(k.cap) || k.cap < 1))
    gap('saved configured capacity identity/provenance required');
  const byRun = new Map(journals.map(j => [j.run, j]));
  const starts = events.filter(e => e.type === 'run.started' && e.meta?.dispatch_project === trial.project);
  // Missing ancestor context is not an affirmative native contradiction.
  // Check availability across the same full chain the validator will walk;
  // present but changed fields are left to the native validator to reject.
  const incompleteOriginal = (job, seen = new Set()) => {
    if (!job || seen.has(job.journal)) return false;
    seen.add(job.journal);
    const a = job.capacityAllocation;
    if (!a) return true;
    const start = events.find(e => e.type === 'run.started' && e.id === job.run);
    if (!start || timestamp(start.at) === null || !events.some(e => e.type === 'run.claimed' && e.run === job.run) ||
        a.admission_seq !== undefined && !events.some(e => e.seq === a.admission_seq)) return true;
    const previous = a.predecessor ?? a.reset_after;
    if (!previous) return false;
    const parent = journals.find(j => j.journal === previous.journal);
    if (!parent) return c?.complete !== true || inventory?.complete !== true || refs.some(r => r.journal === previous.journal) ||
      starts.some(s => s.meta?.dispatch_journal === previous.journal);
    if (a.predecessor && !events.some(e => e.type === 'report.ingested' && e.run === parent.run && timestamp(e.at) !== null)) return true;
    if (a.reset_after && !events.some(e => e.type === 'run.abandoned' && (e.run ?? e.id) === parent.run)) return true;
    return incompleteOriginal(parent, seen);
  };
  for (const job of journals) {
    // A pre-window job without a receipt can be nobody's ancestor or sibling. It
    // stays listed carry-in coverage below, not a gap in anyone's lineage.
    if (!job.capacityAllocation) {
      const start = starts.find(s => s.id === job.run);
      if (!start || start.seq > w.start_seq) gap('original allocation absent', job.run);
      continue;
    }
    const allocation = job.capacityAllocation, capacity = capacities.find(k => same(k, allocation.capacity));
    if (!job.sessionCap || !Number.isSafeInteger(job.sessionCap.cap)) { gap('saved original configured cap/provenance missing', job.run); continue; }
    const expected = capacityIdentity({common: job.common, org: job.org, ...job.sessionCap});
    if (!same(expected, allocation.capacity)) { fail('capacity-allocation', 'allocation differs from original configured cap/provenance', job.run); continue; }
    if (!capacity) { fail('capacity-allocation', 'allocation differs from saved configured capacity', job.run); continue; }
    if (incompleteOriginal(job)) { gap('original allocation ancestor context missing by cutoff', job.run); continue; }
    try {
      validateCapacityAllocation(allocation, {events, journals, capacity});
      if (timestamp(allocation.selected_at) > timestamp(w.cutoff)) gap('allocation selected beyond frozen cutoff', job.run);
      else valid.set(job.run, allocation);
    } catch (error) { fail('capacity-allocation', error.message, job.run); }
  }
  // A declaration of completeness cannot hide a sibling or original start.
  const earliest = starts.map(e => timestamp(e.at)).filter(t => t !== null).sort((a, b) => a - b)[0];
  const life = measureLifecycle({events, project: trial.project, from: earliest === undefined ? w.from : new Date(earliest).toISOString(),
    cutoff: w.cutoff, throughSeq: w.through_seq});
  const opening = timestamp(w.from), cutoff = timestamp(w.cutoff), kinds = ['session', 'tab', 'folder'];
  const endpoint = (b, k) => b?.resources[k]?.state === 'retired' ? timestamp(b.resources[k].receipt?.at) : null;
  const relevant = starts.filter(s => s.seq > w.start_seq || kinds.some(k => {
    const end = endpoint(life.runs.find(b => b.run === s.id), k); return end === null || end >= opening;
  }));
  if (census?.complete !== true || census.at !== w.from || census.through_seq !== w.start_seq || !Array.isArray(census?.resources))
    gap('complete opening carry-in resource census required');
  for (const s of relevant) {
    const j = byRun.get(s.id), carry = s.seq <= w.start_seq, named = s.meta?.dispatch_journal;
    // A carry-in that never named a journal has nothing to inventory.
    if (carry ? named && j?.journal !== named : !j || j.journal !== named) gap('relevant original start missing from journal inventory', s.id);
    if (carry && !census?.resources?.some(r => r.run === s.id)) gap('carry-in resource missing from opening census', s.id);
  }
  const firstAllocated = Math.min(...journals.filter(j => j.capacityAllocation).map(j => starts.find(s => s.id === j.run)?.seq ?? Infinity));
  for (const s of starts) if (s.seq > firstAllocated && s.meta?.dispatch_journal && byRun.get(s.id)?.journal !== s.meta.dispatch_journal)
    gap(`allocation-era start missing from journal inventory: ${s.id}`);
  const carryIns = relevant.filter(s => s.seq <= w.start_seq).map(s => {
    const allocation = byRun.get(s.id)?.capacityAllocation ?? null, observed = census?.resources?.find(r => r.run === s.id);
    if (!allocation && observed) {
      if ((observed.allocation ?? null) !== null || timestamp(observed.startedAt) !== timestamp(s.at)) gap('carry-in allocation/origin/pool unknown', s.id);
      if (kinds.some(k => observed[k] !== 'absent')) gap('resource origin or retirement unknown; peak is a lower bound', s.id);
    }
    return {run: s.id, allocation: allocation?.id ?? null, pool: allocation?.capacity?.pool ?? null, abandoned: events.some(e => e.type === 'run.abandoned' && (e.run ?? e.id) === s.id),
      ...Object.fromEntries(kinds.map(k => [k, observed?.[k] ?? 'unknown']))};
  });
  const pools = capacities.map(capacity => {
    const units = relevant.filter(s => same(byRun.get(s.id)?.capacityAllocation?.capacity, capacity)).map(s => {
      const allocation = byRun.get(s.id).capacityAllocation, b = life.runs.find(r => r.run === s.id);
      const carry = s.seq <= w.start_seq, observed = census?.resources?.find(r => r.run === s.id);
      if (carry && (!same(observed?.capacity, capacity) || observed?.allocation !== allocation.id || timestamp(observed?.startedAt) !== timestamp(s.at)))
        gap('carry-in allocation/origin/pool unknown', s.id);
      const ends = Object.fromEntries(kinds.map(k => [k, endpoint(b, k)]));
      // Census absence settles a carry-in that can never show a typed receipt.
      if (timestamp(s.at) === null || kinds.some(k => carry && !['present', 'absent'].includes(observed?.[k]) || ends[k] === null && !(carry && observed?.[k] === 'absent')))
        gap('resource origin or retirement unknown; peak is a lower bound', s.id);
      const report = events.find(e => e.type === 'report.ingested' && e.run === s.id && e.seq > allocation.allocation.claim_generation);
      const abandoned = events.find(e => e.type === 'run.abandoned' && (e.run ?? e.id) === s.id && e.seq > allocation.allocation.claim_generation);
      const freed = [report, abandoned].filter(Boolean).sort((a, b) => a.seq - b.seq)[0];
      return {run: s.id, allocation: allocation.id, start: timestamp(s.at), startSeq: s.seq, ends, carry, observed,
        release: timestamp(report?.at), releaseSeq: report?.seq ?? null,
        admitted: timestamp(allocation.selected_at) ?? timestamp(s.at), admittedSeq: allocation.admission_seq ?? s.seq - 1,
        freed: timestamp(freed?.at), freedSeq: freed?.seq ?? null};
    });
    // Event sequences disambiguate equal wall-clock release/start endpoints.
    const points = [{at: opening, seq: w.start_seq}, ...events.filter(e => timestamp(e.at) >= opening).map(e => ({at: timestamp(e.at), seq: e.seq})), {at: cutoff, seq: w.through_seq}];
    const snapshots = points.map(p => {
      const active = units.filter(u => u.start !== null && (u.start < p.at || u.start === p.at && u.startSeq <= p.seq));
      const physical = {}, debt = {};
      for (const k of kinds) {
        physical[k] = active.filter(u => !(u.carry && u.observed?.[k] === 'absent') && (u.ends[k] === null || u.ends[k] > p.at || u.ends[k] === p.at &&
          (life.runs.find(b => b.run === u.run)?.resources[k]?.receipt?.seq ?? Infinity) > p.seq));
        debt[k] = physical[k].filter(u => u.release !== null && (u.release < p.at || u.release === p.at && u.releaseSeq <= p.seq));
      }
      const unique = groups => [...new Map(kinds.flatMap(k => groups[k]).map(u => [u.run, u])).values()];
      return {physical, debt, physicalRuns: unique(physical), debtRuns: unique(debt)};
    });
    const summarize = (key, resourceKey) => {
      const groups = snapshots.map(s => resourceKey ? s[key][resourceKey] : s[key + 'Runs']);
      const first = groups[0], last = groups.at(-1), peak = Math.max(0, ...groups.map(g => g.length));
      const ids = list => list.map(u => ({run: u.run, allocation: u.allocation}));
      const ever = [...new Map(groups.flat().map(u => [u.run, u])).values()];
      return {opening: first.length, peak, cutoff: last.length, ratios_to_cap: {opening: first.length / capacity.cap, peak: peak / capacity.cap, cutoff: last.length / capacity.cap},
        opening_units: ids(first), cutoff_units: ids(last), units: ids(ever),
        oldest_known_age_ms: last.length ? Math.max(...last.map(u => cutoff - (key === 'debt' ? u.release : u.start))) : null,
        opening_oldest_known_age_ms: first.length ? Math.max(...first.map(u => opening - (key === 'debt' ? u.release : u.start))) : null,
        peak_oldest_known_age_ms: Math.max(0, ...groups.map((g, i) => Math.max(0, ...g.map(u => points[i].at - (key === 'debt' ? u.release : u.start))))),
        ...(key === 'debt' ? {created: ever.filter(u => !first.includes(u)).length, resolved: ever.filter(u => !last.includes(u)).length} : {})};
    };
    // Physical overlap is descriptive. Real logical over-admission is adverse. A
    // slot is held from selection until the report or the abandonment frees it.
    for (const p of points) {
      const logical = units.filter(u => u.admitted !== null && (u.admitted < p.at || u.admitted === p.at && u.admittedSeq <= p.seq) &&
        (u.freed === null || u.freed > p.at || u.freed === p.at && u.freedSeq > p.seq));
      if (logical.length > capacity.cap) { fail('capacity-admission', 'original logical admissions exceed configured cap'); break; }
    }
    return {capacity, configured_cap: capacity.cap, physical: summarize('physical'), debt: summarize('debt'),
      resources: Object.fromEntries(kinds.map(k => [k, {physical: summarize('physical', k), debt: summarize('debt', k)}]))};
  });
  const captureComplete = unknown.every(u => u.run !== null);
  const chainProved = (run, seen = new Set()) => {
    const allocation = valid.get(run), previous = allocation?.predecessor ?? allocation?.reset_after;
    if (!allocation || seen.has(run)) return false;
    seen.add(run);
    if (!previous) return true;
    const parent = journals.find(j => j.journal === previous.journal);
    return Boolean(parent) && chainProved(parent.run, seen);
  };
  return {valid, lineageProved: run => captureComplete && chainProved(run),
    report: {schema: 'brain.capacity-assessment/v1', coverage: {complete: unknown.length === 0, peak_lower_bound: unknown.length > 0, unknown}, carry_ins: carryIns, pools}};
}
