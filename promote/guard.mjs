// Execution-time checks shared by queued and direct lane promotion. Call only
// under the Git promotion lock; the final record check holds its lock across FF.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadEvents, withLock } from '../lib/store.mjs';
import { fold, laterRuns, openRuns, blockersOf, releases, itemStatus } from '../lib/state.mjs';

export function withPromotionGuard({ canonical, identity, workspace, topic, expectedHead, run, org }, operation = () => {}, recordLocked = false) {
  const checkGit = () => {
    if (fs.existsSync(path.join(canonical, '.lane/supervisor/STOP'))) throw new Error('supervisor STOP exists; nothing merged');
    if (expectedHead !== undefined) {
      const actual = execFileSync('git', ['-C', workspace, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      if (actual !== expectedHead) throw new Error(`lane tip differs from expected head: expected ${expectedHead}, found ${actual}; settle and authorize the new head; nothing merged`);
    }
  };
  checkGit();
  if (run === undefined) return operation();
  const check = () => {
    const { events, tornTail } = loadEvents(org);
    if (tornTail) throw new Error('incomplete record event; nothing merged');
    const state = fold(events), current = state.runs.get(run), item = state.items.get(current?.item);
    if (!current || !item) throw new Error(`unknown promotion run ${run}; nothing merged`);
    if (current.abandoned || current.report?.outcome !== 'done') throw new Error(`${run} requires a recorded done report; nothing merged`);
    if (laterRuns(state, run).length) throw new Error(`${run} is superseded; nothing merged`);
    if (!current.workspace || fs.realpathSync(current.workspace) !== fs.realpathSync(workspace) || (current.meta.lane && current.meta.lane !== topic)) throw new Error(`${run} does not belong to this lane workspace; nothing merged`);
    const common = execFileSync('git', ['-C', current.workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    if (fs.realpathSync(common) !== identity) throw new Error(`${run} Git identity changed; nothing merged`);
    if (item.outcome && item.outcome.run !== run) throw new Error(`current outcome does not belong to ${run}; nothing merged`);
    const blocked = blockersOf(state, item.id).some((id) => !releases(state, id, itemStatus(state, id)));
    const overlapping = [...state.runs.values()].some((r) => {
      if (r.id === run || r.report || r.abandoned || !r.workspace) return false;
      try { return fs.realpathSync(r.workspace) === fs.realpathSync(workspace); } catch { return r.workspace === current.workspace; }
    });
    if (item.closed || blocked || overlapping || openRuns(state, item.id).length || ['blocked', 'needs_human', 'dropped'].includes(itemStatus(state, item.id))) throw new Error(`${run} record readiness changed: work, closure, blockers or outcome; nothing merged`);
    checkGit();
    return operation();
  };
  return recordLocked ? check() : withLock(org, check);
}

// Hold each distinct record once across the batch FF. Re-entering a record's
// lock per lane would deadlock when several runs belong to the same project.
export function withPromotionGuards(lanes, operation = () => {}) {
  const records = [...new Set(lanes.filter(l => l.run !== undefined).map(l => l.org))].sort();
  const lock = index => index < records.length ? withLock(records[index], () => lock(index + 1)) : check(0);
  const check = index => index < lanes.length ? withPromotionGuard(lanes[index], () => check(index + 1), true) : operation();
  return lock(0);
}
