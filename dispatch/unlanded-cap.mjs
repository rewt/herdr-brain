// Dispatch policy only. The record remains advisory and stores admission facts,
// never a mutable unlanded status or a worktree/session census.
import fs from 'node:fs';
import path from 'node:path';
import { fold } from '../lib/state.mjs';
import { loadEvents } from '../lib/store.mjs';
import { gitProject } from '../lib/project.mjs';

export const DEFAULT_UNLANDED_CAP = 8;
export const UNLANDED_EXCEPTION_CAP = 3;
const canonical = file => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
const refusal = (code, message) => Object.assign(Error(message), { code });

export function countUnlanded({ events, common, journals = [], projectIdentity = cwd => gitProject(cwd).identity }) {
  common = canonical(common);
  const state = fold(events), starts = new Map(), projects = new Map(), workspaces = new Map();
  const recorded = new Map(events.filter(e => e.type === 'run.started').map(e => [e.id, e]));
  const promotions = [], landedProjects = new Map();
  for (const event of events) {
    if (event.type !== 'promotion.reconciled' || !event.identity) continue;
    for (const head of event.heads ?? []) {
      if (recorded.get(head.run)?.item !== head.item || !event.items?.includes(head.item) || !event.runs?.includes(head.run)) continue;
      const identity = canonical(event.identity);
      promotions.push({ ...head, identity });
      if (!landedProjects.has(head.run)) landedProjects.set(head.run, new Set());
      landedProjects.get(head.run).add(identity);
    }
  }
  // Event order, not clocks or numeric IDs, orders attempts. Keep the original
  // start metadata: a later display metadata edit cannot create an exception.
  for (const [order, event] of events.entries()) {
    if (event.type !== 'run.started') continue;
    const run = state.runs.get(event.id);
    const belongs = () => {
      if (event.meta?.dispatch_project) return canonical(event.meta.dispatch_project) === common;
      // A matching recorded landing identifies a legacy run even after its
      // workspace disappears. Consult it before the conservative Git fallback.
      if (landedProjects.has(event.id)) return landedProjects.get(event.id).has(common);
      if (!workspaces.has(event.workspace)) {
        try { workspaces.set(event.workspace, canonical(projectIdentity(event.workspace)) === common); }
        catch { workspaces.set(event.workspace, true); } // Missing legacy evidence cannot free a slot.
      }
      return workspaces.get(event.workspace);
    };
    if (!run || !belongs()) continue;
    const start = { run, meta: event.meta ?? {}, order };
    starts.set(run.id, start);
    if (!projects.has(run.item)) projects.set(run.item, []);
    projects.get(run.item).push(start);
  }
  const landed = new Map();
  for (const head of promotions) {
    const start = starts.get(head.run);
    if (head.identity === common && start) landed.set(head.item, Math.max(landed.get(head.item) ?? -1, start.order));
  }
  const items = [];
  for (const [id, runs] of projects) {
    const item = state.items.get(id), latest = runs.at(-1);
    if (item?.closed?.as === 'dropped' || latest.order <= (landed.get(id) ?? -1)) continue;
    items.push({ item: id, title: item?.title ?? id, runs: runs.map(s => s.run.id), latest: latest.run.id });
  }
  const exceptions = [...starts.values()].filter(s => ['fix', 'unblocks'].includes(s.meta.dispatch_unlanded_exception) &&
    !s.run.report && !s.run.abandoned).map(s => ({ run: s.run.id, item: s.run.item, kind: s.meta.dispatch_unlanded_exception }));
  // `starting` is saved under the shared admission lock before spawning the
  // record writer. The coordinator's death cannot release this reservation:
  // its child can still append. A matching start replaces it exactly once;
  // only a definitive record refusal makes an unmatched start safe to retry.
  const matchesStart = j => {
    const kind = j.unlandedCap?.admission?.kind;
    return [...starts.values()].some(s => s.run.item === j.item && s.meta.dispatch_journal === j.journal &&
      s.meta.dispatch_attempt === j.token && s.meta.dispatch_unlanded_exception === (kind === 'regular' ? undefined : kind));
  };
  const reservations = journals.filter(j => j.stage === 'starting' && !j.startRefused && j.common &&
    canonical(j.common) === common && !matchesStart(j));
  for (const j of reservations) {
    let item = items.find(i => i.item === j.item);
    if (!item) {
      item = { item: j.item, title: state.items.get(j.item)?.title ?? j.item, runs: [], latest: null };
      items.push(item);
    }
    (item.pending ??= []).push(j.journal);
    const kind = j.unlandedCap?.admission?.kind;
    if (['fix', 'unblocks'].includes(kind)) exceptions.push({ run: null, item: j.item, kind, journal: j.journal });
  }
  return { state, starts, items, exceptions, reservations };
}

