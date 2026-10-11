#!/usr/bin/env node
// Foreground glue. No model, timer, event-log writes or new scheduler.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, isMain } from '../lib/cli-help.mjs';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../lib/store.mjs';
import { enterSupervisor } from './entry.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { coldStart, renderColdStart, briefSize, receiptDirectory } from './context.mjs';
import { queueJobs } from '../promote/promote.mjs';
import { verifyTrainResult } from '../promote/train.mjs';
import { recordedBatchCompletion } from '../promote/completion.mjs';
import { TEST_ESCALATION } from '../settle/test-evidence.mjs';
import { supervisorStatus, renderStatus } from './status.mjs';

const local = (name) => fileURLToPath(new URL(name, import.meta.url));
export function noticeRun(notice) {
  if (typeof notice !== 'string' || !notice.startsWith('[org-report] ')) return null;
  // Only the fixed prefix is routing data. Headline/report text is never argv.
  const match = /^\[org-report\] run=(R-\d+) item=\S+ outcome=(done|blocked|needs_human|failed) headline=/.exec(notice);
  if (!match) throw new Error('malformed final report notice');
  return match[1];
}
const attempts = (receipt) => [receipt, ...(receipt.prior_attempts ?? [])];
const completedJob = (queue, id) => {
  const job = queueJobs(queue).find(r => r.id === id && (r.outcome || r.phase === 'completed'));
  return job ? { ...job, ...job.result } : null;
};
const jobAttempt = (receipt, id) => attempts(receipt).find((a) => a.queue?.jobs?.some((j) => j.id === id));
export function main(argv = process.argv.slice(2)) {
  const { values: opt, positionals } = parseArgs({ usage: "Usage: node supervisor/supervisor.mjs brief|status|entry|checkpoint|handle|promote|release [OPTIONS]", args: argv, allowPositionals: true, options: {
    repo: { type: 'string', default: process.cwd() }, org: { type: 'string' }, role: { type: 'string' },
    json: { type: 'boolean' }, 'since-seq': { type: 'string' }, through: { type: 'string' },
    notice: { type: 'string' }, why: { type: 'string' }, to: { type: 'string', default: process.env.MONITOR_SUPERVISOR_AGENT || undefined }, brief: { type: 'string' },
    'review-route': { type: 'string' }, 'fix-route': { type: 'string' }, timeout: { type: 'string' },
    retry: { type: 'boolean' }, 'review-again': { type: 'boolean' },
    'review-round-cap': { type: 'string' }, 'fix-findings': { type: 'boolean' }, 'accept-findings': { type: 'boolean' },
    'settle-cli': { type: 'string' }, 'promote-cli': { type: 'string' },
  } });
  const [action = 'brief', requested] = positionals;
  if (opt['accept-findings'] && action !== 'promote') throw new Error('--accept-findings is a promotion decision');
  if ((opt['fix-findings'] || opt['review-round-cap'] !== undefined) && action !== 'handle') throw new Error('--fix-findings and --review-round-cap belong to handle');
  if (positionals.length > 2 || !['brief', 'status', 'entry', 'checkpoint', 'handle', 'promote', 'release'].includes(action)) throw new Error('usage: supervisor.mjs brief|status [--json] | entry --role supervisor | checkpoint --through N | handle --notice TEXT | promote R-n --why TEXT | release; mutations require --role supervisor');
  if (action === 'status') {
    const status = supervisorStatus({ cwd: opt.repo, org: opt.org });
    process.stdout.write(opt.json ? JSON.stringify(status) + '\n' : renderStatus(status)); return;
  }
  if (action === 'entry') { enterSupervisor({ cwd: opt.repo, org: opt.org, role: opt.role, to: opt.to }); return; }
  const doc = coldStart({ cwd: opt.repo, org: opt.org, sinceSeq: opt['since-seq'] === undefined ? undefined : Number(opt['since-seq']) });
  const project = doc.project;
  const print = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  if (action === 'brief') {
    const brief = renderColdStart(doc);
    if (opt.json) print({ ...doc, size: briefSize(brief) });
    else { process.stdout.write(brief); process.stderr.write(`brief: ${briefSize(brief).characters} chars ≈ ${briefSize(brief).approximate_tokens} tokens\n`); }
    return;
  }
  if (opt.role !== 'supervisor' || project.checkout !== project.canonical) throw new Error('cycle mutations require --role supervisor from the canonical checkout; workers receive no supervisor actions');
  if (project.stopped || project.torn_tail) throw new Error('STOP or incomplete record event: inspect before cycle mutations');
  const directory = receiptDirectory(project.org, project.identity);
  const env = { ...process.env, ORG_DIR: project.org, ORG_ACTOR: process.env.ORG_ACTOR || 'supervisor' };
  const call = (file, args, options = {}) => {
    const r = spawnSync(process.execPath, [file, ...args], { cwd: project.canonical, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
    if (r.error || r.status !== 0) {
      if (r.stdout) process.stdout.write(r.stdout);
      throw new Error(`${path.basename(file)}: ${r.stderr || r.error?.message || `exit ${r.status}`}`);
    }
    return r.stdout;
  };
  if (action === 'release') {
    if (requested) throw new Error('release takes no run ID');
    print(JSON.parse(call(local('../release/release.mjs'), ['--once', '--repo', project.canonical, '--org', project.org, '--role', 'supervisor'])));
    return;
  }
  const loadQueue = () => {
    const queue = JSON.parse(fs.readFileSync(doc.promotion_queue, 'utf8'));
    if (queue.identity !== project.identity) throw new Error('promotion queue identity changed');
    return queue;
  };
  const handlePromotion = (receipt, result) => {
    const saved = receipt && jobAttempt(receipt, result.id);
    if (!saved || saved.identity !== project.identity || saved.org !== project.org || saved.phase !== 'acknowledged' || saved.lane !== result.topic) throw new Error('promotion outcome is not bound to an acknowledged supervisor request; inspect evidence');
    if (result.run !== saved.run || result.expectedHead !== saved.head || result.org !== saved.org) throw new Error('promotion queue head or run binding differs from supervisor request; inspect evidence');
    if (result.reconciliation?.state === 'pending') throw new Error('integrated; whole-batch reconciliation pending; retain lanes and retry bookkeeping');
    if (result.outcome !== 'promoted') return { result: 'judge_promotion', run: saved.run, promotion: result };
    if (result.tip !== saved.head && !verifyTrainResult(result, { project, saved })) throw new Error('promoted tip differs from authorized head without proved train replay; inspect evidence');
    const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', result.tip, 'HEAD'], { cwd: project.canonical, encoding: 'utf8' });
    if (ancestry.error || ancestry.status !== 0) throw new Error('promoted tip is not integrated in the canonical checkout; inspect evidence');
    const run = JSON.parse(call(local('../bin/org.mjs'), ['show', saved.run, '--json']));
    if (result.reconciliation) {
      if (!recordedBatchCompletion({ result, project, run })) throw new Error('whole-batch record completion proof is missing or changed');
      const item = JSON.parse(call(local('../bin/org.mjs'), ['show', run.item, '--json']));
      if (item.runs.at(-1) !== run.id) throw new Error(`${run.id} is superseded after completion`);
      if (!item.closed) throw new Error('item reopened after completion');
      return { result: 'recorded_promotion', run: saved.run, item: run.item, promotion: result };
    }
    call(local('../bin/org.mjs'), ['close', run.item, '--if-current-run', saved.run, '--note', `Promoted locally at ${result.tip}; queue ${result.id}; reviewed ${saved.reviewed_commit}. Authority: ${saved.why}`]);
    return { result: 'recorded_promotion', run: saved.run, item: run.item, promotion: result };
  };
  if (action === 'checkpoint') {
    const through = Number(opt.through);
    if (opt.through === undefined || !Number.isInteger(through) || through < 0 || through > project.through) throw new Error('--through must name a sequence from the brief');
    const release = acquireLock(path.join(directory, 'cursor.lock'));
    try {
      const file = path.join(directory, 'cursor.json');
      const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      if (previous && (previous.identity !== project.identity || previous.org !== project.org)) throw new Error('cursor identity changed');
      const cursor = { identity: project.identity, org: project.org, through: Math.max(through, previous?.through ?? 0) };
      writeFileAtomic(file, JSON.stringify(cursor) + '\n'); print(cursor);
    } finally { release(); }
    return;
  }
  let id = requested;
  if (action === 'handle' && opt.notice !== undefined) {
    const promotionNotice = /^\[promote-queue\] id=([a-zA-Z0-9-]+) lane=/.exec(opt.notice);
    if (promotionNotice) {
      const queue = loadQueue();
      const result = completedJob(queue, promotionNotice[1]);
      if (!result) throw new Error('promotion notice has no completed queue receipt; inspect queue evidence');
      const receipts = fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => /^R-\d+\.json$/.test(name)).map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))) : [];
      const receipt = receipts.find((r) => jobAttempt(r, result.id));
      print(handlePromotion(receipt, result)); return;
    }
    const fromNotice = noticeRun(opt.notice);
    if (!fromNotice) { print({ result: 'inspect_notice', reason: 'intermediate watch or promotion notice; no settlement launched', notice: opt.notice }); return; }
    if (id && id !== fromNotice) throw new Error('notice run differs from requested run');
    id = fromNotice;
  }
  if (!/^R-\d+$/.test(id ?? '')) throw new Error('a run ID or final report notice is required');
  const settle = opt['settle-cli'] ? path.resolve(opt['settle-cli']) : local('../settle/settle.mjs');
  const settleArgs = [id, '--repo', project.canonical, '--org', project.org];
  if (action === 'handle') {
    // Promotion may have removed the checkout before a delayed report notice.
    // Recover from both receipts, using the same guards as the queue notice.
    const file = path.join(directory, `${id}.json`);
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.identity !== project.identity || saved.org !== project.org || saved.run !== id) throw new Error('promotion receipt identity changed');
      if (saved.phase === 'acknowledged' && saved.queue?.jobs?.length === 1) {
        const promotion = completedJob(loadQueue(), saved.queue.jobs[0].id);
        if (promotion?.outcome === 'promoted') { print(handlePromotion(saved, promotion)); return; }
      }
    }
    // An original run has no promotion request when its correction was the
    // run integrated. A missing checkout cannot be settled again; report only
    // supersession proven by the record, without claiming or closing promotion.
    const run = JSON.parse(call(local('../bin/org.mjs'), ['show', id, '--json']));
    if (run.workspace && !fs.existsSync(run.workspace)) {
      const item = JSON.parse(call(local('../bin/org.mjs'), ['show', run.item, '--json']));
      const current = item.runs.at(-1);
      if (current && current !== id) {
        print({ result: 'superseded', run: id, item: run.item, current_run: current,
          reason: 'A newer run exists and the original checkout is gone; nothing settled or closed',
          next: 'inspect the current run and its settlement or promotion receipts' }); return;
      }
    }
    for (const name of ['to', 'brief', 'review-route', 'fix-route', 'timeout', 'review-round-cap']) if (opt[name] !== undefined) settleArgs.push(`--${name}`, opt[name]);
    for (const name of ['retry', 'review-again', 'fix-findings']) if (opt[name]) settleArgs.push(`--${name}`);
    const result = JSON.parse(call(settle, settleArgs, { stdio: ['ignore', 'pipe', 'inherit'] }));
    print({ ...result, next: result.result === 'promotable_with_findings' ? 'judge findings and file follow-ups; promote RUN --accept-findings --why REASON, or handle RUN --retry --fix-findings' : result.result === 'promotable' ? 'judge project authority, then supervisor promote RUN --why REASON' : result.result === 'fix_round' ? 'leave watched correction in flight' : result.result === 'stopped' ? 'inspect retained handoff; after STOP is cleared, handle RUN --retry' : 'judge compact handoff' });
    return;
  }
  if (!opt.why?.trim()) throw new Error('promotion requires --why naming current authority and readiness evidence');
  const release = acquireLock(path.join(directory, `${id}.lock`));
  const file = path.join(directory, `${id}.json`);
  try {
    let prior;
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.identity !== project.identity || saved.org !== project.org || saved.run !== id) throw new Error('promotion receipt identity changed');
      if (saved.phase !== 'acknowledged') throw new Error(`promotion enqueue is uncertain; inspect ${file} and ${doc.promotion_queue}; do not blindly enqueue again`);
      if (!opt.retry) { print(saved); return; }
      const jobs = saved.queue?.jobs;
      if (jobs?.length !== 1) throw new Error('retry requires one acknowledged queue job; inspect evidence');
      const outcome = completedJob(loadQueue(), jobs[0].id);
      if (!outcome) throw new Error('retry requires a confirmed refused queue job; pending or uncertain attempts need inspection');
      if (outcome.outcome === 'promoted') { print(saved); return; }
      if (!['refused', 'timeout'].includes(outcome.outcome) || outcome.topic !== saved.lane || outcome.run !== saved.run || outcome.expectedHead !== saved.head || outcome.org !== saved.org) throw new Error('retry requires a confirmed refused queue job with the same binding; inspect evidence');
      const { prior_attempts, ...attempt } = saved;
      prior = [...(prior_attempts ?? []), { ...attempt, result: outcome }];
    }
    else if (opt.retry) throw new Error('no acknowledged promotion attempt to retry');
    // Settle rechecks report hash, record, exact heads, clean trees and readiness.
    const settledFile = path.join(project.org, 'settle', `${id}.json`);
    const settled = fs.existsSync(settledFile) ? JSON.parse(fs.readFileSync(settledFile, 'utf8')) : null;
    const testEscalation = settled?.result?.result === 'escalate' && settled.result.reason === TEST_ESCALATION && settled.review?.verdict === 'PASS';
    if (settled?.common !== project.identity || settled.stage !== 'complete' || (!testEscalation && !['promotable', 'promotable_with_findings'].includes(settled.result?.result))) throw new Error('handle the final report first; promotion requires saved promotable settlement evidence');
    if (settled.result.result === 'promotable_with_findings' && !opt['accept-findings']) throw new Error('capped findings require --accept-findings and --why before promotion');
    if (testEscalation) settleArgs.push('--retry', '--resolve-tests');
    const result = JSON.parse(call(settle, settleArgs));
    if (!['promotable', 'promotable_with_findings'].includes(result.result) || result.run !== id) { print({ ...result, next: 'judge compact handoff; nothing queued' }); return; }
    if (fs.existsSync(path.join(project.canonical, '.lane/supervisor/STOP'))) throw new Error('STOP appeared during readiness checks; nothing queued');
    const saved = { identity: project.identity, org: project.org, run: id, lane: result.lane,
      reviewed_commit: result.reviewed_commit, head: result.head,
      ...(result.test_evidence ? { test_evidence: result.test_evidence } : {}), why: opt.why.trim(), phase: 'enqueuing',
      ...(result.result === 'promotable_with_findings' ? { accepted_findings: result.findings, review_policy: result.review_policy } : {}),
      ...(prior ? { prior_attempts: prior } : {}) };
    writeFileAtomic(file, JSON.stringify(saved, null, 2) + '\n');
    call(local('../bin/org.mjs'), ['note', id, `Queue promotion of ${result.lane} at ${result.head}: ${saved.why}. Reviewed ${result.reviewed_commit}; evidence ${result.journal}${saved.accepted_findings !== undefined ? `. Accepted capped findings (policy ${JSON.stringify(saved.review_policy)}): ${saved.accepted_findings}` : ''}`, '--decision', '--summary', `Promotion authorized: ${saved.why}`]);
    const promote = opt['promote-cli'] ? path.resolve(opt['promote-cli']) : local('../promote/promote.mjs');
    saved.queue = JSON.parse(call(promote, [result.lane, '--repo', project.canonical, '--org', project.org,
      '--expected-head', result.head, '--if-current-run', id,
      ...(result.test_evidence && !result.test_evidence.reexecuted ? ['--required-tests', JSON.stringify(result.test_evidence.files)] : []), ...(opt.to ? ['--to', opt.to] : [])]));
    saved.phase = 'acknowledged';
    writeFileAtomic(file, JSON.stringify(saved, null, 2) + '\n'); print(saved);
  } finally { release(); }
}
if (isMain(import.meta.url)) {
  try { main(); } catch (e) { process.stderr.write(`supervisor: ${e.message}\n`); process.exitCode = 1; }
}
