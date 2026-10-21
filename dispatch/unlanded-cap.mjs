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

export function countUnlanded({ events, common, projectIdentity = cwd => gitProject(cwd).identity }) {
  common = canonical(common);
  const state = fold(events), starts = new Map(), projects = new Map(), workspaces = new Map();
  // Event order, not clocks or numeric IDs, orders attempts. Keep the original
  // start metadata: a later display metadata edit cannot create an exception.
  for (const [order, event] of events.entries()) {
    if (event.type !== 'run.started') continue;
    const run = state.runs.get(event.id);
    const belongs = () => {
      if (event.meta?.dispatch_project) return canonical(event.meta.dispatch_project) === common;
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
  for (const event of events) {
    if (event.type !== 'promotion.reconciled' || !event.identity || canonical(event.identity) !== common) continue;
    for (const head of event.heads ?? []) {
      const start = starts.get(head.run);
      if (start?.run.item === head.item && event.items?.includes(head.item) && event.runs?.includes(head.run)) {
        landed.set(head.item, Math.max(landed.get(head.item) ?? -1, start.order));
      }
    }
  }
  const items = [];
  for (const [id, runs] of projects) {
    const item = state.items.get(id), latest = runs.at(-1);
    if (item?.closed?.as === 'dropped' || latest.order <= (landed.get(id) ?? -1)) continue;
    items.push({ item: id, title: item?.title ?? id, runs: runs.map(s => s.run.id), latest: latest.run.id });
  }
  const exceptions = [...starts.values()].filter(s => ['fix', 'unblocks'].includes(s.meta.dispatch_unlanded_exception) &&
    !s.run.report && !s.run.abandoned).map(s => ({ run: s.run.id, item: s.run.item, kind: s.meta.dispatch_unlanded_exception }));
  return { state, starts, items, exceptions };
}

export function checkUnlandedCap({ config, org, events = loadEvents(org).events, request, requireLink = false, ...options }) {
  const cap = config.dispatch?.max_unlanded === undefined ? DEFAULT_UNLANDED_CAP : config.dispatch.max_unlanded;
  if (!Number.isSafeInteger(cap) || cap < 1) throw Error('dispatch.max_unlanded must be a positive integer');
  const { state, starts, items, exceptions } = countUnlanded({ events, ...options });
  if (request.fromRun) {
    const origin = starts.get(request.fromRun);
    if (!origin || origin.run.item !== request.item) {
      throw refusal('FROM_RUN_OTHER_ITEM', '--from-run must name a run on the dispatched item in this project');
    }
  }
  if (request.unblocks != null) {
    if (request.unblocks === request.item || !items.some(i => i.item === request.unblocks)) {
      throw refusal('DISPATCH_UNBLOCKS_INVALID', `--unblocks must name another unlanded item in this project; ${request.unblocks} is not a pending landing`);
    }
    if (requireLink && !state.links.some(l => l.blocker === request.item && l.blocked === request.unblocks)) {
      throw refusal('DISPATCH_UNBLOCKS_INVALID', `recorded landing link missing: ${request.item} must block ${request.unblocks}`);
    }
  }
  const kind = items.length < cap ? 'regular' : request.fromRun ? 'fix' : request.unblocks ? 'unblocks' : null;
  const evidence = { cap, count: items.length, items,
    exceptions: { cap: UNLANDED_EXCEPTION_CAP, count: exceptions.length, runs: exceptions },
    admission: { kind, from_run: request.fromRun ?? null, unblocks: request.unblocks ?? null } };
  if (!kind || (kind !== 'regular' && exceptions.length >= UNLANDED_EXCEPTION_CAP)) {
    const list = items.map(i => i.item).join(', ');
    const active = exceptions.map(e => e.run).join(', ') || 'none';
    const reason = !kind ? 'Only a fix round with --from-run or a landing follow-up with --unblocks ITEM can proceed.'
      : `All ${UNLANDED_EXCEPTION_CAP} active fix/follow-up slots are occupied (${active}); finish one of those runs first.`;
    const error = refusal('DISPATCH_UNLANDED_CAP', `unlanded count ${items.length}, cap ${cap}: ${list}. ${reason} Finish a listed landing or explicitly drop the work before starting more items.`);
    error.unlanded = evidence;
    throw error;
  }
  return evidence;
}