function startJournals(org) {
  if (!org) return [];
  const directory = path.join(org, 'dispatch');
  let files;
  try { files = fs.readdirSync(directory); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return files.filter(file => file.endsWith('.json') && !file.endsWith('.routes.json')).sort().map(file => {
    const journal = path.join(directory, file);
    return { ...JSON.parse(fs.readFileSync(journal, 'utf8')), journal };
  });
}

export function checkUnlandedCap({ config, org, events, journals, request, requireLink = false, ...options }) {
  const cap = config.dispatch?.max_unlanded === undefined ? DEFAULT_UNLANDED_CAP : config.dispatch.max_unlanded;
  if (!Number.isSafeInteger(cap) || cap < 1) throw Error('dispatch.max_unlanded must be a positive integer');
  // Snapshot journals first. If recovery advances a journal after its start
  // commits, the later event snapshot sees that start; reversing these reads
  // could miss both the reservation and the run during that transition.
  journals ??= startJournals(org);
  events ??= loadEvents(org).events;
  const { state, starts, items, exceptions, reservations } = countUnlanded({ events, journals, ...options });
  if (request.fromRun) {
    const origin = starts.get(request.fromRun);
    if (!origin || origin.run.item !== request.item) {
      throw refusal('FROM_RUN_OTHER_ITEM', '--from-run must name a run on the dispatched item in this project');
    }
  }
  if (request.unblocks != null) {
    if (request.unblocks === request.item || !items.some(i => i.item === request.unblocks && i.runs.length)) {
      throw refusal('DISPATCH_UNBLOCKS_INVALID', `--unblocks must name another unlanded item in this project; ${request.unblocks} is not a pending landing`);
    }
    if (requireLink && !state.links.some(l => l.blocker === request.item && l.blocked === request.unblocks)) {
      throw refusal('DISPATCH_UNBLOCKS_INVALID', `recorded landing link missing: ${request.item} must block ${request.unblocks}`);
    }
  }
  const kind = items.length < cap ? 'regular' : request.fromRun ? 'fix' : request.unblocks ? 'unblocks' : null;
  const evidence = { cap, count: items.length, items, pending_starts: reservations.map(j => ({ item: j.item, journal: j.journal })),
    exceptions: { cap: UNLANDED_EXCEPTION_CAP, count: exceptions.length, runs: exceptions },
    admission: { kind, from_run: request.fromRun ?? null, unblocks: request.unblocks ?? null } };
  if (!kind || (kind !== 'regular' && exceptions.length >= UNLANDED_EXCEPTION_CAP)) {
    const list = items.map(i => i.item).join(', ');
    const active = exceptions.map(e => e.run ?? `pending start for ${e.item} (${e.journal})`).join(', ') || 'none';
    const reason = !kind ? 'Only a fix round with --from-run or a landing follow-up with --unblocks ITEM can proceed.'
      : `All ${UNLANDED_EXCEPTION_CAP} active fix/follow-up slots are occupied (${active}); finish one of those runs first.`;
    const pending = reservations.length ? ` Pending record starts (${reservations.map(j => `${j.item}: ${j.journal}`).join(', ')}) retain capacity; inspect and retry their saved requests after the writers finish.` : '';
    const error = refusal('DISPATCH_UNLANDED_CAP', `unlanded count ${items.length}, cap ${cap}: ${list}. ${reason} Finish a listed landing or explicitly drop the work before starting more items.${pending}`);
    error.unlanded = evidence;
    throw error;
  }
  return evidence;
}
