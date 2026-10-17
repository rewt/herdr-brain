// Execution-time checks shared by queued and direct lane promotion. Call only
// under the Git promotion lock; the final record check holds its lock across FF.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { roleIs } from '../lib/roles.mjs';
import { readConfig as housekeepingConfig } from '../housekeeping/config.mjs';
import { cleanPassScope } from '../supervisor/clean-pass.mjs';
import { execFileSync } from 'node:child_process';
import { loadEvents, withLock } from '../lib/store.mjs';
import { completionFingerprint } from '../lib/completion.mjs';
import { fold, children, laterRuns, openRuns, blockersOf, releases, itemStatus, reviewsWithoutPass, openQuestionsFor } from '../lib/state.mjs';

export function withPromotionGuard({ canonical, identity, workspace, topic, expectedHead, run, org, completionExpected, existingWorker = false, superseded = [] }, operation = () => {}, recordLocked = false) {
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
    if (item.kind !== 'work' || item.role === 'human' || item.meta.operator_reserved) throw new Error(`${run} is not ordinary authorized work; nothing merged`);
    if (completionExpected !== undefined && completionFingerprint(state, item.id) !== completionExpected) throw new Error(`${run} changed since batch preparation; nothing merged`);
    if (superseded.some(id => { const old = state.runs.get(id); return !old || old.item !== item.id || old.started.seq >= current.started.seq || old.report || old.abandoned; })) throw new Error('invalid superseded runs; nothing merged');
    if (current.abandoned || current.report?.outcome !== 'done') throw new Error(`${run} requires a recorded done report; nothing merged`);
    if (laterRuns(state, run).length) throw new Error(`${run} is superseded; nothing merged`);
    if (!current.workspace || fs.realpathSync(current.workspace) !== fs.realpathSync(workspace) || (current.meta.lane && current.meta.lane !== topic)) throw new Error(`${run} does not belong to this lane workspace; nothing merged`);
    const common = execFileSync('git', ['-C', current.workspace, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    if (fs.realpathSync(common) !== identity) throw new Error(`${run} Git identity changed; nothing merged`);
    if (item.outcome && item.outcome.run !== run) throw new Error(`current outcome does not belong to ${run}; nothing merged`);
    // An open operator question on this work or its blocking review waits for its answer.
    const [question] = openQuestionsFor(state, item.id);
    if (question) throw new Error(`${run} has an open operator question ${question.id}; nothing merged`);
    // Batch completion relies on this: its fingerprint already covers every blocker item.
    const unpassed = reviewsWithoutPass(state, item.id);
    if (unpassed.length) throw new Error(`${run} review ${unpassed.join(', ')} has no recorded PASS verdict; record one or drop the review; nothing merged`);
    const unfinished = children(state, item.id).filter(child => roleIs(child, 'ENG') && !child.closed);
    if (unfinished.length) throw new Error(`${run} has open engineer children ${unfinished.map(child => child.id).join(', ')}; nothing merged`);
    const blocked = blockersOf(state, item.id).some((id) => !releases(state, id, itemStatus(state, id, new Set(), item.id)));
    const overlapping = [...state.runs.values()].some((r) => {
      if (r.id === run || superseded.includes(r.id) || r.report || r.abandoned || !r.workspace) return false;
      try { return fs.realpathSync(r.workspace) === fs.realpathSync(workspace); } catch { return r.workspace === current.workspace; }
    });
    if (item.closed || blocked || overlapping || openRuns(state, item.id).some(r => !superseded.includes(r.id)) || ['blocked', 'needs_human', 'dropped'].includes(itemStatus(state, item.id))) throw new Error(`${run} record readiness changed: work, closure, blockers or outcome; nothing merged`);
    if (existingWorker) {
      const settings = JSON.parse(fs.readFileSync(path.join(canonical, '.supervisor.json'), 'utf8'))?.autopilot;
      if (settings?.enabled !== true || settings.cohort !== 'clean-pass') throw Error('AUTOPILOT_DISABLED: pilot disabled before integration; nothing merged');
      if (!housekeepingConfig(path.join(canonical, '.housekeeping.json')).enabled) throw Error('AUTOPILOT_PAUSED: housekeeping paused before integration; nothing merged');
      const settled = JSON.parse(fs.readFileSync(path.join(org, 'settle', `${run}.json`), 'utf8'));
      const review = settled.review;
      const clean = review?.text?.match(/## Findings\n([\s\S]*?)(?=\n## )/)?.[1]?.trim();
      if (settled.common !== identity || settled.org !== org || settled.run !== run || settled.stage !== 'complete' ||
          settled.result?.result !== 'promotable' || settled.result.head !== expectedHead || settled.finalHead !== expectedHead ||
          settled.result.reviewed_commit !== settled.head || review?.verdict !== 'PASS' || clean !== 'None' ||
          review.sha256 !== createHash('sha256').update(review.text).digest('hex') || settled.result.review?.sha256 !== review.sha256)
        throw Error('AUTOPILOT_PASS_STALE: current clean PASS or head changed; nothing merged');
      const scope = cleanPassScope({ repo: canonical, workspace, base: settled.mainHead, head: expectedHead, review });
      if (!scope.eligible) throw Error(`${scope.code}: ${scope.reason}; nothing merged`);
    }
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
