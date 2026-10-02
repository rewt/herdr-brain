#!/usr/bin/env node
// Foreground glue. No model, timer, event-log writes or new scheduler.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from '../lib/store.mjs';
import { acquireLock } from '../lanes/promotion-lock.mjs';
import { coldStart, renderColdStart, briefSize, receiptDirectory } from './context.mjs';

const SELF = fileURLToPath(import.meta.url);
const local = (name) => fileURLToPath(new URL(name, import.meta.url));
export function noticeRun(notice) {
  if (typeof notice !== 'string' || !notice.startsWith('[org-report] ')) return null;
  // Only the fixed prefix is routing data. Headline/report text is never argv.
  const match = /^\[org-report\] run=(R-\d+) item=\S+ outcome=(done|blocked|needs_human|failed) headline=/.exec(notice);
  if (!match) throw new Error('malformed final report notice');
  return match[1];
}
export function main(argv = process.argv.slice(2)) {
  const { values: opt, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    repo: { type: 'string', default: process.cwd() }, org: { type: 'string' }, role: { type: 'string' },
    json: { type: 'boolean' }, 'since-seq': { type: 'string' }, through: { type: 'string' },
    notice: { type: 'string' }, why: { type: 'string' }, to: { type: 'string' }, brief: { type: 'string' },
    'review-route': { type: 'string' }, 'fix-route': { type: 'string' }, timeout: { type: 'string' },
    retry: { type: 'boolean' }, 'review-again': { type: 'boolean' },
    'settle-cli': { type: 'string' }, 'promote-cli': { type: 'string' },
  } });
  const [action = 'brief', requested] = positionals;
  if (positionals.length > 2 || !['brief', 'checkpoint', 'handle', 'promote'].includes(action)) throw new Error('usage: supervisor.mjs brief [--json] | checkpoint --through N | handle --notice TEXT | promote R-n --why TEXT; mutations require --role supervisor');
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
  const call = (file, args) => {
    const r = spawnSync(process.execPath, [file, ...args], { cwd: project.canonical, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (r.error || r.status !== 0) {
      if (r.stdout) process.stdout.write(r.stdout);
      throw new Error(`${path.basename(file)}: ${r.stderr || r.error?.message || `exit ${r.status}`}`);
    }
    return r.stdout;
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
      const queue = JSON.parse(fs.readFileSync(doc.promotion_queue, 'utf8'));
      if (queue.identity !== project.identity) throw new Error('promotion queue identity changed');
      const result = queue.results.find((r) => r.id === promotionNotice[1]) ?? (queue.current?.id === promotionNotice[1] && queue.current.phase === 'completed' ? { ...queue.current, ...queue.current.result } : null);
      if (!result) throw new Error('promotion notice has no completed queue receipt; inspect queue evidence');
      const receipts = fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => /^R-\d+\.json$/.test(name)).map((name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))) : [];
      const saved = receipts.find((r) => r.queue?.jobs?.some((j) => j.id === result.id));
      if (!saved || saved.identity !== project.identity || saved.org !== project.org || saved.phase !== 'acknowledged' || saved.lane !== result.topic) throw new Error('promotion outcome is not bound to an acknowledged supervisor request; inspect evidence');
      if (result.outcome !== 'promoted') { print({ result: 'judge_promotion', run: saved.run, promotion: result }); return; }
      const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', result.tip, 'HEAD'], { cwd: project.canonical, encoding: 'utf8' });
      if (ancestry.error || ancestry.status !== 0) throw new Error('promoted tip is not integrated in the canonical checkout; inspect evidence');
      const run = JSON.parse(call(local('../bin/org.mjs'), ['show', saved.run, '--json']));
      call(local('../bin/org.mjs'), ['close', run.item, '--if-current-run', saved.run, '--note', `Promoted locally at ${result.tip}; queue ${result.id}; reviewed ${saved.reviewed_commit}. Authority: ${saved.why}`]);
      print({ result: 'recorded_promotion', run: saved.run, item: run.item, promotion: result }); return;
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
    for (const name of ['to', 'brief', 'review-route', 'fix-route', 'timeout']) if (opt[name] !== undefined) settleArgs.push(`--${name}`, opt[name]);
    for (const name of ['retry', 'review-again']) if (opt[name]) settleArgs.push(`--${name}`);
    const result = JSON.parse(call(settle, settleArgs));
    print({ ...result, next: result.result === 'promotable' ? 'judge project authority, then supervisor promote RUN --why REASON' : result.result === 'fix_round' ? 'leave watched correction in flight' : 'judge compact handoff' });
    return;
  }
  if (!opt.why?.trim()) throw new Error('promotion requires --why naming current authority and readiness evidence');
  const release = acquireLock(path.join(directory, `${id}.lock`));
  const file = path.join(directory, `${id}.json`);
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.identity !== project.identity || saved.org !== project.org || saved.run !== id) throw new Error('promotion receipt identity changed');
      if (saved.phase !== 'acknowledged') throw new Error(`promotion enqueue is uncertain; inspect ${file} and ${doc.promotion_queue}; do not blindly enqueue again`);
      print(saved); return;
    }
    // Settle rechecks report hash, record, exact heads, clean trees and readiness.
    const settledFile = path.join(project.org, 'settle', `${id}.json`);
    const settled = fs.existsSync(settledFile) ? JSON.parse(fs.readFileSync(settledFile, 'utf8')) : null;
    if (settled?.common !== project.identity || settled.stage !== 'complete' || settled.result?.result !== 'promotable') throw new Error('handle the final report first; promotion requires saved promotable settlement evidence');
    const result = JSON.parse(call(settle, settleArgs));
    if (result.result !== 'promotable' || result.run !== id) { print({ ...result, next: 'judge compact handoff; nothing queued' }); return; }
    if (fs.existsSync(path.join(project.canonical, '.lane/supervisor/STOP'))) throw new Error('STOP appeared during readiness checks; nothing queued');
    const saved = { identity: project.identity, org: project.org, run: id, lane: result.lane,
      reviewed_commit: result.reviewed_commit, head: result.head, why: opt.why.trim(), phase: 'enqueuing' };
    writeFileAtomic(file, JSON.stringify(saved, null, 2) + '\n');
    call(local('../bin/org.mjs'), ['note', id, `Queue promotion of ${result.lane} at ${result.head}: ${saved.why}. Reviewed ${result.reviewed_commit}; evidence ${result.journal}`, '--decision', '--summary', `Promotion authorized: ${saved.why}`]);
    const promote = opt['promote-cli'] ? path.resolve(opt['promote-cli']) : local('../promote/promote.mjs');
    saved.queue = JSON.parse(call(promote, [result.lane, '--repo', project.canonical, '--org', project.org, ...(opt.to ? ['--to', opt.to] : [])]));
    saved.phase = 'acknowledged';
    writeFileAtomic(file, JSON.stringify(saved, null, 2) + '\n'); print(saved);
  } finally { release(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try { main(); } catch (e) { process.stderr.write(`supervisor: ${e.message}\n`); process.exitCode = 1; }
}
